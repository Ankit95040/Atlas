import { cp, mkdir, mkdtemp, realpath, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrismaClient } from "@prisma/client";
import { getPrismaClient } from "../../db/client.js";
import { getCurrentCommit, isClean, pruneWorktrees, removeWorktree, runGit } from "../../git/index.js";
import { runTests } from "../../verification/index.js";
import type { IntegratedItem, MergeTrainResult } from "../../verification/index.js";
import { BenchmarkError } from "../errors.js";
import type { BenchmarkStrategy } from "../types.js";
import { buildRealFixture } from "../real/runner.js";
import {
  runRealAtlasEvolving,
  runRealSingleAgent,
  type RealExecutedTask,
  type RealStrategyContext,
  type RealStrategyOutput,
} from "../real/strategies.js";
import type { RealAgentConfig, RealWorkloadSpec } from "../real/types.js";
import { assembleContextRecord, measurePromptTokensFromPromptString, measureRepoTokens, measureTaskRelevantTokens, renderAeTaskPrompt, renderSaUnionPrompt } from "./context.js";
import { emptyScaleState, loadScaleState, missingScaleCells, saveScaleState, upsertScaleRun } from "./persistence.js";
import { evaluateTaskSurvival, runBaselineProbes, survivalPredicate, survivalRate } from "./survival.js";
import {
  M18_LEVEL_KINDS,
  M18_LEVEL_REPEATS,
  M18_LEVEL_TIMEOUTS_MS,
  SCALE_SETUP_TIMEOUT_MS,
  type ScaleExperimentState,
  type ScaleRunResult,
  type ScaleSetupEvidence,
  type ScaleTaskSurvival,
  type ScaleWorkloadSpec,
} from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * M18 allows exactly the two design arms. DUMB_PARALLEL is excluded by the
 * experiment (design §1.1): it answers no new scientific question here.
 * Enforcement lives in the harness so a stray config cannot silently spend
 * agent budget re-proving a settled point.
 */
const M18_STRATEGIES: readonly BenchmarkStrategy[] = ["SINGLE_AGENT", "ATLAS_EVOLVING"];

// ---------- Setup contract (Amendment A.3) ----------

/** Run setupCommands once per materialized fixture, before either arm. */
async function runFixtureSetup(args: {
  readonly fixtureDir: string;
  readonly setupCommands: readonly (readonly string[])[];
  readonly setupTimeoutMs: number;
}): Promise<{ networkUsed: boolean; wallTimeMs: number }> {
  if (args.setupCommands.length === 0) {
    return { networkUsed: false, wallTimeMs: 0 };
  }
  const wallStart = Date.now();
  let networkUsed = false;
  for (const command of args.setupCommands) {
    const [executable, ...argv] = command;
    if (executable === undefined) {
      throw new BenchmarkError("empty setup command");
    }
    // Detect network access in setup commands
    const cmdStr = command.join(" ");
    if (cmdStr.includes("npm") || cmdStr.includes("yarn") || cmdStr.includes("pnpm") || cmdStr.includes("curl") || cmdStr.includes("wget")) {
      networkUsed = true;
    }
    try {
      await execFileAsync(executable, argv, {
        cwd: args.fixtureDir,
        timeout: args.setupTimeoutMs,
        maxBuffer: 1024 * 1024,
      });
    } catch (error) {
      const wallTimeMs = Date.now() - wallStart;
      throw new BenchmarkError(
        `setup command failed [${command.join(" ")}] after ${wallTimeMs}ms: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { networkUsed, wallTimeMs: Date.now() - wallStart };
}

/** Write .gitignore to protect fixture from agent file writes. */
async function writeFixtureGitignore(fixtureDir: string): Promise<void> {
  const content = [
    "node_modules/",
    "dist/",
    "build/",
    ".cache/",
    "*.tgz",
    "",
  ].join("\n");
  await writeFile(join(fixtureDir, ".gitignore"), content);
}

/** Capture version evidence at setup time for reproducibility. */
async function captureSetupEvidence(args: {
  readonly fixtureDir: string;
  readonly snapshotRef: string;
  readonly setupWallTimeMs: number;
  readonly networkUsedAtSetup: boolean;
}): Promise<ScaleSetupEvidence> {
  const { fixtureDir, snapshotRef, setupWallTimeMs, networkUsedAtSetup } = args;

  // node --version
  let nodeVersion = "unknown";
  try {
    const { stdout } = await execFileAsync("node", ["--version"]);
    nodeVersion = stdout.trim();
  } catch {
    // Keep "unknown"
  }

  // lockfile SHA256 (if exists)
  let lockfileSha256: string | null = null;
  for (const lockfile of ["package-lock.json", "yarn.lock", "pnpm-lock.yaml"]) {
    const lockPath = join(fixtureDir, lockfile);
    const lockStat = await stat(lockPath).catch(() => null);
    if (lockStat !== null) {
      try {
        const { stdout } = await execFileAsync("shasum", ["-a", "256", lockPath]);
        lockfileSha256 = stdout.trim().split(" ")[0] ?? null;
      } catch {
        // Keep null
      }
      break;
    }
  }

  // Runner version (best effort — try node_modules/.bin/mocha, etc.)
  let runnerVersion: string | null = null;
  const binDir = join(fixtureDir, "node_modules", ".bin");
  const binStat = await stat(binDir).catch(() => null);
  if (binStat !== null) {
    const bins: string[] = await readdir(binDir).catch((): string[] => []);
    for (const bin of ["mocha", "tap", "uvu", "jest", "vitest"]) {
      if (bins.includes(bin)) {
        try {
          const { stdout } = await execFileAsync(join(binDir, bin), ["--version"]);
          runnerVersion = `${bin}@${stdout.trim()}`;
        } catch {
          // Keep null
        }
        break;
      }
    }
  }

  return {
    snapshotRef,
    lockfileSha256,
    nodeVersion,
    runnerVersion,
    setupWallTimeMs,
    networkUsedAtSetup,
  };
}

export interface RunScaleBenchmarkOptions {
  readonly db?: PrismaClient;
  readonly track?: (model: string, id: string) => void;
  readonly agent: RealAgentConfig;
  readonly strategies?: BenchmarkStrategy[];
  /** Defaults to M18_LEVEL_REPEATS[level] (design §1.2). */
  readonly repeats?: number;
  readonly minSuccessfulRuns?: number;
  readonly scratchParent?: string;
  /**
   * Worker timeout override. Defaults to M18_LEVEL_TIMEOUTS_MS[level]
   * (design §5.4). Identical across arms within a level either way.
   */
  readonly workerTimeoutMs?: number;
  /** Resume state file (design §10.2). When set, each run persists before cleanup. */
  readonly statePath?: string;
  readonly stateMeta?: ScaleExperimentState["meta"];
  /**
   * Declared context-window capacity in tokens for the model under test.
   * Used for §U utilization calculation. If not provided, defaults to 200_000.
   * The agent config's `model` field is a string label, not a numeric capacity;
   * this field makes the capacity explicit and auditable.
   */
  readonly modelCapacityTokens?: number;
}

/** Convert an M18 workload to the frozen M17 arm input. Kind follows the level; nothing else is relabeled. */
export function toRealWorkloadSpec(scale: ScaleWorkloadSpec): RealWorkloadSpec {
  return {
    id: scale.id,
    name: scale.name,
    description: scale.description,
    kind: M18_LEVEL_KINDS[scale.level],
    featureSpec: { ...scale.featureSpec },
    features: scale.features.map((feature) => ({ ...feature })),
    baseFiles: scale.baseFiles.map((file) => ({ ...file })),
    testFiles: scale.testFiles.map((file) => ({ ...file })),
    testCommand: [...scale.testCommand],
    tasks: scale.tasks.map((task) => ({
      key: task.key,
      title: task.title,
      description: task.description,
      featureKey: task.featureKey,
      claims: task.claims.map((claim) => ({ ...claim })),
      dependsOn: [...task.dependsOn],
    })),
    expectedOutcome: scale.expectedOutcome,
  };
}

function validateStrategies(strategies: readonly BenchmarkStrategy[]): void {
  if (strategies.length === 0) {
    throw new BenchmarkError("at least one strategy is required");
  }
  if (new Set(strategies).size !== strategies.length) {
    throw new BenchmarkError("duplicate strategies in scale benchmark run");
  }
  for (const strategy of strategies) {
    if (!M18_STRATEGIES.includes(strategy)) {
      throw new BenchmarkError(
        `strategy ${strategy} is outside the M18 design matrix (SINGLE_AGENT, ATLAS_EVOLVING); see design §1.1`,
      );
    }
  }
}

async function assertFixturePristine(repoDir: string, baseCommit: string, phase: string): Promise<void> {
  const head = await getCurrentCommit(repoDir);
  if (head !== baseCommit) {
    throw new BenchmarkError(`fixture HEAD moved ${phase}: expected ${baseCommit}, got ${head}`);
  }
  if (!(await isClean(repoDir))) {
    throw new BenchmarkError(`fixture worktree is not clean ${phase}`);
  }
}

/**
 * Materialize an M18 fixture: optional vendored snapshot overlay first (clean
 * tree, no .git — vendoring is a human step, never a fetch), then inline
 * base/test files, then .gitignore protection, then a single base commit.
 * Same git identity as M17 fixtures so provenance stays comparable.
 */
export async function buildScaleFixture(
  scale: ScaleWorkloadSpec,
  dir: string,
): Promise<{ repoDir: string; baseCommit: string }> {
  try {
    if (scale.snapshot !== undefined) {
      const sourceStat = await stat(scale.snapshot.sourceDir).catch(() => null);
      if (sourceStat === null || !sourceStat.isDirectory()) {
        throw new BenchmarkError(`snapshot source is not a directory: ${scale.snapshot.sourceDir}`);
      }
      const entries = await readdir(scale.snapshot.sourceDir);
      if (entries.includes(".git")) {
        throw new BenchmarkError(`snapshot source must be a clean tree without .git: ${scale.snapshot.sourceDir}`);
      }
      for (const entry of entries) {
        await cp(join(scale.snapshot.sourceDir, entry), join(dir, entry), { recursive: true });
      }
    }
    const real = toRealWorkloadSpec(scale);
    for (const file of [...real.baseFiles, ...real.testFiles]) {
      const absolute = join(dir, file.path);
      await mkdir(join(absolute, ".."), { recursive: true });
      await writeFile(absolute, file.content);
    }
    await writeFixtureGitignore(dir);
    await runGit(["init", "-b", "main"], { cwd: dir });
    await runGit(["config", "user.email", "atlas-scale-benchmark@example.invalid"], { cwd: dir });
    await runGit(["config", "user.name", "Atlas Scale Benchmark"], { cwd: dir });
    await runGit(["add", "-A"], { cwd: dir });
    await runGit(["-c", "commit.gpgsign=false", "commit", "-m", `scale benchmark fixture ${scale.id}`], { cwd: dir });
    return { repoDir: dir, baseCommit: await getCurrentCommit(dir) };
  } catch (error) {
    if (error instanceof BenchmarkError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new BenchmarkError(`scale fixture setup failed for workload ${scale.id}: ${message}`);
  }
}

/** Whole-repo change size between base and train head (failures yield zeros, never throws). */
async function diffWholeTree(
  repoDir: string,
  base: string,
  head: string,
): Promise<{ files: number; added: number; removed: number }> {
  try {
    const result = await runGit(["diff", "--numstat", base, head, "--"], { cwd: repoDir });
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

async function cleanupScaleRun(db: PrismaClient, repoDir: string, scratchRoot: string, workerIds: string[]): Promise<void> {
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

/**
 * Genuine provider-side signals only (M19.2): Atlas-generated malformed-output
 * reports, rate-limit vocabulary, and connection-level failures. Deliberately
 * NOT matching bare 3-digit numbers — an arbitrary stderr line containing
 * e.g. "517" is not a provider HTTP error (M18 false-positive class), and
 * timeouts are classified from structured spawn evidence below, not text.
 */
const PROVIDER_FAILURE_PATTERN =
  /provider returned malformed output|rate.?limit|too many requests|overloaded|insufficient quota|quota exceeded|ECONN|ENOTFOUND|socket hang up|ETIMEDOUT|EAI_AGAIN/i;

export function classifyScaleFailure(args: {
  success: boolean;
  tasks: ScaleRunResult["tasks"];
  integrationStatus: string | null;
  verificationFailed: boolean;
}): ScaleRunResult["failureClassification"] {
  if (args.success) {
    return "NONE";
  }
  const errors = args.tasks.map((task) => task.error ?? "").filter((error) => error.length > 0);
  if (errors.some((error) => PROVIDER_FAILURE_PATTERN.test(error))) {
    return "PROVIDER_FAILURE";
  }
  // Structured spawn evidence (M19.2/M20.3): the boundary knows whether it
  // killed, observed, or failed to start the child. A detected provider rate
  // limit is a genuine provider failure; all other command-boundary outcomes
  // — including timeouts, which previously split nonsensically between
  // PROVIDER (grace path) and WORKER (SIGTERM-death path) by race — are
  // worker-budget outcomes, not provider errors.
  const codes = args.tasks.map((task) => task.errorCode ?? null);
  if (codes.some((code) => code === "RATE_LIMIT")) {
    return "PROVIDER_FAILURE";
  }
  if (codes.some((code) => code !== null)) {
    return "WORKER_FAILURE";
  }
  if (args.integrationStatus === "HALTED") {
    return "INTEGRATION_FAILURE";
  }
  if (args.tasks.some((task) => task.status !== "COMPLETED")) {
    return "WORKER_FAILURE";
  }
  if (args.verificationFailed) {
    return "VERIFICATION_FAILURE";
  }
  return "UNKNOWN";
}

/**
 * Map merge-train items onto scale integration records without discarding
 * diagnostic evidence (M19.3): reason, merge commit, test run, timing,
 * conflict files, and merge-failure forensics all propagate. Pure function
 * so the mapping is unit-testable without executing runs.
 */
export function toScaleIntegrationItems(
  items: readonly IntegratedItem[],
  keyForTaskId: (taskId: string) => string,
  strategy: BenchmarkStrategy,
): NonNullable<ScaleRunResult["integration"]>["items"] {
  return items.map((item) => {
    const key = keyForTaskId(item.taskId);
    const display = strategy === "SINGLE_AGENT" && key === "single" ? "single" : key;
    return {
      key: display,
      status: item.status,
      reason: item.reason ?? null,
      mergeCommit: item.mergeCommit ?? null,
      testRunId: item.testRunId ?? null,
      durationMs: item.durationMs ?? null,
      conflictFiles: item.conflictFiles !== undefined ? [...item.conflictFiles] : null,
      emptyMerge: item.emptyMerge ?? null,
      gitExitCode: item.gitExitCode ?? null,
      gitStderr: item.gitStderr ?? null,
      sourceCommit: item.sourceCommit ?? null,
    };
  });
}

function truncateError(error: unknown): string | null {
  if (error === undefined) {
    return null;
  }
  const text = typeof error === "string" ? error : String(error);
  return text.length <= 2000 ? text : text.slice(0, 2000);
}

async function buildScaleRunResult(args: {
  db: PrismaClient;
  scale: ScaleWorkloadSpec;
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
  scheduling: ScaleRunResult["scheduling"];
  workerTimeoutMs: number;
  track: (model: string, id: string) => void;
  context: ScaleRunResult["context"];
}): Promise<ScaleRunResult> {
  const { db, scale, runId, strategy, repoDir, baseCommit, outcome } = args;
  const wallClockMs = Date.now() - args.wallStart;
  const finishedAt = new Date().toISOString();
  // Probes address intended task keys in both arms: for SINGLE_AGENT the
  // union sections, for ATLAS_EVOLVING the per-task outcomes (same keys).
  const intendedKeys = scale.tasks.map((task) => task.key);
  const byKey = new Map(outcome.executed.map((task) => [task.key, task] as const));
  const singleOutcome = strategy === "SINGLE_AGENT" ? byKey.get("single") : undefined;

  const workerCompletion = intendedKeys.every((key) => {
    const task: RealExecutedTask | undefined = strategy === "SINGLE_AGENT" ? singleOutcome : byKey.get(key);
    return (
      task !== undefined &&
      task.execution.status === "COMPLETED" &&
      task.testRun?.status === "PASSED" &&
      task.verification?.verdict === "VERIFIED"
    );
  });

  const integration: MergeTrainResult | null = outcome.integration;
  const trainHead = integration?.finalCommit ?? null;
  const trainPath = integration?.trainPath ?? null;

  const mergeShasByTask = new Map<string, Set<string>>();
  for (const item of integration?.items ?? []) {
    const key = outcome.executed.find((task) => task.taskId === item.taskId)?.key;
    if (key === undefined || item.mergeCommit === undefined) {
      continue;
    }
    // The union "single" merge contains every intended contribution.
    const targets = strategy === "SINGLE_AGENT" && key === "single" ? intendedKeys : [key];
    for (const target of targets) {
      const set = mergeShasByTask.get(target) ?? new Set<string>();
      set.add(item.mergeCommit);
      mergeShasByTask.set(target, set);
    }
  }

  const survival: ScaleTaskSurvival[] = [];

  // Baseline probe evaluation: run probes against pristine fixture to determine
  // which tasks already have their features present before any worker intervention.
  const baselineDir = scale.snapshot?.sourceDir;
  const baselineResults = new Map<string, boolean>();
  if (baselineDir !== undefined) {
    for (const key of intendedKeys) {
      const spec = scale.tasks.find((task) => task.key === key);
      if (spec !== undefined) {
        baselineResults.set(key, await runBaselineProbes({ baselineDir, probes: [...spec.probes] }));
      }
    }
  }

  for (const key of intendedKeys) {
    const spec = scale.tasks.find((task) => task.key === key);
    if (spec === undefined) {
      throw new BenchmarkError(`intended task ${key} missing from scale workload ${scale.id}`);
    }
    if (trainHead === null || trainPath === null) {
      survival.push({
        key,
        status: "NEVER_MERGED",
        probePassed: false,
        diffNonEmpty: false,
        attributed: false,
        detail: "no integration train exists",
        baselinePassed: baselineResults.get(key) ?? false,
      });
      continue;
    }
    survival.push(
      await evaluateTaskSurvival({
        repoDir,
        trainPath,
        baseCommit,
        trainHead,
        taskKey: key,
        claimedPaths: spec.claims.filter((claim) => claim.access === "WRITE").map((claim) => claim.resource),
        probes: [...spec.probes],
        ownMergeShas: mergeShasByTask.get(key) ?? new Set<string>(),
        baselinePassed: baselineResults.get(key) ?? false,
      }),
    );
  }
  const survivalRateValue = survivalRate(survival);
  const survivalOk = survivalPredicate(survival, intendedKeys);

  // §6.2 final feature gate: the deterministic command runs Atlas-side at the
  // train head (not agent self-report). Linked to the first executed task for
  // evidence; the gate verdict is what the predicate consumes.
  let featureTestsPassed: boolean | null = null;
  let featureTestRunId: string | null = null;
  if (trainPath !== null && outcome.executed.length > 0) {
    const anchor = outcome.executed[0];
    if (anchor !== undefined) {
      const gate = await runTests(
        { taskId: anchor.taskId, workdir: trainPath, command: [...scale.testCommand], name: "m18-feature-gate" },
        db,
      );
      args.track("testRun", gate.testRunId);
      featureTestRunId = gate.testRunId;
      featureTestsPassed = gate.status === "PASSED";
    }
  }
  if (featureTestsPassed === null) {
    featureTestsPassed = false;
  }

  // §6.3 donor regression gate: recorded null (vacuously true) when the
  // workload declares no regression command (advisory in Stratum A).
  let regressionPassed: boolean | null = null;
  let regressionTestRunId: string | null = null;
  if (scale.regressionCommand !== undefined && trainPath !== null && outcome.executed.length > 0) {
    const anchor = outcome.executed[0];
    if (anchor !== undefined) {
      const gate = await runTests(
        { taskId: anchor.taskId, workdir: trainPath, command: [...scale.regressionCommand], name: "m18-regression-gate" },
        db,
      );
      args.track("testRun", gate.testRunId);
      regressionTestRunId = gate.testRunId;
      regressionPassed = gate.status === "PASSED";
    }
  }
  if (scale.regressionCommand !== undefined && regressionPassed === null) {
    regressionPassed = false;
  }

  // §6.5 counters-only instrumentation: the harness performs zero
  // interventions; the field exists so the protocol stays explicit.
  const humanInterventions = 0;

  const workerIds = new Set(outcome.executed.map((task) => task.workerId));
  let failures = 0;
  let violations = 0;
  let verificationFailed = false;
  for (const task of outcome.executed) {
    if (task.execution.status !== "COMPLETED") {
      failures += 1;
    }
    if (task.execution.status === "CLAIM_VIOLATION") {
      violations += 1;
    }
    if (task.execution.status === "COMPLETED" && task.verification !== null && task.verification.verdict !== "VERIFIED") {
      verificationFailed = true;
    }
  }

  let rework = 0;
  const conflicts: string[] = [];
  if (integration !== null) {
    for (const item of integration.items) {
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

  const wholeTree = trainHead !== null ? await diffWholeTree(repoDir, baseCommit, trainHead) : { files: 0, added: 0, removed: 0 };
  const codeStats = { filesTouched: wholeTree.files, linesAdded: wholeTree.added, linesRemoved: wholeTree.removed };
  const workerMsValues = outcome.executed.map((task) => task.workerMs);
  const workerMsTotal = workerMsValues.every((ms): ms is number => ms !== null)
    ? workerMsValues.reduce((sum, ms) => sum + (ms as number), 0)
    : null;

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
  if (featureTestRunId !== null) {
    testRunIds.add(featureTestRunId);
  }
  if (regressionTestRunId !== null) {
    testRunIds.add(regressionTestRunId);
  }

  const taskRecords: ScaleRunResult["tasks"] = outcome.executed.map((task) => ({
    key: task.key,
    taskId: task.taskId,
    workerId: task.workerId,
    status: task.execution.status,
    workerMs: task.workerMs,
    verification: task.verification?.verdict ?? "NOT_EVALUATED",
    testStatus: task.testRun?.status ?? "NOT_RUN",
    error: truncateError((task.execution as { error?: unknown }).error),
    errorCode: task.execution.errorCode ?? null,
  }));

  const successPredicates: ScaleRunResult["successPredicates"] = {
    workerCompletion,
    featureCorrectness: featureTestsPassed,
    regression: regressionPassed !== false,
    survival: survivalOk,
    noIntervention: humanInterventions === 0,
  };
  const success =
    successPredicates.workerCompletion &&
    successPredicates.featureCorrectness &&
    successPredicates.regression &&
    successPredicates.survival &&
    successPredicates.noIntervention;

  const waves = strategy === "ATLAS_EVOLVING" ? (outcome.waveBases?.length ?? 0) : outcome.executed.length > 0 ? 1 : 0;

  return {
    workloadId: scale.id,
    level: scale.level,
    runId: args.runId,
    repeatIndex: args.repeatIndex,
    strategy,
    startedAt: args.startedAt,
    finishedAt,
    wallClockMs,
    baseCommit,
    trainHead,
    workerTimeoutMs: args.workerTimeoutMs,
    agent: {
      provider: args.agent.provider,
      executable: args.agent.executable,
      model: args.agent.model ?? null,
      version: args.agent.version ?? null,
      temperature: args.agent.temperature ?? null,
    },
    decomposition: "human-authored",
    tasks: taskRecords,
    scheduling: args.scheduling,
    integration:
      integration === null
        ? null
        : {
            status: integration.status === "COMPLETED" ? "COMPLETED" : "HALTED",
            conflicts,
            items: toScaleIntegrationItems(
              integration.items,
              (taskId) => outcome.executed.find((task) => task.taskId === taskId)?.key ?? taskId,
              strategy,
            ),
            order: [...outcome.integrationOrder],
          },
    triageClassifications: [...outcome.triageClassifications],
    waveBases: outcome.waveBases ? [...outcome.waveBases] : null,
    survival,
    survivalRate: survivalRateValue,
    featureTestsPassed,
    regressionPassed,
    humanInterventions,
    failureClassification: classifyScaleFailure({
      success,
      tasks: taskRecords,
      integrationStatus: integration?.status ?? null,
      verificationFailed,
    }),
    metrics: {
      peakConcurrency: args.peakConcurrency,
      waves,
      taskCount: outcome.executed.length,
      workerCount: workerIds.size,
      failures,
      violations,
      rework,
      codeStats,
      workerMsTotal,
    },
    usage: { tokens: null, costUsd: null },
    context: args.context,
    evidence: {
      artifactIds: [...artifactIds].sort(),
      testRunIds: [...testRunIds].sort(),
      commitShas: [...commitShas].sort(),
      trainBranch: integration?.trainBranch ?? null,
      featureTestRunId,
      regressionTestRunId,
    },
    successPredicates,
    success,
  };
}

async function runOneScaleStrategy(args: {
  db: PrismaClient;
  scale: ScaleWorkloadSpec;
  real: RealWorkloadSpec;
  agent: RunScaleBenchmarkOptions["agent"] & { timeoutMs: number };
  repoDir: string;
  baseCommit: string;
  strategy: BenchmarkStrategy;
  runId: string;
  repeatIndex: number;
  scratchRoot: string;
  workerTimeoutMs: number;
  track: (model: string, id: string) => void;
  context: { repoTokens: number; taskRelevantTokens: number; modelCapacityTokens: number };
}): Promise<ScaleRunResult> {
  const { db, scale, real, strategy, repoDir, baseCommit, runId, repeatIndex, scratchRoot, track } = args;
  const agent = { ...args.agent, timeoutMs: args.workerTimeoutMs };
  const ctx: RealStrategyContext = { db, workload: real, agent, repoDir, baseCommit, runId, scratchRoot, track };
  await assertFixturePristine(repoDir, baseCommit, `before ${strategy} repeat ${repeatIndex}`);
  const startedAt = new Date().toISOString();
  const wallStart = Date.now();
  const workerIds: string[] = [];
  try {
    let outcome: RealStrategyOutput;
    let peakConcurrency: number;
    let scheduling: ScaleRunResult["scheduling"];
    if (strategy === "SINGLE_AGENT") {
      const single = await runRealSingleAgent(ctx);
      outcome = single;
      peakConcurrency = single.peakConcurrency;
      scheduling = null;
    } else {
      const evolving = await runRealAtlasEvolving(ctx);
      outcome = evolving;
      peakConcurrency = evolving.peakConcurrency;
      scheduling = evolving.scheduling;
    }
    for (const task of outcome.executed) {
      workerIds.push(task.workerId);
    }

    // Context: measure §V (prompt tokens) using the exact frozen renderer output.
    // SA: renderSingleAgentPrompt produces the union prompt (same bytes the arm passes to the provider).
    // AE: renderTaskPrompt produces each per-task prompt (same bytes the arm passes to the provider).
    const promptTokenCounts: number[] = [];
    if (strategy === "SINGLE_AGENT") {
      const saPrompt = renderSaUnionPrompt(scale);
      promptTokenCounts.push(measurePromptTokensFromPromptString(saPrompt));
    } else {
      for (const task of scale.tasks) {
        const aePrompt = renderAeTaskPrompt(task, scale.featureSpec.title);
        promptTokenCounts.push(measurePromptTokensFromPromptString(aePrompt));
      }
    }
    const context = assembleContextRecord({
      modelCapacityTokens: args.context.modelCapacityTokens,
      repoTokens: args.context.repoTokens,
      taskRelevantTokens: args.context.taskRelevantTokens,
      promptTokenCounts,
    });

    const built = await buildScaleRunResult({
      db,
      scale,
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
      workerTimeoutMs: args.workerTimeoutMs,
      track,
      context,
    });
    await assertFixturePristine(repoDir, baseCommit, `after ${strategy} repeat ${repeatIndex}`);
    return built;
  } finally {
    await cleanupScaleRun(db, repoDir, scratchRoot, workerIds);
  }
}

/**
 * M18 workload driver: one fixture repository per workload, sequential cells
 * from the design matrix, fresh scratch per cell, per-run persistence before
 * cleanup (design §10.2), full fixture cleanup in `finally`, no retries.
 */
export async function runScaleWorkload(
  scale: ScaleWorkloadSpec,
  options: RunScaleBenchmarkOptions,
): Promise<ScaleExperimentState> {
  const strategies = options.strategies ?? [...M18_STRATEGIES];
  validateStrategies(strategies);
  const repeats = options.repeats ?? M18_LEVEL_REPEATS[scale.level];
  if (!Number.isInteger(repeats) || repeats < 1) {
    throw new BenchmarkError("repeats must be an integer >= 1");
  }
  const minSuccessfulRuns = options.minSuccessfulRuns ?? 1;
  if (!Number.isInteger(minSuccessfulRuns) || minSuccessfulRuns < 1) {
    throw new BenchmarkError("minSuccessfulRuns must be an integer >= 1");
  }
  const workerTimeoutMs = options.workerTimeoutMs ?? M18_LEVEL_TIMEOUTS_MS[scale.level];
  if (!Number.isInteger(workerTimeoutMs) || workerTimeoutMs < 1000 || workerTimeoutMs > 3600000) {
    throw new BenchmarkError("workerTimeoutMs must be an integer in [1000, 3600000] (provider bounds)");
  }
  const db = options.db ?? getPrismaClient();
  const track = options.track ?? (() => undefined);
  const parent = options.scratchParent ?? (await realpath(tmpdir()));
  const agent: RealAgentConfig = { ...options.agent, timeoutMs: workerTimeoutMs };

  let state: ScaleExperimentState;
  if (options.statePath !== undefined) {
    state = (await loadScaleState(options.statePath)) ?? emptyScaleState(options.stateMeta ?? {});
  } else {
    state = emptyScaleState(options.stateMeta ?? {});
  }

  const pending = missingScaleCells(state, scale.id, strategies, repeats);
  const fixtureRoot = await mkdtemp(join(parent, `scale-bench-${scale.id}-`));
  try {
    const { repoDir, baseCommit } = await buildScaleFixture(scale, fixtureRoot);

    // Setup contract (Amendment A.3): run setupCommands once, capture evidence.
    let setupEvidence: ScaleSetupEvidence | null = null;
    if (scale.setupCommands.length > 0) {
      const setupTimeoutMs = scale.setupTimeoutMs ?? SCALE_SETUP_TIMEOUT_MS;
      const setupResult = await runFixtureSetup({
        fixtureDir: fixtureRoot,
        setupCommands: scale.setupCommands,
        setupTimeoutMs,
      });
      setupEvidence = await captureSetupEvidence({
        fixtureDir: fixtureRoot,
        snapshotRef: scale.snapshot?.ref ?? baseCommit,
        setupWallTimeMs: setupResult.wallTimeMs,
        networkUsedAtSetup: setupResult.networkUsed,
      });
    } else {
      setupEvidence = await captureSetupEvidence({
        fixtureDir: fixtureRoot,
        snapshotRef: scale.snapshot?.ref ?? baseCommit,
        setupWallTimeMs: 0,
        networkUsedAtSetup: false,
      });
    }

    // Measure context (Amendment A.2): §R and §T — identical across runs.
    const repoMeasurement = scale.snapshot !== undefined
      ? await measureRepoTokens(scale.snapshot.sourceDir)
      : null;
    const repoTokens = repoMeasurement?.totalTokens ?? 0;
    const taskRelevantTokens = await measureTaskRelevantTokens({ workload: scale, fixtureDir: fixtureRoot });

    // Model capacity from explicit option (not from agent config model label).
    const modelCapacityTokens = options.modelCapacityTokens ?? 200_000;

    // Record setup evidence in state meta.
    state = { ...state, meta: { ...state.meta, setupEvidence } };

    const real = toRealWorkloadSpec(scale);
    for (const cell of pending) {
      const strategy = cell.strategy as BenchmarkStrategy;
      const runId = `${scale.id}-${strategy.toLowerCase().replace(/_/g, "-")}-r${cell.repeatIndex}`;
      const scratchRoot = await mkdtemp(join(parent, `scale-bench-run-`));
      const run = await runOneScaleStrategy({
        db,
        scale,
        real,
        agent,
        repoDir,
        baseCommit,
        strategy,
        runId,
        repeatIndex: cell.repeatIndex,
        scratchRoot,
        workerTimeoutMs,
        track,
        context: { repoTokens, taskRelevantTokens, modelCapacityTokens },
      });
      state = upsertScaleRun(state, scale.id, { level: scale.level, minSuccessfulRuns }, run);
      if (options.statePath !== undefined) {
        await saveScaleState(options.statePath, state);
      }
    }
    const comparison = state.workloads[scale.id];
    if (comparison !== undefined && options.statePath !== undefined) {
      await saveScaleState(options.statePath, state);
    }
    return state;
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}
