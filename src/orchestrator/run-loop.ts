import { join } from "node:path";
import type { PrismaClient } from "@prisma/client";
import { getPrismaClient } from "../db/client.js";
import { NotFoundError } from "../core/errors.js";
import { createApproval, createWorker, decideApproval, transitionTask } from "../core/service.js";
import { loadSchedulerInput, planSchedule } from "../dag/index.js";
import { assignTaskToWorker } from "../workspaces/index.js";
import { executeTask, type WorkerExecutionResult, type WorkerProvider } from "../workers/index.js";
import {
  runMergeTrain,
  runTests,
  verifyExecution,
  type MergeTrainResult,
  type TestExecutionResult,
  type VerificationResult,
} from "../verification/index.js";
import { OrchestratorError } from "./errors.js";
import { RunFeatureWaveLoopInputSchema, type RunFeatureWaveLoopInput } from "./types.js";
import { triageIntegrationHalt, type TriageReport } from "../triage/index.js";

export interface WaveLoopDependencies {
  /**
   * Provider factory: one WorkerProvider per task. The loop stays generic —
   * the factory may return a CommandWorkerProvider wrapping a deterministic
   * test script, a coding-agent CLI, or any other WorkerProvider. Atlas
   * cannot tell which, and does not need to: Git diff remains the truth.
   */
  readonly createProvider: (taskId: string) => WorkerProvider;
  /** Optional DB-row tracker (tests use this for cleanup). */
  readonly track?: (model: string, id: string) => void;
}

export interface TaskOutcome {
  readonly taskId: string;
  readonly workerId: string;
  readonly execution: WorkerExecutionResult;
  /** Null unless the provider execution COMPLETED (tests run only then). */
  readonly testRun: TestExecutionResult | null;
  /** Null unless tests ran (verification cites the Atlas-executed run). */
  readonly verification: VerificationResult | null;
}

export interface WaveLoopResult {
  readonly featureId: string;
  readonly repositoryId: string;
  readonly baseCommit: string;
  /** Executed waves in round order; ids in scheduler (sorted) order. */
  readonly waves: string[][];
  /** One entry per executed task, sorted by taskId for stable output. */
  readonly outcomes: TaskOutcome[];
  /** Null when nothing verified (nothing eligible for integration). */
  readonly train: MergeTrainResult | null;
  /**
   * Triage report when the train HALTED, null otherwise. Read-only M13
   * evidence attached by a thin post-halt hook — the loop itself contains
   * no classification logic, and triage never alters the train result.
   */
  readonly triage: TriageReport | null;
}

/**
 * Thin M11 wave-run loop: composes M4/M6/M8/M9 services, duplicates none.
 *
 * Per round: load fresh scheduler input from live DB state → plan → take
 * the first wave → approve + assign + execute concurrently within the wave
 * → Atlas-executed tests → independent verification → VERIFIED tasks become
 * COMPLETED (unblocking dependents on the next re-plan). Rounds repeat until
 * no fresh tasks remain. Verified work then integrates through the
 * approval-gated M9 merge train in wave order.
 *
 * Re-planning schedules remaining work from fresh state. It never rebases
 * or recreates worker branches: later workers stay based on the run's base
 * commit, so overlapping writes can still genuinely conflict in the train
 * (intentional V0.1 behavior). Main is never touched.
 *
 * Per-task operational failures live in `outcomes`. Only genuine
 * loop/configuration failures throw (missing entities, project mismatch,
 * empty feature, exhausted worker pool).
 */
export async function runFeatureWaveLoop(
  raw: unknown,
  deps: WaveLoopDependencies,
  db: PrismaClient = getPrismaClient(),
): Promise<WaveLoopResult> {
  const input: RunFeatureWaveLoopInput = RunFeatureWaveLoopInputSchema.parse(raw);
  const track = deps.track ?? ((): void => undefined);

  const feature = await db.feature.findUnique({ where: { id: input.featureId } });
  if (feature === null) {
    throw new NotFoundError("Feature", input.featureId);
  }
  const repository = await db.repository.findUnique({ where: { id: input.repositoryId } });
  if (repository === null) {
    throw new NotFoundError("Repository", input.repositoryId);
  }
  if (repository.projectId !== feature.projectId) {
    throw new OrchestratorError(`repository ${repository.id} does not belong to the feature's project ${feature.projectId}`);
  }

  const seedRows = await db.task.findMany({ where: { featureId: feature.id }, select: { id: true } });
  if (seedRows.length === 0) {
    throw new OrchestratorError(`feature ${feature.id} has no tasks to run`);
  }
  const seedIds = seedRows.map((row) => row.id);

  // Discover the full set (seeds + transitive prerequisites, cross-feature
  // included) with an empty worker pool, purely to size the worker pool:
  // workers are single-use, so capacity must cover every task, not just
  // one wave's width.
  const discovery = await loadSchedulerInput({ taskIds: seedIds, workerIds: [], maxConcurrency: input.maxConcurrency }, db);
  const allTaskIds = discovery.tasks.map((task) => task.id);

  // The pool is owned by this run: either caller-supplied IDs or one fresh
  // worker per discovered task. Claiming is positional (sorted pool order)
  // so concurrent wave tasks never race for the same worker and unrelated
  // workers are never touched.
  let poolIds: string[];
  if (input.workerIds !== undefined) {
    poolIds = [...input.workerIds].sort();
  } else {
    poolIds = [];
    for (let index = 0; index < allTaskIds.length; index += 1) {
      const worker = await createWorker({}, db);
      track("worker", worker.id);
      poolIds.push(worker.id);
    }
    poolIds.sort();
  }
  let poolCursor = 0;

  const maxRounds = input.maxWaves ?? allTaskIds.length + 1;
  const waves: string[][] = [];
  const outcomesByTask = new Map<string, TaskOutcome>();

  for (let round = 0; round < maxRounds; round += 1) {
    const schedulerInput = await loadSchedulerInput(
      { taskIds: allTaskIds, workerIds: poolIds, maxConcurrency: input.maxConcurrency },
      db,
    );
    const plan = planSchedule(schedulerInput);
    const wave = plan.groups[0]?.tasks ?? [];
    const fresh = wave.filter((id) => !outcomesByTask.has(id));
    if (fresh.length === 0) {
      break;
    }
    if (poolCursor + fresh.length > poolIds.length) {
      throw new OrchestratorError(
        `worker pool exhausted in round ${round}: ${fresh.length} tasks need workers but ${poolIds.length - poolCursor} remain`,
      );
    }
    const waveWorkers = poolIds.slice(poolCursor, poolCursor + fresh.length);
    poolCursor += fresh.length;
    waves.push([...fresh]);
    const results = await Promise.all(
      fresh.map((taskId, index) => runOneTask(db, input, deps, track, taskId, waveWorkers[index] as string)),
    );
    for (const outcome of results) {
      outcomesByTask.set(outcome.taskId, outcome);
    }
  }

  const outcomes = [...outcomesByTask.values()].sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));
  const waveIndexOf = new Map<string, number>();
  waves.forEach((wave, index) => {
    for (const id of wave) {
      if (!waveIndexOf.has(id)) {
        waveIndexOf.set(id, index);
      }
    }
  });

  const verified = outcomes.filter((outcome) => outcome.verification?.verdict === "VERIFIED" && outcome.testRun !== null);
  if (verified.length === 0) {
    await trackTaskEvidence(db, track, outcomes.map((outcome) => outcome.taskId));
    return { featureId: feature.id, repositoryId: repository.id, baseCommit: input.baseCommit, waves, outcomes, train: null, triage: null };
  }

  const trainApproval = await createApproval({ featureId: feature.id }, db);
  track("approval", trainApproval.id);
  await decideApproval(trainApproval.id, { decision: "APPROVED", actor: input.approvalActor }, db);

  const ordered = [...verified].sort((a, b) => {
    const wa = waveIndexOf.get(a.taskId) ?? Number.POSITIVE_INFINITY;
    const wb = waveIndexOf.get(b.taskId) ?? Number.POSITIVE_INFINITY;
    if (wa !== wb) {
      return wa - wb;
    }
    return a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0;
  });
  const train = await runMergeTrain(
    {
      repositoryId: repository.id,
      trainBranch: input.trainBranch,
      trainPath: input.trainPath,
      baseCommit: input.baseCommit,
      approvalId: trainApproval.id,
      items: ordered.map((outcome, index) => ({
        taskId: outcome.taskId,
        workerId: outcome.workerId,
        expectedBaseCommit: input.baseCommit,
        testRunId: (outcome.testRun as TestExecutionResult).testRunId,
        sequence: index,
      })),
      ...(input.testCommand !== undefined ? { testCommand: [...input.testCommand] } : {}),
    },
    db,
  );
  await trackTaskEvidence(db, track, outcomes.map((outcome) => outcome.taskId));
  // Thin M13 post-halt hook: attach read-only triage evidence. Triage can
  // only observe — a triage failure degrades to null and never alters the
  // HALTED train result.
  let triage: TriageReport | null = null;
  if (train.status === "HALTED") {
    try {
      triage = await triageIntegrationHalt(
        {
          repositoryId: repository.id,
          baseCommit: input.baseCommit,
          finalCommit: train.finalCommit,
          items: train.items.map((item) => ({
            taskId: item.taskId,
            workerId: item.workerId,
            status: item.status,
            ...(item.testRunId !== undefined ? { testRunId: item.testRunId } : {}),
            ...(item.mergeCommit !== undefined ? { mergeCommit: item.mergeCommit } : {}),
            ...(item.reason !== undefined ? { reason: item.reason } : {}),
          })),
          scratchParent: join(input.workspaceRoot, "triage"),
        },
        db,
      );
      track("artifact", triage.evidenceRefs.artifactId);
    } catch {
      triage = null;
    }
  }
  return { featureId: feature.id, repositoryId: repository.id, baseCommit: input.baseCommit, waves, outcomes, train, triage };
}

/**
 * Register per-task evidence rows for cleanup. The `track` dependency is a
 * test-hygiene hook (production passes a noop): without it, shared-DB test
 * cleanup would delete tasks before their child rows. Relative order per
 * task (event, testRun, artifact, commit) mirrors the benchmark harness so
 * reverse-order deletion removes children first.
 */
async function trackTaskEvidence(
  db: PrismaClient,
  track: (model: string, id: string) => void,
  taskIds: Iterable<string>,
): Promise<void> {
  for (const taskId of taskIds) {
    for (const row of await db.event.findMany({ where: { taskId }, select: { id: true } })) {
      track("event", row.id);
    }
    for (const row of await db.testRun.findMany({ where: { taskId }, select: { id: true } })) {
      track("testRun", row.id);
    }
    for (const row of await db.artifact.findMany({ where: { taskId }, select: { id: true } })) {
      track("artifact", row.id);
    }
    for (const row of await db.commit.findMany({ where: { taskId }, select: { id: true } })) {
      track("commit", row.id);
    }
  }
}

async function runOneTask(
  db: PrismaClient,
  input: RunFeatureWaveLoopInput,
  deps: WaveLoopDependencies,
  track: (model: string, id: string) => void,
  taskId: string,
  workerId: string,
): Promise<TaskOutcome> {
  const approval = await createApproval({ taskId }, db);
  track("approval", approval.id);
  await decideApproval(approval.id, { decision: "APPROVED", actor: input.approvalActor }, db);

  const assignment = await assignTaskToWorker(
    {
      taskId,
      workerId,
      repositoryId: input.repositoryId,
      workspaceRoot: join(input.workspaceRoot, "ws", taskId),
      base: input.baseCommit,
    },
    db,
  );
  track("workspace", assignment.workspace.id);

  const execution = await executeTask(
    { taskId, workerId, expectedBaseCommit: input.baseCommit },
    deps.createProvider(taskId),
    db,
  );
  if (execution.status !== "COMPLETED") {
    return { taskId, workerId, execution, testRun: null, verification: null };
  }

  const testRun = await runTests(
    {
      taskId,
      workdir: assignment.workspace.path,
      ...(input.testCommand !== undefined ? { command: [...input.testCommand] } : {}),
    },
    db,
  );
  track("testRun", testRun.testRunId);

  const verification = await verifyExecution(
    { taskId, workerId, expectedBaseCommit: input.baseCommit, testRunId: testRun.testRunId },
    db,
  );
  if (verification.verdict === "VERIFIED") {
    await transitionTask(taskId, "COMPLETED", db);
  }
  return { taskId, workerId, execution, testRun, verification };
}
