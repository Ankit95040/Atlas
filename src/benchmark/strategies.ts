import { join } from "node:path";
import type { PrismaClient } from "@prisma/client";
import { getPrismaClient } from "../db/client.js";
import {
  createApproval,
  createFeature,
  createProject,
  createRepository,
  createTask,
  createTaskDependency,
  createWorker,
  decideApproval,
  transitionTask,
} from "../core/service.js";import { createTaskClaims } from "../claims/index.js";
import { loadSchedulerInput, planSchedule } from "../dag/index.js";
import { FakePlannerProvider, runPlanner } from "../planner/index.js";
import { assignTaskToWorker } from "../workspaces/index.js";
import { FakeWorkerProvider, executeTask } from "../workers/index.js";
import type { WorkerExecutionResult } from "../workers/index.js";
import { runMergeTrain, runTests, verifyExecution } from "../verification/index.js";
import type { MergeTrainResult, TestExecutionResult, VerificationResult } from "../verification/index.js";
import { BenchmarkError } from "./errors.js";
import type { BenchmarkScenario } from "./types.js";

export interface StrategyContext {
  readonly db: PrismaClient;
  readonly scenario: BenchmarkScenario;
  readonly repoDir: string;
  readonly baseCommit: string;
  readonly runId: string;
  readonly scratchRoot: string;
  readonly track: (model: string, id: string) => void;
}

export interface ExecutedTask {
  readonly key: string;
  readonly taskId: string;
  readonly workerId: string;
  readonly workspacePath: string;
  readonly branch: string;
  readonly execution: WorkerExecutionResult;
  readonly testRun: TestExecutionResult;
  readonly verification: VerificationResult;
  readonly workerMs: number;
}

export interface StrategyOutput {
  readonly executed: ExecutedTask[];
  readonly integration: MergeTrainResult;
  readonly peakConcurrency: number;
  /** Effective merge-train sequence actually passed to the train (stable, deterministic). */
  readonly integrationOrder: string[];
}

export interface AtlasOutput extends StrategyOutput {
  readonly waves: string[][];
  readonly conflicts: [string, string][];
  readonly blocked: { key: string; reason: string }[];
}

/** Measures real overlap: peak in-flight executions observed, never assumed. */
export class ConcurrencyTracker {
  private active = 0;
  peak = 0;

  async run<T>(fn: () => Promise<T>): Promise<T> {
    this.active += 1;
    if (this.active > this.peak) {
      this.peak = this.active;
    }
    try {
      return await fn();
    } finally {
      this.active -= 1;
    }
  }
}

interface PersistedDecomposition {
  readonly projectId: string;
  readonly repositoryId: string;
  readonly featureIds: Map<string, string>;
  readonly taskIds: Map<string, string>;
}

interface TaskSpecInput {
  readonly key: string;
  readonly title: string;
  readonly featureKey: string;
  readonly claims: ReadonlyArray<{ resource: string; access: string }>;
  readonly dependsOn: readonly string[];
}

async function persistDecomposition(ctx: StrategyContext, specs: TaskSpecInput[]): Promise<PersistedDecomposition> {
  const { db, scenario, runId, track } = ctx;
  const project = await createProject({ name: `bench-${runId}`, description: scenario.id }, db);
  track("project", project.id);
  const repository = await createRepository({ projectId: project.id, name: "main", localPath: ctx.repoDir }, db);
  track("repository", repository.id);

  const featureIds = new Map<string, string>();
  for (const feature of scenario.features) {
    const created = await createFeature({ projectId: project.id, title: `${feature.title} [${runId}]` }, db);
    track("feature", created.id);
    featureIds.set(feature.key, created.id);
  }

  const taskIds = new Map<string, string>();
  for (const spec of specs) {
    const featureId = featureIds.get(spec.featureKey);
    if (featureId === undefined) {
      throw new BenchmarkError(`unknown feature ${spec.featureKey} for task ${spec.key}`);
    }
    const created = await createTask({ featureId, title: `${spec.title} [${runId}]` }, db);
    track("task", created.id);
    await transitionTask(created.id, "READY", db);
    await createTaskClaims(
      { taskId: created.id, claims: spec.claims.map((claim) => ({ resource: claim.resource, access: claim.access })) },
      db,
    );
    taskIds.set(spec.key, created.id);
  }
  for (const spec of specs) {
    const taskId = taskIds.get(spec.key);
    if (taskId === undefined) {
      throw new BenchmarkError(`unknown task ${spec.key}`);
    }
    for (const dep of spec.dependsOn) {
      const dependsOnTaskId = taskIds.get(dep);
      if (dependsOnTaskId === undefined) {
        throw new BenchmarkError(`task ${spec.key} depends on unknown task ${dep}`);
      }
      const edge = await createTaskDependency({ taskId, dependsOnTaskId }, db);
      track("taskDependency", edge.id);
    }
  }
  return { projectId: project.id, repositoryId: repository.id, featureIds, taskIds };
}

async function trackTaskRecords(ctx: StrategyContext, taskId: string): Promise<void> {
  const { db, track } = ctx;
  for (const row of await db.event.findMany({ where: { taskId } })) track("event", row.id);
  for (const row of await db.artifact.findMany({ where: { taskId } })) track("artifact", row.id);
  for (const row of await db.testRun.findMany({ where: { taskId } })) track("testRun", row.id);
  for (const row of await db.commit.findMany({ where: { taskId } })) track("commit", row.id);
}

interface RunOneTaskOptions {
  readonly key: string;
  readonly taskId: string;
  readonly testScope?: string;
  readonly repositoryId: string;
  readonly files: Record<string, string>;
  readonly delayMs: number;
  readonly tracker: ConcurrencyTracker;
}

async function runOneTask(ctx: StrategyContext, options: RunOneTaskOptions): Promise<ExecutedTask> {
  const { db, baseCommit, scratchRoot, track } = ctx;
  const worker = await createWorker({}, db);
  track("worker", worker.id);
  const approval = await createApproval({ taskId: options.taskId }, db);
  track("approval", approval.id);
  await decideApproval(approval.id, { decision: "APPROVED", actor: "benchmark" }, db);

  const assignment = await assignTaskToWorker(
    {
      taskId: options.taskId,
      workerId: worker.id,
      repositoryId: options.repositoryId,
      workspaceRoot: join(scratchRoot, "ws", options.key),
    },
    db,
  );
  track("workspace", assignment.workspace.id);
  for (const e of await db.event.findMany({ where: { taskId: options.taskId } })) track("event", e.id);

  const provider = new FakeWorkerProvider({
    files: options.files,
    commitMessage: `bench: ${options.key}`,
    delayMs: options.delayMs,
  });
  const startedAt = Date.now();
  const execution = await options.tracker.run(() =>
    executeTask({ taskId: options.taskId, workerId: worker.id, expectedBaseCommit: baseCommit }, provider, db),
  );
  const workerMs = Date.now() - startedAt;

  const testRun = await runTests(
    {
      taskId: options.taskId,
      workdir: assignment.workspace.path,
      command:
        options.testScope === undefined ? ["node", "check.mjs"] : ["node", "check.mjs", options.testScope],
    },
    db,
  );
  track("testRun", testRun.testRunId);
  const verification = await verifyExecution(
    { taskId: options.taskId, workerId: worker.id, expectedBaseCommit: baseCommit, testRunId: testRun.testRunId },
    db,
  );
  await trackTaskRecords(ctx, options.taskId);
  return {
    key: options.key,
    taskId: options.taskId,
    workerId: worker.id,
    workspacePath: assignment.workspace.path,
    branch: assignment.worktree.branch,
    execution,
    testRun,
    verification,
    workerMs,
  };
}

async function integrateTasks(
  ctx: StrategyContext,
  repositoryId: string,
  featureId: string,
  executed: ExecutedTask[],
  trainTag: string,
  order: string[],
): Promise<MergeTrainResult> {
  const { db, baseCommit, scratchRoot, track } = ctx;
  const approval = await createApproval({ featureId }, db);
  track("approval", approval.id);
  await decideApproval(approval.id, { decision: "APPROVED", actor: "benchmark-train" }, db);
  const sequenceOf = (key: string): number => {
    const index = order.indexOf(key);
    if (index < 0) {
      throw new BenchmarkError(`integration order missing task ${key}`);
    }
    return index;
  };
  const result = await runMergeTrain(
    {
      repositoryId,
      trainBranch: `atlas/benchmark/${ctx.runId}/${trainTag}`,
      trainPath: join(scratchRoot, `train-${trainTag}`),
      baseCommit,
      approvalId: approval.id,
      items: executed.map((task) => ({
        taskId: task.taskId,
        workerId: task.workerId,
        expectedBaseCommit: baseCommit,
        testRunId: task.testRun.testRunId,
        sequence: sequenceOf(task.key),
      })),
      testCommand: ["node", "check.mjs"],
    },
    db,
  );
  for (const task of executed) {
    await trackTaskRecords(ctx, task.taskId);
  }
  return result;
}

function filesOf(spec: { files: ReadonlyArray<{ path: string; content: string }> }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const file of spec.files) {
    out[file.path] = file.content;
  }
  return out;
}

/** SINGLE_AGENT: one synthetic task carrying the union of all files and claims. */
export async function runSingleAgent(ctx: StrategyContext): Promise<StrategyOutput> {
  const spec = ctx.scenario;
  const files: Record<string, string> = {};
  const claimMap = new Map<string, string>();
  let durationMs = 0;
  const ordered = [...spec.tasks].sort((a, b) => (a.key < b.key ? -1 : 1));
  for (const task of ordered) {
    Object.assign(files, filesOf(task));
    for (const claim of task.claims) {
      claimMap.set(`${claim.access}:${claim.resource}`, claim.access);
    }
    durationMs += task.simulatedDurationMs;
  }
  const unionClaims = [...claimMap.entries()].map(([key, access]) => ({
    resource: key.slice(key.indexOf(":") + 1),
    access,
  }));
  const featureKey = [...spec.features].sort((a, b) => (a.key < b.key ? -1 : 1))[0]?.key;
  if (featureKey === undefined) {
    throw new BenchmarkError("scenario has no features");
  }

  const persisted = await persistDecomposition(ctx, [
    { key: "single", title: spec.featureSpec.title, featureKey, claims: unionClaims, dependsOn: [] },
  ]);
  const taskId = persisted.taskIds.get("single");
  if (taskId === undefined) {
    throw new BenchmarkError("single-agent task missing after persist");
  }
  const tracker = new ConcurrencyTracker();
  const executed = await runOneTask(ctx, {
    key: "single",
    taskId,
    repositoryId: persisted.repositoryId,
    files,
    delayMs: durationMs,
    tracker,
  });
  const featureId = persisted.featureIds.get(featureKey);
  if (featureId === undefined) {
    throw new BenchmarkError(`feature ${featureKey} missing after persist`);
  }
  const singleOrder = ["single"] as const;
  const integration = await integrateTasks(ctx, persisted.repositoryId, featureId, [executed], "single", [...singleOrder]);
  return { executed: [executed], integration, peakConcurrency: tracker.peak, integrationOrder: [...singleOrder] };
}

/** DUMB_PARALLEL: identical decomposition, concurrent execution, sorted-order train. No scheduler involved. */
export async function runDumbParallel(ctx: StrategyContext): Promise<StrategyOutput> {
  const spec = ctx.scenario;
  const persisted = await persistDecomposition(
    ctx,
    [...spec.tasks].map((task) => ({
      key: task.key,
      title: task.title,
      featureKey: task.featureKey,
      claims: task.claims.map((claim) => ({ resource: claim.resource, access: claim.access })),
      dependsOn: [...task.dependsOn],
    })),
  );
  const tracker = new ConcurrencyTracker();
  const ordered = [...spec.tasks].sort((a, b) => (a.key < b.key ? -1 : 1));
  const executed = await Promise.all(
    ordered.map((task) =>
      tracker.run(() => {
        const taskId = persisted.taskIds.get(task.key);
        if (taskId === undefined) {
          throw new BenchmarkError(`task ${task.key} missing after persist`);
        }
        return runOneTask(ctx, {
          key: task.key,
          taskId,
          testScope: task.testScope,
          repositoryId: persisted.repositoryId,
          files: filesOf(task),
          delayMs: task.simulatedDurationMs,
          tracker: new ConcurrencyTracker(),
        });
      }),
    ),
  );
  const firstFeature = [...persisted.featureIds.values()].sort()[0];
  if (firstFeature === undefined) {
    throw new BenchmarkError("no features persisted");
  }
  const scenarioOrder = [...spec.tasks].map((task) => task.key).sort();
  const integration = await integrateTasks(ctx, persisted.repositoryId, firstFeature, executed, "dumb", scenarioOrder);
  return { executed, integration, peakConcurrency: tracker.peak, integrationOrder: scenarioOrder };
}

/**
 * ATLAS: planner proposal → validation → persistence → claim-aware wave
 * scheduling → per-wave concurrent execution → ordered merge train.
 */
export async function runAtlas(ctx: StrategyContext): Promise<AtlasOutput> {
  const spec = ctx.scenario;
  const proposal = {
    featureId: `bench-${ctx.runId}`,
    tasks: [...spec.tasks]
      .sort((a, b) => (a.key < b.key ? -1 : 1))
      .map((task) => ({
        id: task.key,
        title: task.title,
        description: `${task.key} work`,
        claims: task.claims.map((claim) => ({ resource: claim.resource, access: claim.access })),
      })),
    dependencies: spec.tasks.flatMap((task) => task.dependsOn.map((dep) => ({ taskId: task.key, dependsOnTaskId: dep }))),
    rationale: "benchmark decomposition",
  };
  const validated = await runPlanner(
    {
      featureId: `bench-${ctx.runId}`,
      title: spec.featureSpec.title,
      description: spec.featureSpec.description,
      resourceIds: [],
      existingTasks: [],
    },
    new FakePlannerProvider(proposal),
  );

  const persisted = await persistDecomposition(
    ctx,
    validated.tasks.map((task) => {
      const original = spec.tasks.find((candidate) => candidate.key === task.id);
      if (original === undefined) {
        throw new BenchmarkError(`validated task ${task.id} not in scenario`);
      }
      return {
        key: original.key,
        title: task.title,
        featureKey: original.featureKey,
        claims: task.claims.map((claim) => ({ resource: claim.resourceId, access: claim.access })),
        dependsOn: validated.dependencies
          .filter((edge) => edge.taskId === task.id)
          .map((edge) => edge.dependsOnTaskId),
      };
    }),
  );

  // One pool of IDLE workers; capacity never artificially serializes.
  const workerIds: string[] = [];
  for (let index = 0; index < spec.tasks.length; index += 1) {
    const worker = await createWorker({}, ctx.db);
    ctx.track("worker", worker.id);
    workerIds.push(worker.id);
  }

  const tracker = new ConcurrencyTracker();
  const byKey = new Map(spec.tasks.map((task) => [task.key, task]));
  const idToKey = new Map([...persisted.taskIds.entries()].map(([key, id]) => [id, key] as const));
  const executedByKey = new Map<string, Awaited<ReturnType<typeof runOneTask>>>();
  const waves: string[][] = [];
  const conflictPairs = new Map<string, [string, string]>();
  let blocked: { key: string; reason: string }[] = [];

  for (let round = 0; round <= spec.tasks.length; round += 1) {
    const input = await loadSchedulerInput(
      { taskIds: [...persisted.taskIds.values()], workerIds, maxConcurrency: spec.tasks.length },
      ctx.db,
    );
    const plan = planSchedule(input);
    for (const conflict of plan.resourceConflicts) {
      const a = idToKey.get(conflict.taskA) ?? conflict.taskA;
      const b = idToKey.get(conflict.taskB) ?? conflict.taskB;
      const pair: [string, string] = a < b ? [a, b] : [b, a];
      conflictPairs.set(`${pair[0]}|${pair[1]}`, pair);
    }
    blocked = plan.blockedTasks.map((entry) => ({
      key: idToKey.get(entry.taskId) ?? entry.taskId,
      reason: entry.reason,
    }));
    const wave = plan.groups[0]?.tasks ?? [];
    if (wave.length === 0) {
      break;
    }
    const waveKeys = wave.map((id) => idToKey.get(id) ?? id).sort();
    const freshKeys = waveKeys.filter((key) => !executedByKey.has(key));
    if (freshKeys.length === 0) {
      break;
    }
    waves.push(waveKeys);
    await Promise.all(
      freshKeys.map((key) =>
        tracker.run(async () => {
          const taskSpec = byKey.get(key);
          const taskId = persisted.taskIds.get(key);
          if (taskSpec === undefined || taskId === undefined) {
            throw new BenchmarkError(`wave references unknown task ${key}`);
          }
          const executed = await runOneTask(ctx, {
            key,
            taskId,
            testScope: taskSpec.testScope,
            repositoryId: persisted.repositoryId,
            files: filesOf(taskSpec),
            delayMs: taskSpec.simulatedDurationMs,
            tracker: new ConcurrencyTracker(),
          });
          executedByKey.set(key, executed);
          if (executed.verification.verdict === "VERIFIED") {
            await transitionTask(taskId, "COMPLETED", ctx.db);
          }
        }),
      ),
    );
  }

  const ordered = [...executedByKey.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
  const firstFeature = [...persisted.featureIds.values()].sort()[0];
  if (firstFeature === undefined) {
    throw new BenchmarkError("no features persisted");
  }
  // Merge sequence derives from the scheduler's wave/task order: waves in
  // execution (round) order, scenario keys sorted within each wave.
  // Scheduling behavior is unchanged; only the resulting order is reused here.
  const atlasOrder = waves.flat();
  const integration = await integrateTasks(ctx, persisted.repositoryId, firstFeature, ordered, "atlas", atlasOrder);
  return {
    executed: ordered,
    integration,
    peakConcurrency: tracker.peak,
    integrationOrder: atlasOrder,
    waves,
    conflicts: [...conflictPairs.values()].sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1)),
    blocked,
  };
}
