import { describe, expect, it } from "vitest";
import { NotFoundError } from "../src/core/errors.js";
import {
  createFeature,
  createProject,
  createTask,
  createTaskDependency,
  createWorker,
  transitionTask,
} from "../src/core/service.js";
import { createTaskClaims } from "../src/claims/index.js";
import { getPrismaClient } from "../src/db/client.js";
import { loadSchedulerInput, planSchedule } from "../src/dag/index.js";
import { track, uniqueName } from "./domain-helpers.js";

const db = getPrismaClient();

async function setupProject(suffix: string) {
  const project = await createProject({ name: uniqueName(`dag-${suffix}`) });
  track("project", project.id);
  return project;
}

async function setupFeatureTask(projectId: string, suffix: string) {
  const feature = await createFeature({ projectId, title: `feat-${suffix}` });
  track("feature", feature.id);
  const pending = await createTask({ featureId: feature.id, title: `task-${suffix}` });
  track("task", pending.id);
  const task = await transitionTask(pending.id, "READY");
  return { feature, task };
}

async function completeTask(taskId: string): Promise<void> {
  await transitionTask(taskId, "CLAIMED");
  await transitionTask(taskId, "IN_PROGRESS");
  await transitionTask(taskId, "VERIFICATION");
  await transitionTask(taskId, "COMPLETED");
}

async function setupWorker(): Promise<string> {
  const worker = await createWorker({});
  track("worker", worker.id);
  return worker.id;
}

describe("dag integration across features", () => {
  it("schedules a cross-feature dependency from blocked to ready", async () => {
    const project = await setupProject("xfeat");
    const { task: taskA1 } = await setupFeatureTask(project.id, "xfeat-a");
    const { task: taskB1 } = await setupFeatureTask(project.id, "xfeat-b");
    const workerId = await setupWorker();

    // The M6 regression: B1 (feature B) may depend on A1 (feature A).
    const edge = await createTaskDependency({ taskId: taskB1.id, dependsOnTaskId: taskA1.id });
    track("taskDependency", edge.id);

    const input = await loadSchedulerInput({ taskIds: [taskA1.id, taskB1.id], workerIds: [workerId], maxConcurrency: 2 });
    const before = planSchedule(input);
    expect(before.groups.map((group) => group.tasks)).toEqual([[taskA1.id]]);
    expect(before.blockedTasks).toEqual([
      { taskId: taskB1.id, reason: "BLOCKED_BY_DEPENDENCY", blockedBy: [taskA1.id] },
    ]);

    await completeTask(taskA1.id);
    const after = planSchedule(
      await loadSchedulerInput({ taskIds: [taskA1.id, taskB1.id], workerIds: [workerId], maxConcurrency: 2 }),
    );
    expect(after.groups.map((group) => group.tasks)).toEqual([[taskB1.id]]);
  });

  it("schedules a multi-feature chain one wave at a time", async () => {
    const project = await setupProject("chain");
    const { task: taskA1 } = await setupFeatureTask(project.id, "chain-a1");
    const { task: taskB1 } = await setupFeatureTask(project.id, "chain-b1");
    const { task: taskA2 } = await setupFeatureTask(project.id, "chain-a2");
    const workerId = await setupWorker();

    track("taskDependency", (await createTaskDependency({ taskId: taskB1.id, dependsOnTaskId: taskA1.id })).id);
    track("taskDependency", (await createTaskDependency({ taskId: taskA2.id, dependsOnTaskId: taskB1.id })).id);

    await completeTask(taskA1.id);
    const plan = planSchedule(
      await loadSchedulerInput({ taskIds: [taskA1.id, taskB1.id, taskA2.id], workerIds: [workerId], maxConcurrency: 2 }),
    );
    expect(plan.groups.map((group) => group.tasks)).toEqual([[taskB1.id]]);
    expect(plan.blockedTasks).toContainEqual({
      taskId: taskA2.id,
      reason: "BLOCKED_BY_DEPENDENCY",
      blockedBy: [taskB1.id],
    });
  });

  it("pulls transitive prerequisites into the scheduler input from seeds", async () => {
    const project = await setupProject("closure");
    const { task: taskA } = await setupFeatureTask(project.id, "closure-a");
    const { task: taskB } = await setupFeatureTask(project.id, "closure-b");
    const workerId = await setupWorker();
    track("taskDependency", (await createTaskDependency({ taskId: taskB.id, dependsOnTaskId: taskA.id })).id);

    const input = await loadSchedulerInput({ taskIds: [taskB.id], workerIds: [workerId], maxConcurrency: 1 });
    expect(input.tasks.map((task) => task.id).sort()).toEqual([taskA.id, taskB.id].sort());
    const plan = planSchedule(input);
    expect(plan.blockedTasks).toEqual([{ taskId: taskB.id, reason: "BLOCKED_BY_DEPENDENCY", blockedBy: [taskA.id] }]);
  });

  it("fails clearly on unknown tasks and workers", async () => {
    await expect(loadSchedulerInput({ taskIds: ["missing"], workerIds: [], maxConcurrency: 1 })).rejects.toThrow(
      NotFoundError,
    );
    const project = await setupProject("unknown");
    const { task } = await setupFeatureTask(project.id, "unknown-t");
    await expect(
      loadSchedulerInput({ taskIds: [task.id], workerIds: ["missing"], maxConcurrency: 1 }),
    ).rejects.toThrow(NotFoundError);
  });

  it("serializes persisted claim conflicts without creating fake dependencies", async () => {
    const project = await setupProject("conflict");
    const { task: taskA } = await setupFeatureTask(project.id, "conflict-a");
    const { task: taskB } = await setupFeatureTask(project.id, "conflict-b");
    const workerA = await setupWorker();
    const workerB = await setupWorker();
    await createTaskClaims({ taskId: taskA.id, claims: [{ resource: "src/shared.ts", access: "WRITE" }] });
    await createTaskClaims({ taskId: taskB.id, claims: [{ resource: "src/shared.ts", access: "WRITE" }] });

    const edgesBefore = await db.taskDependency.count();
    const plan = planSchedule(
      await loadSchedulerInput({ taskIds: [taskA.id, taskB.id], workerIds: [workerA, workerB], maxConcurrency: 2 }),
    );
    expect(plan.groups.map((group) => group.tasks)).toEqual([[taskA.id], [taskB.id]]);
    expect(plan.resourceConflicts).toHaveLength(1);
    expect(await db.taskDependency.count()).toBe(edgesBefore);
  });
});
