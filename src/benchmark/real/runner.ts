import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrismaClient } from "@prisma/client";
import { getPrismaClient } from "../../db/client.js";
import { getCurrentCommit, isClean, pruneWorktrees, removeWorktree, runGit } from "../../git/index.js";
import { aggregateUsage, ProviderUsageSchema, type ProviderUsage } from "../../workers/usage.js";
import { BenchmarkError } from "../errors.js";
import type { BenchmarkStrategy } from "../types.js";
import {
  runRealAtlas,
  runRealAtlasEvolving,
  runRealDumbParallel,
  runRealSingleAgent,
  type RealStrategyOutput,
} from "./strategies.js";
import { compareRealRuns } from "./metrics.js";
import {
  RealWorkloadSpecSchema,
  type RealAgentConfig,
  type RealBenchmarkComparison,
  type RealRunResult,
  type RealWorkloadSpec,
} from "./types.js";

export interface RunRealBenchmarkOptions {
  readonly db?: PrismaClient;
  readonly track?: (model: string, id: string) => void;
  readonly strategies?: BenchmarkStrategy[];
  readonly agent: RealAgentConfig;
  /** Repeats per workload/strategy cell. Default 3; tests may use fewer. */
  readonly repeats?: number;
  /** Minimum successful runs before a median is reported. Default 1. */
  readonly minSuccessfulRuns?: number;
  readonly scratchParent?: string;
  /**
   * Seeded arm-order shuffle (M28.9 screening design): when set, the
   * strategy order is reshuffled per repeat with a deterministic PRNG, so
   * arm ordering cannot confound timing. Omit for the historical fixed
   * order (default, backward compatible).
   */
  readonly shuffleSeed?: number;
}

/** Deterministic Fisher-Yates shuffle (mulberry32). Exported for tests. */
export function shuffleStrategies<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let state = seed >>> 0;
  const next = (): number => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    const a = out[i] as T;
    const b = out[j] as T;
    out[i] = b as T;
    out[j] = a as T;
  }
  return out;
}

const DEFAULT_STRATEGIES: BenchmarkStrategy[] = ["SINGLE_AGENT", "DUMB_PARALLEL", "ATLAS"];

async function assertMainPristine(repoDir: string, baseCommit: string, phase: string): Promise<void> {
  const head = await getCurrentCommit(repoDir);
  if (head !== baseCommit) {
    throw new BenchmarkError(`main HEAD moved ${phase}: expected ${baseCommit}, got ${head}`);
  }
  if (!(await isClean(repoDir))) {
    throw new BenchmarkError(`main worktree is not clean ${phase}`);
  }
}

/** Exported for workload-construction tests: materialize base+test files and commit. */
export async function buildRealFixture(
  workload: RealWorkloadSpec,
  dir: string,
): Promise<{ repoDir: string; baseCommit: string }> {
  try {
    for (const file of [...workload.baseFiles, ...workload.testFiles]) {
      const absolute = join(dir, file.path);
      await mkdir(join(absolute, ".."), { recursive: true });
      await writeFile(absolute, file.content);
    }
    await runGit(["init", "-b", "main"], { cwd: dir });
    await runGit(["config", "user.email", "atlas-real-benchmark@example.invalid"], { cwd: dir });
    await runGit(["config", "user.name", "Atlas Real Benchmark"], { cwd: dir });
    await runGit(["add", "-A"], { cwd: dir });
    await runGit(["-c", "commit.gpgsign=false", "commit", "-m", `real benchmark fixture ${workload.id}`], { cwd: dir });
    return { repoDir: dir, baseCommit: await getCurrentCommit(dir) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new BenchmarkError(`fixture setup failed for workload ${workload.id}: ${message}`);
  }
}

/** Raw code statistics from Git itself, per worker branch. Failures yield zeros, never throws. */
async function diffNumstat(
  repoDir: string,
  base: string,
  branch: string,
): Promise<{ files: number; added: number; removed: number }> {
  try {
    const result = await runGit(["diff", "--numstat", base, branch, "--"], { cwd: repoDir });
    let files = 0;
    let added = 0;
    let removed = 0;
    for (const line of result.stdout.split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 3) {
        continue;
      }
      files += 1;
      const add = Number(parts[0]);
      const del = Number(parts[1]);
      if (Number.isInteger(add) && add >= 0) {
        added += add;
      }
      if (Number.isInteger(del) && del >= 0) {
        removed += del;
      }
    }
    return { files, added, removed };
  } catch {
    return { files: 0, added: 0, removed: 0 };
  }
}

async function branchOfWorker(db: PrismaClient, workerId: string): Promise<string | null> {
  const worker = await db.worker.findUnique({ where: { id: workerId }, include: { workspace: true } });
  return worker?.workspace?.branch ?? null;
}

async function cleanupRealRun(db: PrismaClient, repoDir: string, scratchRoot: string, workerIds: string[]): Promise<void> {
  for (const workerId of workerIds) {
    try {
      const worker = await db.worker.findUnique({ where: { id: workerId }, include: { workspace: true } });
      if (worker?.workspace?.path !== undefined && worker.workspace.path !== null) {
        await removeWorktree(repoDir, worker.workspace.path, { force: true });
      }
    } catch {
      // Best effort: workspaces may already be gone on failure paths.
    }
  }
  await rm(scratchRoot, { recursive: true, force: true }).catch(() => undefined);
  await pruneWorktrees(repoDir).catch(() => undefined);
}

async function buildRealRunResult(args: {
  db: PrismaClient;
  workload: RealWorkloadSpec;
  runId: string;
  repeatIndex: number;
  strategy: BenchmarkStrategy;
  agent: RealAgentConfig;
  repoDir: string;
  baseCommit: string;
  startedAt: string;
  wallStart: number;
  outcome: RealStrategyOutput;
  peakConcurrency: number;
  scheduling: RealRunResult["scheduling"];
}): Promise<RealRunResult> {
  const { db, workload, runId, strategy, repoDir, baseCommit, outcome, agent } = args;
  const wallClockMs = Date.now() - args.wallStart;
  const finishedAt = new Date().toISOString();

  let filesTouched = 0;
  let linesAdded = 0;
  let linesRemoved = 0;
  // Per-task changed-file counts double as the anti-free-ride rule below:
  // workspace tests tolerate absent siblings, so a task that changes nothing
  // could otherwise verify vacuously. Success requires real output.
  const changedFilesByKey = new Map<string, number>();
  for (const task of outcome.executed) {
    const branch = await branchOfWorker(db, task.workerId);
    const stats = branch !== null ? await diffNumstat(repoDir, baseCommit, branch) : { files: 0, added: 0, removed: 0 };
    changedFilesByKey.set(task.key, stats.files);
    filesTouched += stats.files;
    linesAdded += stats.added;
    linesRemoved += stats.removed;
  }

  const workerIds = new Set(outcome.executed.map((task) => task.workerId));
  let failures = 0;
  let violations = 0;
  for (const task of outcome.executed) {
    if (task.execution.status !== "COMPLETED") {
      failures += 1;
    }
    if (task.execution.status === "CLAIM_VIOLATION") {
      violations += 1;
    }
  }

  let rework = 0;
  const conflicts: string[] = [];
  if (outcome.integration !== null) {
    for (const item of outcome.integration.items) {
      if (item.status === "CONFLICT" || item.status === "NOT_ATTEMPTED") {
        rework += 1;
      }
      if (item.status === "CONFLICT") {
        const key = outcome.executed.find((task) => task.taskId === item.taskId)?.key ?? item.taskId;
        conflicts.push(key);
      }
    }
  }
  conflicts.sort();

  // SUCCESS iff every intended task completed, verified, produced output,
  // and integrated. The single-agent union task stands in for all intended
  // keys; every other arm must cover each intended key with a non-empty diff.
  const intendedKeys = strategy === "SINGLE_AGENT" ? ["single"] : workload.tasks.map((task) => task.key);
  const byKey = new Map(outcome.executed.map((task) => [task.key, task]));
  const integratedKeys = new Set(
    (outcome.integration?.items ?? []).filter((item) => item.status === "INTEGRATED").map((item) => byKeyInverse(outcome, item.taskId)),
  );
  const success =
    outcome.integration?.status === "COMPLETED" &&
    intendedKeys.every((key) => {
      const task = byKey.get(key);
      return (
        task !== undefined &&
        task.execution.status === "COMPLETED" &&
        task.verification?.verdict === "VERIFIED" &&
        (changedFilesByKey.get(key) ?? 0) > 0 &&
        integratedKeys.has(key)
      );
    });

  const workerMsValues = outcome.executed.map((task) => task.workerMs);
  const workerMsTotal = workerMsValues.every((ms): ms is number => ms !== null)
    ? workerMsValues.reduce((sum, ms) => sum + (ms as number), 0)
    : null;

  // Observed provider usage per task (M28.9): at most one row per task per
  // invocation exists because the runtime records exactly once per parsed
  // provider return; repeated rows merge deterministically by summation.
  // Any task without a well-formed usage row forces null totals (all-or-
  // null) — partial sums are never presented as run totals.
  const taskIds = outcome.executed.map((task) => task.taskId);
  const usageRows =
    taskIds.length === 0
      ? []
      : await db.event.findMany({
          where: { taskId: { in: taskIds }, type: "PROVIDER_USAGE_OBSERVED" },
          select: { taskId: true, payload: true },
          orderBy: [{ id: "asc" }],
        });
  const rowsByTask = new Map<string, ProviderUsage[]>();
  const malformedTasks = new Set<string>();
  for (const row of usageRows) {
    if (row.taskId === null) {
      continue;
    }
    let parsed: { usage?: unknown } | null = null;
    try {
      parsed = JSON.parse(row.payload ?? "") as { usage?: unknown };
    } catch {
      parsed = null;
    }
    const usage = parsed === null ? null : ProviderUsageSchema.safeParse(parsed.usage);
    if (usage === null || !usage.success) {
      // Unknown bytes exist for this task: its contribution is unknowable,
      // so the task contributes null (all-or-null), never a partial sum.
      malformedTasks.add(row.taskId);
      continue;
    }
    const list = rowsByTask.get(row.taskId) ?? [];
    list.push(usage.data);
    rowsByTask.set(row.taskId, list);
  }
  const perTaskUsage = taskIds.map((taskId) => {
    if (malformedTasks.has(taskId)) {
      return null;
    }
    const rows = rowsByTask.get(taskId) ?? [];
    if (rows.length === 0) {
      return null;
    }
    const merged = aggregateUsage(rows);
    if (merged.tokens === null) {
      return null;
    }
    return ProviderUsageSchema.parse({
      tokens: merged.tokens,
      costUsd: merged.costUsd,
      events: rows.reduce((acc, r) => acc + r.events, 0),
      malformed: rows.reduce((acc, r) => acc + r.malformed, 0),
    });
  });
  const aggregated = aggregateUsage(perTaskUsage);
  const usageRecord = {
    tokens: aggregated.tokens === null ? null : { ...aggregated.tokens },
    costUsd: aggregated.costUsd,
  };

  const artifactIds = new Set<string>();
  const testRunIds = new Set<string>();
  const commitShas = new Set<string>();
  for (const task of outcome.executed) {
    for (const row of await db.artifact.findMany({ where: { taskId: task.taskId }, select: { id: true } })) {
      artifactIds.add(row.id);
    }
    for (const row of await db.testRun.findMany({ where: { taskId: task.taskId }, select: { id: true } })) {
      testRunIds.add(row.id);
    }
    for (const row of await db.commit.findMany({ where: { taskId: task.taskId }, select: { sha: true } })) {
      commitShas.add(row.sha);
    }
  }

  return {
    workloadId: workload.id,
    runId,
    repeatIndex: args.repeatIndex,
    strategy,
    startedAt: args.startedAt,
    finishedAt,
    wallClockMs,
    baseCommit,
    agent: {
      provider: agent.provider,
      executable: agent.executable,
      model: agent.model,
      version: agent.version,
      temperature: agent.temperature,
    },
    decomposition: "human-authored",
    tasks: outcome.executed.map((task) => ({
      key: task.key,
      taskId: task.taskId,
      workerId: task.workerId,
      status: task.execution.status,
      workerMs: task.workerMs,
      verification: task.verification?.verdict ?? "NOT_EVALUATED",
      testStatus: task.testRun?.status ?? "NOT_RUN",
    })),
    scheduling: args.scheduling,
    integration:
      outcome.integration === null
        ? null
        : {
            status: outcome.integration.status,
            conflicts,
            items: outcome.integration.items.map((item) => ({
              key: byKeyInverse(outcome, item.taskId),
              status: item.status,
            })),
            order: [...outcome.integrationOrder],
          },
    triageClassifications: [...outcome.triageClassifications],
    waveBases: (outcome as { waveBases?: readonly string[] }).waveBases
      ? [...((outcome as { waveBases?: readonly string[] }).waveBases as readonly string[])]
      : null,
    metrics: {
      peakConcurrency: args.peakConcurrency,
      taskCount: outcome.executed.length,
      workerCount: workerIds.size,
      failures,
      violations,
      rework,
      codeStats: { filesTouched, linesAdded, linesRemoved },
      workerMsTotal,
    },
    // Observed provider usage (M28.9): summed from per-task
    // PROVIDER_USAGE_OBSERVED rows via all-or-null aggregation. Stays null
    // when any task lacks well-formed usage — unknown means unknown.
    usage: usageRecord,
    evidence: {
      artifactIds: [...artifactIds].sort(),
      testRunIds: [...testRunIds].sort(),
      commitShas: [...commitShas].sort(),
      trainBranch: outcome.integration?.trainBranch ?? null,
    },
    success,
  };
}

function byKeyInverse(outcome: RealStrategyOutput, taskId: string): string {
  return outcome.executed.find((task) => task.taskId === taskId)?.key ?? taskId;
}

async function runOneRealStrategy(
  db: PrismaClient,
  workload: RealWorkloadSpec,
  agent: RealAgentConfig,
  repoDir: string,
  baseCommit: string,
  strategy: BenchmarkStrategy,
  runId: string,
  repeatIndex: number,
  scratchRoot: string,
  track: (model: string, id: string) => void,
): Promise<RealRunResult> {
  const ctx = { db, workload, agent, repoDir, baseCommit, runId, scratchRoot, track };
  await assertMainPristine(repoDir, baseCommit, `before ${strategy} repeat ${repeatIndex}`);
  const startedAt = new Date().toISOString();
  const wallStart = Date.now();
  const workerIds: string[] = [];
  try {
    let outcome: RealStrategyOutput;
    let peakConcurrency: number;
    let scheduling: RealRunResult["scheduling"];
    if (strategy === "SINGLE_AGENT") {
      const single = await runRealSingleAgent(ctx);
      outcome = single;
      peakConcurrency = single.peakConcurrency;
      scheduling = null;
    } else if (strategy === "DUMB_PARALLEL") {
      const dumb = await runRealDumbParallel(ctx);
      outcome = dumb;
      peakConcurrency = dumb.peakConcurrency;
      scheduling = null;
    } else if (strategy === "ATLAS_EVOLVING") {
      const evolving = await runRealAtlasEvolving(ctx);
      outcome = evolving;
      peakConcurrency = evolving.peakConcurrency;
      scheduling = evolving.scheduling;
    } else {
      const atlas = await runRealAtlas(ctx);
      outcome = atlas;
      peakConcurrency = atlas.peakConcurrency;
      scheduling = atlas.scheduling;
    }
    for (const task of outcome.executed) {
      workerIds.push(task.workerId);
    }
    const built = await buildRealRunResult({
      db,
      workload,
      runId,
      repeatIndex,
      strategy,
      agent,
      repoDir,
      baseCommit,
      startedAt,
      wallStart,
      outcome,
      peakConcurrency,
      scheduling,
    });
    await assertMainPristine(repoDir, baseCommit, `after ${strategy} repeat ${repeatIndex}`);
    return built;
  } finally {
    await cleanupRealRun(db, repoDir, scratchRoot, workerIds);
  }
}

/**
 * Controlled real-agent comparison: one fixture repository per workload,
 * sequential strategy runs from the same base commit, fresh scratch state
 * per cell, main-pristine asserts around every run, full cleanup in
 * `finally`, and no retries — failed runs are recorded observations.
 */
export async function runRealBenchmark(
  workload: RealWorkloadSpec,
  options: RunRealBenchmarkOptions & { agent: RealAgentConfig },
): Promise<RealBenchmarkComparison> {
  const parsed = RealWorkloadSpecSchema.parse(workload);
  const strategies = options.strategies ?? [...DEFAULT_STRATEGIES];
  if (strategies.length === 0) {
    throw new BenchmarkError("at least one strategy is required");
  }
  if (new Set(strategies).size !== strategies.length) {
    throw new BenchmarkError("duplicate strategies in benchmark run");
  }
  const repeats = options.repeats ?? 3;
  if (!Number.isInteger(repeats) || repeats < 1) {
    throw new BenchmarkError("repeats must be an integer >= 1");
  }  const minSuccessfulRuns = options.minSuccessfulRuns ?? 1;
  if (!Number.isInteger(minSuccessfulRuns) || minSuccessfulRuns < 1) {
    throw new BenchmarkError("minSuccessfulRuns must be an integer >= 1");
  }
  if ((strategies.includes("ATLAS") || strategies.includes("ATLAS_EVOLVING")) && parsed.features.length !== 1) {
    throw new BenchmarkError("the ATLAS arm derives its task set from one feature");
  }
  const db = options.db ?? getPrismaClient();
  const track = options.track ?? (() => undefined);
  const parent = options.scratchParent ?? (await realpath(tmpdir()));
  const fixtureRoot = await mkdtemp(join(parent, `real-bench-${parsed.id}-`));
  try {
    const { repoDir, baseCommit } = await buildRealFixture(parsed, fixtureRoot);
    const runs: RealRunResult[] = [];
    for (let repeat = 0; repeat < repeats; repeat += 1) {
      const order =
        options.shuffleSeed === undefined ? strategies : shuffleStrategies(strategies, options.shuffleSeed + repeat);
      for (const strategy of order) {
        const runId = `${parsed.id}-${strategy.toLowerCase().replace(/_/g, "-")}-r${repeat}`;
        const scratchRoot = await mkdtemp(join(parent, `real-bench-run-`));
        runs.push(
          await runOneRealStrategy(db, parsed, options.agent, repoDir, baseCommit, strategy, runId, repeat, scratchRoot, track),
        );
      }
    }
    return compareRealRuns(parsed.id, runs, minSuccessfulRuns, strategies);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}
