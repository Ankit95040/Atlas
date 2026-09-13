import { join } from "node:path";
import type { PrismaClient } from "@prisma/client";
import { getPrismaClient } from "../../db/client.js";
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
} from "../../core/service.js";
import { createTaskClaims } from "../../claims/index.js";
import { loadSchedulerInput, planSchedule } from "../../dag/index.js";
import { assignTaskToWorker } from "../../workspaces/index.js";
import { executeTask, type WorkerExecutionResult } from "../../workers/index.js";
import { runMergeTrain, runTests, verifyExecution } from "../../verification/index.js";
import type { MergeTrainResult, TestExecutionResult, VerificationResult } from "../../verification/index.js";
import { runFeatureWaveLoop } from "../../orchestrator/index.js";
import { triageIntegrationHalt } from "../../triage/index.js";
import { BenchmarkError } from "../errors.js";
import { ConcurrencyTracker } from "../strategies.js";
import { buildAgentProvider } from "./agent.js";
import { renderSingleAgentPrompt, renderTaskPrompt, type PromptTaskView } from "./prompts.js";
import type { RealAgentConfig, RealWorkloadSpec } from "./types.js";

export interface RealStrategyContext {
  readonly db: PrismaClient;
  readonly workload: RealWorkloadSpec;
  readonly repoDir: string;
  readonly baseCommit: string;
  readonly runId: string;
  readonly scratchRoot: string;
  readonly track: (model: string, id: string) => void;
  readonly agent: RealAgentConfig;
}

export interface RealExecutedTask {
  readonly key: string;
  readonly taskId: string;
  readonly workerId: string;
  readonly execution: WorkerExecutionResult;
  readonly testRun: TestExecutionResult | null;
  readonly verification: VerificationResult | null;
  /**
   * Measured worker time where the arm observes it (SINGLE/DUMB). Null for
   * the ATLAS arm: the shipped loop does not expose per-task timing, and
   * M14 will not invent it.
   */
  readonly workerMs: number | null;
}

export interface RealSchedulingRecord {
  readonly waves: string[][];
  readonly conflicts: [string, string][];
  readonly blocked: { key: string; reason: string }[];
}

export interface RealStrategyOutput {
  readonly executed: RealExecutedTask[];
  readonly integration: MergeTrainResult | null;
  readonly peakConcurrency: number;
  readonly integrationOrder: string[];
  readonly scheduling: RealSchedulingRecord | null;
  /** M13 triage classifications observed on HALTED trains; empty otherwise. */
  readonly triageClassifications: string[];
  readonly triageArtifactIds: string[];
  /** Per-wave base commits (original for V0.1, evolving for V0.2). */
  readonly waveBases?: readonly string[];
}

interface PersistedRealDecomposition {
  readonly projectId: string;
  readonly repositoryId: string;
  readonly featureIds: Map<string, string>;
  readonly taskIds: Map<string, string>;
}

interface RealTaskSpecInput {
  readonly key: string;
  readonly title: string;
  readonly description: string;
  readonly featureKey: string;
  readonly claims: ReadonlyArray<{ resource: string; access: string }>;
  readonly dependsOn: readonly string[];
}

async function persistRealDecomposition(
  ctx: RealStrategyContext,
  specs: RealTaskSpecInput[],
): Promise<PersistedRealDecomposition> {
  const { db, workload, runId, track } = ctx;
  const project = await createProject({ name: `real-bench-${runId}`, description: workload.id }, db);
  track("project", project.id);
  const repository = await createRepository({ projectId: project.id, name: "main", localPath: ctx.repoDir }, db);
  track("repository", repository.id);

  const featureIds = new Map<string, string>();
  for (const feature of workload.features) {
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
    const created = await createTask({ featureId, title: `${spec.title} [${runId}]`, description: spec.title }, db);
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

function promptView(task: { key: string; title: string; description: string; claims: { resource: string; access: string }[] }): PromptTaskView {
  return { key: task.key, title: task.title, description: task.description, claims: task.claims.map((c) => ({ ...c })) };
}

async function trackTaskRecords(ctx: RealStrategyContext, taskId: string): Promise<void> {
  const { db, track } = ctx;
  for (const row of await db.event.findMany({ where: { taskId } })) track("event", row.id);
  for (const row of await db.artifact.findMany({ where: { taskId } })) track("artifact", row.id);
  for (const row of await db.testRun.findMany({ where: { taskId } })) track("testRun", row.id);
  for (const row of await db.commit.findMany({ where: { taskId } })) track("commit", row.id);
}

interface RunOneRealTaskOptions {
  readonly key: string;
  readonly taskId: string;
  readonly repositoryId: string;
  readonly prompt: string;
  readonly testCommand: string[];
  readonly tracker: ConcurrencyTracker;
}

async function runOneRealTask(ctx: RealStrategyContext, options: RunOneRealTaskOptions): Promise<RealExecutedTask> {
  const { db, baseCommit, scratchRoot, track, agent } = ctx;
  const worker = await createWorker({}, db);
  track("worker", worker.id);
  const approval = await createApproval({ taskId: options.taskId }, db);
  track("approval", approval.id);
  await decideApproval(approval.id, { decision: "APPROVED", actor: "real-benchmark" }, db);

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

  const provider = buildAgentProvider(options.prompt, agent);
  const startedAt = Date.now();
  const execution = await options.tracker.run(() =>
    executeTask({ taskId: options.taskId, workerId: worker.id, expectedBaseCommit: baseCommit }, provider, db),
  );
  const workerMs = Date.now() - startedAt;

  if (execution.status !== "COMPLETED") {
    await trackTaskRecords(ctx, options.taskId);
    return { key: options.key, taskId: options.taskId, workerId: worker.id, execution, testRun: null, verification: null, workerMs };
  }

  const testRun = await runTests({ taskId: options.taskId, workdir: assignment.workspace.path, command: [...options.testCommand] }, db);
  track("testRun", testRun.testRunId);
  const verification = await verifyExecution(
    { taskId: options.taskId, workerId: worker.id, expectedBaseCommit: baseCommit, testRunId: testRun.testRunId },
    db,
  );
  await trackTaskRecords(ctx, options.taskId);
  if (verification.verdict === "VERIFIED") {
    await transitionTask(options.taskId, "COMPLETED", db);
  }
  return { key: options.key, taskId: options.taskId, workerId: worker.id, execution, testRun, verification, workerMs };
}

async function integrateRealTasks(
  ctx: RealStrategyContext,
  repositoryId: string,
  featureId: string,
  executed: RealExecutedTask[],
  trainTag: string,
  order: string[],
): Promise<{ integration: MergeTrainResult | null; triageClassifications: string[]; triageArtifactIds: string[] }> {
  const { db, baseCommit, scratchRoot, track, workload } = ctx;
  const approval = await createApproval({ featureId }, db);
  track("approval", approval.id);
  await decideApproval(approval.id, { decision: "APPROVED", actor: "real-benchmark-train" }, db);
  const sequenceOf = (key: string): number => {
    const index = order.indexOf(key);
    if (index < 0) {
      throw new BenchmarkError(`integration order missing task ${key}`);
    }
    return index;
  };
  const verified = executed.filter((task) => task.testRun !== null && task.verification?.verdict === "VERIFIED");
  if (verified.length === 0) {
    for (const task of executed) {
      await trackTaskRecords(ctx, task.taskId);
    }
    return { integration: null, triageClassifications: [], triageArtifactIds: [] };
  }
  const integration = await runMergeTrain(
    {
      repositoryId,
      trainBranch: `atlas/real-benchmark/${ctx.runId}/${trainTag}`,
      trainPath: join(scratchRoot, `train-${trainTag}`),
      baseCommit,
      approvalId: approval.id,
      items: verified.map((task) => ({
        taskId: task.taskId,
        workerId: task.workerId,
        expectedBaseCommit: baseCommit,
        testRunId: (task.testRun as TestExecutionResult).testRunId,
        sequence: sequenceOf(task.key),
      })),
      testCommand: [...workload.testCommand],
    },
    db,
  );
  for (const task of executed) {
    await trackTaskRecords(ctx, task.taskId);
  }
  // Read-only M13 triage on HALTED trains; degrades to empty on any failure.
  let triageClassifications: string[] = [];
  const triageArtifactIds: string[] = [];
  if (integration.status === "HALTED") {
    try {
      const triage = await triageIntegrationHalt(
        {
          repositoryId,
          baseCommit,
          finalCommit: integration.finalCommit,
          items: integration.items.map((item) => ({
            taskId: item.taskId,
            workerId: item.workerId,
            status: item.status,
            ...(item.testRunId !== undefined ? { testRunId: item.testRunId } : {}),
            ...(item.mergeCommit !== undefined ? { mergeCommit: item.mergeCommit } : {}),
            ...(item.reason !== undefined ? { reason: item.reason } : {}),
          })),
          scratchParent: join(scratchRoot, "triage"),
        },
        db,
      );
      triageClassifications = [...triage.classifications];
      triageArtifactIds.push(triage.evidenceRefs.artifactId);
      track("artifact", triage.evidenceRefs.artifactId);
    } catch {
      triageClassifications = [];
    }
  }
  return { integration, triageClassifications, triageArtifactIds };
}

/** SINGLE_AGENT: one synthetic task carrying the union prompt and union claims. */
export async function runRealSingleAgent(ctx: RealStrategyContext): Promise<RealStrategyOutput> {
  const spec = ctx.workload;
  const claimMap = new Map<string, string>();
  const ordered = [...spec.tasks].sort((a, b) => (a.key < b.key ? -1 : 1));
  for (const task of ordered) {
    for (const claim of task.claims) {
      claimMap.set(`${claim.access}:${claim.resource}`, claim.access);
    }
  }
  const unionClaims = [...claimMap.entries()].map(([key, access]) => ({
    resource: key.slice(key.indexOf(":") + 1),
    access,
  }));
  const featureKey = [...spec.features].sort((a, b) => (a.key < b.key ? -1 : 1))[0]?.key;
  if (featureKey === undefined) {
    throw new BenchmarkError("workload has no features");
  }
  const persisted = await persistRealDecomposition(ctx, [
    {
      key: "single",
      title: spec.featureSpec.title,
      description: spec.featureSpec.description,
      featureKey,
      claims: unionClaims,
      dependsOn: [],
    },
  ]);
  const taskId = persisted.taskIds.get("single");
  if (taskId === undefined) {
    throw new BenchmarkError("single-agent task missing after persist");
  }
  const prompt = renderSingleAgentPrompt(ordered.map(promptView), spec.featureSpec.title);
  const tracker = new ConcurrencyTracker();
  const executed = await runOneRealTask(ctx, {
    key: "single",
    taskId,
    repositoryId: persisted.repositoryId,
    prompt,
    testCommand: [...spec.testCommand],
    tracker,
  });
  const featureId = persisted.featureIds.get(featureKey);
  if (featureId === undefined) {
    throw new BenchmarkError(`feature ${featureKey} missing after persist`);
  }
  const singleOrder = ["single"];
  const { integration, triageClassifications, triageArtifactIds } = await integrateRealTasks(
    ctx,
    persisted.repositoryId,
    featureId,
    [executed],
    "single",
    singleOrder,
  );
  return { executed: [executed], integration, peakConcurrency: tracker.peak, integrationOrder: singleOrder, scheduling: null, triageClassifications, triageArtifactIds };
}

/** DUMB_PARALLEL: identical decomposition, concurrent execution, sorted-order train. No scheduler involved. */
export async function runRealDumbParallel(ctx: RealStrategyContext): Promise<RealStrategyOutput> {
  const spec = ctx.workload;
  const persisted = await persistRealDecomposition(
    ctx,
    [...spec.tasks].map((task) => ({
      key: task.key,
      title: task.title,
      description: task.description,
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
        return runOneRealTask(ctx, {
          key: task.key,
          taskId,
          repositoryId: persisted.repositoryId,
          prompt: renderTaskPrompt(promptView(task), spec.featureSpec.title),
          testCommand: [...spec.testCommand],
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
  const { integration, triageClassifications, triageArtifactIds } = await integrateRealTasks(
    ctx,
    persisted.repositoryId,
    firstFeature,
    executed,
    "dumb",
    scenarioOrder,
  );
  return { executed, integration, peakConcurrency: tracker.peak, integrationOrder: scenarioOrder, scheduling: null, triageClassifications, triageArtifactIds };
}

/**
 * ATLAS: the shipped M11 wave loop over the controlled decomposition, with
 * the same shared prompts every other arm uses. Requires single-feature
 * workloads: the loop derives its task set from one feature.
 */
export async function runRealAtlas(ctx: RealStrategyContext): Promise<RealStrategyOutput> {
  const spec = ctx.workload;
  if (spec.features.length !== 1) {
    throw new BenchmarkError("real ATLAS arm requires single-feature workloads");
  }
  const persisted = await persistRealDecomposition(
    ctx,
    [...spec.tasks].sort((a, b) => (a.key < b.key ? -1 : 1)).map((task) => ({
      key: task.key,
      title: task.title,
      description: task.description,
      featureKey: task.featureKey,
      claims: task.claims.map((claim) => ({ resource: claim.resource, access: claim.access })),
      dependsOn: [...task.dependsOn],
    })),
  );
  const idToKey = new Map([...persisted.taskIds.entries()].map(([key, id]) => [id, key] as const));
  const featureId = [...persisted.featureIds.values()].sort()[0];
  if (featureId === undefined) {
    throw new BenchmarkError("no features persisted");
  }

  // Read-only initial scheduling record from the real scheduler (display of
  // the input the loop will consume; executed waves come from the loop).
  const workerIds: string[] = [];
  for (let index = 0; index < spec.tasks.length; index += 1) {
    const worker = await createWorker({}, ctx.db);
    ctx.track("worker", worker.id);
    workerIds.push(worker.id);
  }
  const initialPlan = planSchedule(
    await loadSchedulerInput({ taskIds: [...persisted.taskIds.values()], workerIds, maxConcurrency: spec.tasks.length }, ctx.db),
  );
  const toKey = (id: string): string => idToKey.get(id) ?? id;
  const scheduling: RealSchedulingRecord = {
    waves: initialPlan.groups.map((group) => group.tasks.map(toKey).sort()),
    conflicts: initialPlan.resourceConflicts.map((c) => {
      const a = toKey(c.taskA);
      const b = toKey(c.taskB);
      return (a < b ? [a, b] : [b, a]) as [string, string];
    }),
    blocked: initialPlan.blockedTasks.map((entry) => ({ key: toKey(entry.taskId), reason: entry.reason })),
  };

  const prompts = new Map([...spec.tasks].map((task) => [task.key, renderTaskPrompt(promptView(task), spec.featureSpec.title)]));
  const loop = await runFeatureWaveLoop(
    {
      featureId,
      repositoryId: persisted.repositoryId,
      baseCommit: ctx.baseCommit,
      workspaceRoot: join(ctx.scratchRoot, "atlas-ws"),
      trainBranch: `atlas/real-benchmark/${ctx.runId}/atlas`,
      trainPath: join(ctx.scratchRoot, "train-atlas"),
      approvalActor: "real-benchmark",
      maxConcurrency: spec.tasks.length,
      testCommand: [...spec.testCommand],
    },
    {
      createProvider: (taskId: string) => {
        const key = idToKey.get(taskId);
        const prompt = key !== undefined ? prompts.get(key) : undefined;
        if (key === undefined || prompt === undefined) {
          throw new BenchmarkError(`no shared prompt for task ${taskId}`);
        }
        return buildAgentProvider(prompt, ctx.agent);
      },
      track: ctx.track,
    },
    ctx.db,
  );
  const executed: RealExecutedTask[] = loop.outcomes.map((outcome) => ({
    key: idToKey.get(outcome.taskId) ?? outcome.taskId,
    taskId: outcome.taskId,
    workerId: outcome.workerId,
    execution: outcome.execution,
    testRun: outcome.testRun,
    verification: outcome.verification,
    workerMs: null,
  }));
  const atlasOrder = loop.waves.flat().map(toKey);
  // Observed concurrency: executed wave width. Waves run concurrently inside
  // the loop, so the widest executed wave is the measured peak.
  const peakConcurrency = loop.waves.reduce((peak, wave) => Math.max(peak, wave.length), 0);
  return {
    executed,
    integration: loop.train,
    peakConcurrency,
    integrationOrder: atlasOrder,
    scheduling,
    triageClassifications: loop.triage !== null ? [...loop.triage.classifications] : [],
    triageArtifactIds: [],
    waveBases: loop.waveBases ?? [],
  };
}

/**
 * ATLAS_EVOLVING: same as ATLAS but with evolving integration base.
 * Each wave's workers are cut from the latest successfully integrated train
 * HEAD, so disjoint-line edits to the same file can merge cleanly without
 * changing scheduler decisions.
 */
export async function runRealAtlasEvolving(ctx: RealStrategyContext): Promise<RealStrategyOutput> {
  const spec = ctx.workload;
  if (spec.features.length !== 1) {
    throw new BenchmarkError("real ATLAS_EVOLVING arm requires single-feature workloads");
  }
  const persisted = await persistRealDecomposition(
    ctx,
    [...spec.tasks].sort((a, b) => (a.key < b.key ? -1 : 1)).map((task) => ({
      key: task.key,
      title: task.title,
      description: task.description,
      featureKey: task.featureKey,
      claims: task.claims.map((claim) => ({ resource: claim.resource, access: claim.access })),
      dependsOn: [...task.dependsOn],
    })),
  );
  const idToKey = new Map([...persisted.taskIds.entries()].map(([key, id]) => [id, key] as const));
  const featureId = [...persisted.featureIds.values()].sort()[0];
  if (featureId === undefined) {
    throw new BenchmarkError("no features persisted");
  }

  const workerIds: string[] = [];
  for (let index = 0; index < spec.tasks.length; index += 1) {
    const worker = await createWorker({}, ctx.db);
    ctx.track("worker", worker.id);
    workerIds.push(worker.id);
  }
  const initialPlan = planSchedule(
    await loadSchedulerInput({ taskIds: [...persisted.taskIds.values()], workerIds, maxConcurrency: spec.tasks.length }, ctx.db),
  );
  const toKey = (id: string): string => idToKey.get(id) ?? id;
  const scheduling: RealSchedulingRecord = {
    waves: initialPlan.groups.map((group) => group.tasks.map(toKey).sort()),
    conflicts: initialPlan.resourceConflicts.map((c) => {
      const a = toKey(c.taskA);
      const b = toKey(c.taskB);
      return (a < b ? [a, b] : [b, a]) as [string, string];
    }),
    blocked: initialPlan.blockedTasks.map((entry) => ({ key: toKey(entry.taskId), reason: entry.reason })),
  };

  const prompts = new Map([...spec.tasks].map((task) => [task.key, renderTaskPrompt(promptView(task), spec.featureSpec.title)]));
  const loop = await runFeatureWaveLoop(
    {
      featureId,
      repositoryId: persisted.repositoryId,
      baseCommit: ctx.baseCommit,
      workspaceRoot: join(ctx.scratchRoot, "atlas-ws-evolving"),
      trainBranch: `atlas/real-benchmark/${ctx.runId}/atlas-evolving`,
      trainPath: join(ctx.scratchRoot, "train-atlas-evolving"),
      approvalActor: "real-benchmark",
      maxConcurrency: spec.tasks.length,
      testCommand: [...spec.testCommand],
      baseMode: "evolving",
    },
    {
      createProvider: (taskId: string) => {
        const key = idToKey.get(taskId);
        const prompt = key !== undefined ? prompts.get(key) : undefined;
        if (key === undefined || prompt === undefined) {
          throw new BenchmarkError(`no shared prompt for task ${taskId}`);
        }
        return buildAgentProvider(prompt, ctx.agent);
      },
      track: ctx.track,
    },
    ctx.db,
  );
  const executed: RealExecutedTask[] = loop.outcomes.map((outcome) => ({
    key: idToKey.get(outcome.taskId) ?? outcome.taskId,
    taskId: outcome.taskId,
    workerId: outcome.workerId,
    execution: outcome.execution,
    testRun: outcome.testRun,
    verification: outcome.verification,
    workerMs: null,
  }));
  const atlasOrder = loop.waves.flat().map(toKey);
  const peakConcurrency = loop.waves.reduce((peak, wave) => Math.max(peak, wave.length), 0);
  return {
    executed,
    integration: loop.train,
    peakConcurrency,
    integrationOrder: atlasOrder,
    scheduling,
    triageClassifications: loop.triage !== null ? [...loop.triage.classifications] : [],
    triageArtifactIds: [],
    waveBases: loop.waveBases ?? [],
  };
}
