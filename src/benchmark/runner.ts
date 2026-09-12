import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrismaClient } from "@prisma/client";
import { getPrismaClient } from "../db/client.js";
import { getCurrentCommit, isClean, pruneWorktrees, removeWorktree, runGit } from "../git/index.js";
import { BenchmarkError } from "./errors.js";
import { buildScenarioRepo } from "./scenarios.js";
import { compareRuns } from "./metrics.js";
import { runAtlas, runDumbParallel, runSingleAgent, type StrategyOutput } from "./strategies.js";
import {
  BenchmarkScenarioSchema,
  type BenchmarkComparison,
  type BenchmarkRunResult,
  type BenchmarkScenario,
  type BenchmarkStrategy,
} from "./types.js";

export interface RunScenarioOptions {
  readonly db?: PrismaClient;
  readonly track?: (model: string, id: string) => void;
  readonly strategies?: BenchmarkStrategy[];
  readonly scratchParent?: string;
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

/**
 * Raw code statistics from Git itself: per-task lines added/removed computed
 * as `git diff --numstat <base> <worker-branch>`. Binary files report `-`
 * and count as zero lines (still counted as touched). This is direct
 * measurement of integrated content volume — never a human-review judgment.
 */
async function diffNumstat(
  repoDir: string,
  base: string,
  branch: string,
): Promise<{ files: number; added: number; removed: number }> {
  const result = await runGit(["diff", "--numstat", base, branch, "--"], { cwd: repoDir });
  let files = 0;
  let added = 0;
  let removed = 0;
  for (const line of result.stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const parts = trimmed.split(/\s+/);
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
}

async function cleanupRun(repoDir: string, scratchRoot: string, worktreePaths: string[]): Promise<void> {
  for (const path of worktreePaths) {
    try {
      await removeWorktree(repoDir, path, { force: true });
    } catch {
      // Best effort: the worktree may already be gone on failure paths.
    }
  }
  await rm(scratchRoot, { recursive: true, force: true }).catch(() => undefined);
  await pruneWorktrees(repoDir).catch(() => undefined);
}

function toTaskKey(taskId: string, outcome: StrategyOutput): string {
  return outcome.executed.find((task) => task.taskId === taskId)?.key ?? taskId;
}

async function buildRunResult(args: {
  db: PrismaClient;
  scenarioId: string;
  runId: string;
  strategy: BenchmarkStrategy;
  repoDir: string;
  baseCommit: string;
  startedAt: string;
  wallStart: number;
  outcome: StrategyOutput;
  peakConcurrency: number;
  scheduling: BenchmarkRunResult["scheduling"];
}): Promise<BenchmarkRunResult> {
  const { db, scenarioId, runId, strategy, repoDir, baseCommit, outcome } = args;
  const wallClockMs = Date.now() - args.wallStart;
  const finishedAt = new Date().toISOString();

  let filesTouched = 0;
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const task of outcome.executed) {
    const stats = await diffNumstat(repoDir, baseCommit, task.branch).catch(() => ({ files: 0, added: 0, removed: 0 }));
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
  const mergeCommits: string[] = [];
  if (outcome.integration !== null) {
    for (const item of outcome.integration.items) {
      if (item.status === "CONFLICT") {
        rework += 1;
        conflicts.push(toTaskKey(item.taskId, outcome));
      } else if (item.status === "NOT_ATTEMPTED") {
        rework += 1;
      }
      if (item.status === "INTEGRATED" && item.mergeCommit !== undefined) {
        mergeCommits.push(item.mergeCommit);
      }
    }
  }
  conflicts.sort();

  const artifactIds = new Set<string>();
  const testRunIds = new Set<string>();
  const commitShas = new Set<string>(mergeCommits);
  for (const task of outcome.executed) {
    const artifacts = await db.artifact.findMany({ where: { taskId: task.taskId }, select: { id: true } });
    for (const row of artifacts) {
      artifactIds.add(row.id);
    }
    const runs = await db.testRun.findMany({ where: { taskId: task.taskId }, select: { id: true } });
    for (const row of runs) {
      testRunIds.add(row.id);
    }
    const commits = await db.commit.findMany({ where: { taskId: task.taskId }, select: { sha: true } });
    for (const row of commits) {
      commitShas.add(row.sha);
    }
  }

  return {
    scenarioId,
    runId,
    strategy,
    startedAt: args.startedAt,
    finishedAt,
    wallClockMs,
    baseCommit,
    tasks: outcome.executed.map((task) => ({
      key: task.key,
      taskId: task.taskId,
      workerId: task.workerId,
      status: task.execution.status,
      workerMs: task.workerMs,
      verification: task.verification.verdict,
      testStatus: task.testRun.status,
      undeclaredResources: [...task.execution.undeclaredResources].sort(),
    })),
    scheduling: args.scheduling,
    integration:
      outcome.integration === null
        ? null
        : {
            status: outcome.integration.status,
            mergeCommits: [...mergeCommits].sort(),
            conflicts,
            items: outcome.integration.items.map((item) => ({
              key: toTaskKey(item.taskId, outcome),
              status: item.status,
            })),
            order: [...outcome.integrationOrder],
          },
    metrics: {
      peakConcurrency: args.peakConcurrency,
      taskCount: outcome.executed.length,
      workerCount: workerIds.size,
      failures,
      violations,
      rework,
      codeStats: { filesTouched, linesAdded, linesRemoved },
    },
    evidence: {
      artifactIds: [...artifactIds].sort(),
      testRunIds: [...testRunIds].sort(),
      commitShas: [...commitShas].sort(),
      trainBranch: outcome.integration?.trainBranch ?? null,
      integrationOrder: [...outcome.integrationOrder],
    },
    provenance: "fake-provider",
  };
}

async function runOneStrategy(
  db: PrismaClient,
  scenario: BenchmarkScenario,
  repoDir: string,
  baseCommit: string,
  strategy: BenchmarkStrategy,
  runId: string,
  scratchRoot: string,
  track: (model: string, id: string) => void,
): Promise<BenchmarkRunResult> {
  const ctx = { db, scenario, repoDir, baseCommit, runId, scratchRoot, track };
  await assertMainPristine(repoDir, baseCommit, `before ${strategy}`);
  const startedAt = new Date().toISOString();
  const wallStart = Date.now();
  const worktreePaths: string[] = [];
  try {
    let outcome: StrategyOutput;
    let peakConcurrency: number;
    let scheduling: BenchmarkRunResult["scheduling"];
    if (strategy === "SINGLE_AGENT") {
      const single = await runSingleAgent(ctx);
      outcome = single;
      peakConcurrency = single.peakConcurrency;
      scheduling = null;
    } else if (strategy === "DUMB_PARALLEL") {
      const dumb = await runDumbParallel(ctx);
      outcome = dumb;
      peakConcurrency = dumb.peakConcurrency;
      scheduling = null;
    } else {
      const atlas = await runAtlas(ctx);
      outcome = atlas;
      peakConcurrency = atlas.peakConcurrency;
      scheduling = { waves: atlas.waves, conflicts: atlas.conflicts, blocked: atlas.blocked };
    }
    for (const task of outcome.executed) {
      worktreePaths.push(task.workspacePath);
    }
    const built = await buildRunResult({
      db,
      scenarioId: scenario.id,
      runId,
      strategy,
      repoDir,
      baseCommit,
      startedAt,
      wallStart,
      outcome,
      peakConcurrency,
      scheduling,
    });
    await assertMainPristine(repoDir, baseCommit, `after ${strategy}`);
    return built;
  } finally {
    await cleanupRun(repoDir, scratchRoot, worktreePaths);
  }
}

/**
 * Run benchmark strategies against one shared fixture repository.
 * Every strategy starts from the same base commit; the main worktree is
 * asserted pristine before and after each run; all per-run filesystem state
 * is removed in `finally` (including failure paths); DB rows flow through
 * the caller's `track` for test cleanup.
 */
export async function runBenchmarkScenario(
  scenario: BenchmarkScenario,
  options: RunScenarioOptions = {},
): Promise<BenchmarkComparison> {
  const parsed = BenchmarkScenarioSchema.parse(scenario);
  const strategies = options.strategies ?? [...DEFAULT_STRATEGIES];
  if (strategies.length === 0) {
    throw new BenchmarkError("at least one strategy is required");
  }
  if (new Set(strategies).size !== strategies.length) {
    throw new BenchmarkError("duplicate strategies in benchmark run");
  }
  const db = options.db ?? getPrismaClient();
  const track = options.track ?? (() => undefined);
  const parent = options.scratchParent ?? (await realpath(tmpdir()));
  const fixtureRoot = await mkdtemp(join(parent, `bench-${parsed.id}-`));
  try {
    const { repoDir, baseCommit } = await buildScenarioRepo(parsed, fixtureRoot);
    const runs: Partial<Record<BenchmarkStrategy, BenchmarkRunResult>> = {};
    for (const strategy of strategies) {
      const runId = `${parsed.id}-${strategy.toLowerCase().replace(/_/g, "-")}`;
      const scratchRoot = await mkdtemp(join(parent, `bench-run-`));
      runs[strategy] = await runOneStrategy(db, parsed, repoDir, baseCommit, strategy, runId, scratchRoot, track);
    }
    const costs = new Map<string, number>();
    for (const task of parsed.tasks) {
      if (task.simulatedCostUsd !== undefined) {
        costs.set(task.key, task.simulatedCostUsd);
      }
    }
    let singleSum = 0;
    let singleCounted = true;
    for (const task of parsed.tasks) {
      if (task.simulatedCostUsd === undefined) {
        singleCounted = false;
      } else {
        singleSum += task.simulatedCostUsd;
      }
    }
    if (singleCounted) {
      costs.set("single", singleSum);
    }
    return compareRuns(parsed.id, runs, costs);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}
