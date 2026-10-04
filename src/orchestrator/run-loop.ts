import { join } from "node:path";
import type { PrismaClient } from "@prisma/client";
import { getPrismaClient } from "../db/client.js";
import { NotFoundError } from "../core/errors.js";
import { createApproval, createWorker, decideApproval, recordEvent, transitionTask } from "../core/service.js";
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
import type { IntegratedItem } from "../verification/types.js";

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
  /**
   * Wall-clock ms of the worker execution span (M19.1; Date.now() around
   * executeTask, matching the single-task arm convention). Always set by
   * runOneTask; optional so previously constructed outcomes still typecheck.
   */
  readonly workerMs?: number | null;
  /**
   * Wall-clock ms of the verification span (M19.1); null when verification
   * did not run (execution did not COMPLETE). Optional for compatibility.
   */
  readonly verificationMs?: number | null;
  /**
   * Wall-clock ms of the assignment span (M28.2: worker record + workspace
   * worktree creation). Always set by runOneTask; optional for compatibility.
   * Test-execution span is already on `testRun.durationMs` when tests ran.
   */
  readonly assignMs?: number | null;
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
  /** Per-wave integration base (original for V0.1, evolving trainHead for V0.2). */
  readonly waveBases?: readonly string[];
  /**
   * Wall-clock ms spent in planSchedule per planning round, in round order
   * (M19.1; the live scheduling path re-plans every round, including the
   * terminal round that finds no fresh tasks — so length is waves.length or
   * waves.length + 1). Optional for compatibility; always set by
   * runFeatureWaveLoop.
   */
  readonly schedulingMs?: readonly number[];
  /**
   * Sum of wall-clock ms spent inside `runMergeTrain` across all waves
   * (M28.2; evolving mode integrates per wave, original mode once).
   * Null when no integration ran. Optional for compatibility.
   */
  readonly trainMs?: number | null;
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
  const track = deps.track;

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
  // M19.5 lifecycle: the workflow run itself starts here.
  await recordEvent(
    { type: "WORKFLOW_STARTED", featureId: feature.id, actor: "atlas-wave-loop", payload: { repositoryId: repository.id } },
    db,
  );

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
      track?.("worker", worker.id);
      poolIds.push(worker.id);
    }
    poolIds.sort();
  }
  let poolCursor = 0;

  const maxRounds = input.maxWaves ?? allTaskIds.length + 1;
  const waves: string[][] = [];
  const outcomesByTask = new Map<string, TaskOutcome>();
  const waveBases: string[] = [];
  const schedulingMs: number[] = [];
  // M28.2: summed merge-train wall time across all integrations (evolving
  // per-wave trains plus the final train). Null until one runs.
  let trainMs: number | null = null;
  // Tasks already announced as scheduled (M19.5: exactly-once TASK_SCHEDULED
  // per task even though planning re-runs every round).
  const scheduledTaskIds = new Set<string>();
  const baseMode = input.baseMode ?? "original";

  // Evolving mode tracks the current train head; original mode keeps the
  // initial baseCommit for every wave. The barrier is explicit: next wave
  // starts only after prior wave's integration (if any) is known.
  let currentTrainHead = input.baseCommit;
  let lastTrain: MergeTrainResult | null = null;
  let lastTriage: TriageReport | null = null;
  const evolvingCumulativeItems: IntegratedItem[] = [];

  for (let round = 0; round < maxRounds; round += 1) {
    const schedulerInput = await loadSchedulerInput(
      { taskIds: allTaskIds, workerIds: poolIds, maxConcurrency: input.maxConcurrency },
      db,
    );
    const scheduleStart = Date.now();
    const plan = planSchedule(schedulerInput);
    schedulingMs.push(Date.now() - scheduleStart);
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
    for (const scheduledId of fresh) {
      if (!scheduledTaskIds.has(scheduledId)) {
        scheduledTaskIds.add(scheduledId);
        await recordEvent(
          { type: "TASK_SCHEDULED", featureId: feature.id, taskId: scheduledId, actor: "atlas-wave-loop", payload: { round } },
          db,
        );
      }
    }
    const waveBase = baseMode === "evolving" ? currentTrainHead : input.baseCommit;
    waveBases.push(waveBase);
    const results = await Promise.all(
      fresh.map((taskId, index) => runOneTask(db, input, deps, track, taskId, waveWorkers[index] as string, waveBase)),
    );
    for (const outcome of results) {
      outcomesByTask.set(outcome.taskId, outcome);
    }

    // In evolving mode, integrate each wave immediately so next wave can be
    // cut from the resulting train head. Original mode defers integration
    // until all waves have executed.
    if (baseMode === "evolving") {
      const waveOutcomes = results;
      const verifiedWave = waveOutcomes.filter((o) => o.verification?.verdict === "VERIFIED" && o.testRun !== null);
      if (verifiedWave.length === 0) {
        // No verifiable work in this wave — train head stays, continue to next wave.
        continue;
      }
      const waveTrainApproval = await createApproval({ featureId: feature.id }, db);
      track?.("approval", waveTrainApproval.id);
      await decideApproval(waveTrainApproval.id, { decision: "APPROVED", actor: input.approvalActor }, db);
      const waveTrainStart = Date.now();
      const waveTrain = await runMergeTrain(
        {
          repositoryId: repository.id,
          trainBranch: `${input.trainBranch}/wave-${round}`,
          trainPath: `${input.trainPath}-wave-${round}`,
          baseCommit: waveBase,
          approvalId: waveTrainApproval.id,
          items: verifiedWave.map((outcome, index) => ({
            taskId: outcome.taskId,
            workerId: outcome.workerId,
            expectedBaseCommit: waveBase,
            testRunId: (outcome.testRun as TestExecutionResult).testRunId,
            sequence: index,
          })),
          ...(input.testCommand !== undefined ? { testCommand: [...input.testCommand] } : {}),
        },
        db,
      );
      trainMs = (trainMs ?? 0) + (Date.now() - waveTrainStart);
      await trackTaskEvidence(
        db,
        track,
        waveOutcomes.map((o) => o.taskId),
      );
      if (waveTrain.status === "COMPLETED") {
        currentTrainHead = waveTrain.finalCommit;
        // Accumulate successfully integrated items for the final cumulative result
        for (const item of waveTrain.items) {
          if (item.status === "INTEGRATED") {
            evolvingCumulativeItems.push(item);
          }
        }
        // Keep a synthetic cumulative train representing all waves so far
        lastTrain = {
          ...waveTrain,
          items: [...evolvingCumulativeItems].sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0)),
        };
        lastTriage = null;
      } else {
        // Halt: record triage for this wave and stop scheduling further waves.
        // Cumulative should include prior successful waves plus this halted wave's items
        const haltedItems = [...evolvingCumulativeItems, ...waveTrain.items].sort((a, b) =>
          a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0,
        );
        let triage: TriageReport | null = null;
        try {
          triage = await triageIntegrationHalt(
            {
              repositoryId: repository.id,
              baseCommit: waveBase,
              finalCommit: waveTrain.finalCommit,
              items: waveTrain.items.map((item) => ({
                taskId: item.taskId,
                workerId: item.workerId,
                status: item.status,
                ...(item.testRunId !== undefined ? { testRunId: item.testRunId } : {}),
                ...(item.mergeCommit !== undefined ? { mergeCommit: item.mergeCommit } : {}),
                ...(item.reason !== undefined ? { reason: item.reason } : {}),
                ...(item.emptyMerge !== undefined ? { emptyMerge: item.emptyMerge } : {}),
              })),
              scratchParent: join(input.workspaceRoot, "triage"),
            },
            db,
          );
          track?.("artifact", triage.evidenceRefs.artifactId);
        } catch {
          triage = null;
        }
        lastTrain = {
          ...waveTrain,
          items: haltedItems,
        };
        lastTriage = triage;
        break;
      }
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

  if (baseMode === "evolving") {
    // Evolving mode already integrated per wave. If no verified work at all,
    // there is no train; otherwise return the last wave's train.
    if (lastTrain === null) {
      const anyVerified = outcomes.filter((o) => o.verification?.verdict === "VERIFIED" && o.testRun !== null);
      if (anyVerified.length === 0) {
        await trackTaskEvidence(db, track, outcomes.map((o) => o.taskId));
        await recordEvent(
          { type: "RUN_COMPLETED", featureId: feature.id, actor: "atlas-wave-loop", payload: { waves: waves.length, outcomes: outcomes.length, trainStatus: null } },
          db,
        );
        return {
          featureId: feature.id,
          repositoryId: repository.id,
          baseCommit: input.baseCommit,
          waves,
          outcomes,
          train: null,
          triage: null,
          trainMs,
        };
      }
      // No integration happened (e.g., all verified waves had empty diffs) — fallback to null.
      await trackTaskEvidence(db, track, outcomes.map((o) => o.taskId));
      await recordEvent(
        { type: "RUN_COMPLETED", featureId: feature.id, actor: "atlas-wave-loop", payload: { waves: waves.length, outcomes: outcomes.length, trainStatus: null } },
        db,
      );
      return {
        featureId: feature.id,
        repositoryId: repository.id,
        baseCommit: input.baseCommit,
        waves,
        outcomes,
        train: lastTrain,
        triage: lastTriage,
        waveBases,
        schedulingMs,
        trainMs,
      };
    }
    await trackTaskEvidence(db, track, outcomes.map((o) => o.taskId));
    await recordEvent(
      { type: "RUN_COMPLETED", featureId: feature.id, actor: "atlas-wave-loop", payload: { waves: waves.length, outcomes: outcomes.length, trainStatus: lastTrain?.status ?? null } },
      db,
    );
    return {
      featureId: feature.id,
      repositoryId: repository.id,
      baseCommit: input.baseCommit,
      waves,
      outcomes,
      train: lastTrain,
      triage: lastTriage,
      waveBases,
      schedulingMs,
      trainMs,
    };
  }

  const verified = outcomes.filter((outcome) => outcome.verification?.verdict === "VERIFIED" && outcome.testRun !== null);
  if (verified.length === 0) {
    await trackTaskEvidence(db, track, outcomes.map((outcome) => outcome.taskId));
    await recordEvent(
      { type: "RUN_COMPLETED", featureId: feature.id, actor: "atlas-wave-loop", payload: { waves: waves.length, outcomes: outcomes.length, trainStatus: null } },
      db,
    );
    return { featureId: feature.id, repositoryId: repository.id, baseCommit: input.baseCommit, waves, outcomes, train: null, triage: null, waveBases, schedulingMs, trainMs };
  }

  const trainApproval = await createApproval({ featureId: feature.id }, db);
  track?.("approval", trainApproval.id);
  await decideApproval(trainApproval.id, { decision: "APPROVED", actor: input.approvalActor }, db);

  const ordered = [...verified].sort((a, b) => {
    const wa = waveIndexOf.get(a.taskId) ?? Number.POSITIVE_INFINITY;
    const wb = waveIndexOf.get(b.taskId) ?? Number.POSITIVE_INFINITY;
    if (wa !== wb) {
      return wa - wb;
    }
    return a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0;
  });
  const finalTrainStart = Date.now();
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
  trainMs = (trainMs ?? 0) + (Date.now() - finalTrainStart);
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
            ...(item.emptyMerge !== undefined ? { emptyMerge: item.emptyMerge } : {}),
          })),
          scratchParent: join(input.workspaceRoot, "triage"),
        },
        db,
      );
      track?.("artifact", triage.evidenceRefs.artifactId);
    } catch {
      triage = null;
    }
  }
  await recordEvent(
    { type: "RUN_COMPLETED", featureId: feature.id, actor: "atlas-wave-loop", payload: { waves: waves.length, outcomes: outcomes.length, trainStatus: train.status } },
    db,
  );
  return { featureId: feature.id, repositoryId: repository.id, baseCommit: input.baseCommit, waves, outcomes, train, triage, waveBases, schedulingMs, trainMs };
}

/**
 * Register per-task evidence rows for cleanup. The `track` dependency is a
 * test-hygiene hook (production passes a noop): without it, shared-DB test
 * cleanup would delete tasks before their child rows. Relative order per
 * task (event, testRun, artifact, commit) mirrors the benchmark harness so
 * reverse-order deletion removes children first.
 */
export async function trackTaskEvidence(
  db: PrismaClient,
  track: ((model: string, id: string) => void) | undefined,
  taskIds: Iterable<string>,
): Promise<void> {
  // M29.1: test-hygiene enumeration only. Production passes no tracker, so
  // skip the four per-task evidence queries entirely instead of fetching
  // rows only to discard them. Zero behavior change: a noop tracker
  // consumed exactly these results before. Exported for focused tests.
  if (track === undefined) {
    return;
  }  for (const taskId of taskIds) {
    for (const row of await db.event.findMany({ where: { taskId }, select: { id: true } })) {
      track?.("event", row.id);
    }
    for (const row of await db.testRun.findMany({ where: { taskId }, select: { id: true } })) {
      track?.("testRun", row.id);
    }
    for (const row of await db.artifact.findMany({ where: { taskId }, select: { id: true } })) {
      track?.("artifact", row.id);
    }
    for (const row of await db.commit.findMany({ where: { taskId }, select: { id: true } })) {
      track?.("commit", row.id);
    }
  }
}

async function runOneTask(
  db: PrismaClient,
  input: RunFeatureWaveLoopInput,
  deps: WaveLoopDependencies,
  track: ((model: string, id: string) => void) | undefined,
  taskId: string,
  workerId: string,
  waveBase?: string,
): Promise<TaskOutcome> {
  const baseCommit = waveBase ?? input.baseCommit;
  const approval = await createApproval({ taskId }, db);
  track?.("approval", approval.id);
  await decideApproval(approval.id, { decision: "APPROVED", actor: input.approvalActor }, db);

  const assignStart = Date.now();
  const assignment = await assignTaskToWorker(
    {
      taskId,
      workerId,
      repositoryId: input.repositoryId,
      workspaceRoot: join(input.workspaceRoot, "ws", taskId),
      base: baseCommit,
    },
    db,
  );
  const assignMs = Date.now() - assignStart;
  track?.("workspace", assignment.workspace.id);

  const workerStart = Date.now();
  const execution = await executeTask(
    { taskId, workerId, expectedBaseCommit: baseCommit },
    deps.createProvider(taskId),
    db,
  );
  const workerMs = Date.now() - workerStart;
  if (execution.status !== "COMPLETED") {
    return { taskId, workerId, execution, testRun: null, verification: null, workerMs, verificationMs: null, assignMs };
  }

  const testRun = await runTests(
    {
      taskId,
      workdir: assignment.workspace.path,
      ...(input.testCommand !== undefined ? { command: [...input.testCommand] } : {}),
    },
    db,
  );
  track?.("testRun", testRun.testRunId);

  const verificationStart = Date.now();
  const verification = await verifyExecution(
    { taskId, workerId, expectedBaseCommit: baseCommit, testRunId: testRun.testRunId },
    db,
  );
  const verificationMs = Date.now() - verificationStart;
  if (verification.verdict === "VERIFIED") {
    await transitionTask(taskId, "COMPLETED", db);
  }
  return { taskId, workerId, execution, testRun, verification, workerMs, verificationMs, assignMs };
}
