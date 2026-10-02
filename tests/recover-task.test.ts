import { describe, expect, it } from "vitest";
import { getPrismaClient } from "../src/db/client.js";
import {
  createFeature,
  createProject,
  createRepository,
  createTask,
  createWorker,
  transitionTask,
  transitionWorker,
} from "../src/core/service.js";
import { createTaskClaims } from "../src/claims/index.js";
import {
  assignTaskToWorker,
  classifyRecoveryEligibility,
  recoverStrandedAssignment,
} from "../src/workspaces/index.js";
import { getCurrentCommit, isClean, runGit } from "../src/git/index.js";
import { createProgram } from "../src/cli/index.js";
import { runRecoverTaskCommand } from "../src/cli/recover.js";
import { track, uniqueName } from "./domain-helpers.js";
import { initTempRepo, makeTempDir, trackTempPath } from "./git-helpers.js";

const db = getPrismaClient();

async function setupStranded(suffix: string) {
  const repoDir = await initTempRepo();
  const project = await createProject({ name: uniqueName(`recover-proj-${suffix}`) });
  track("project", project.id);
  const repository = await createRepository({ projectId: project.id, name: "main", localPath: repoDir });
  track("repository", repository.id);
  const feature = await createFeature({ projectId: project.id, title: `recover-feat-${suffix}` });
  track("feature", feature.id);
  const pending = await createTask({ featureId: feature.id, title: `recover-task-${suffix}` });
  track("task", pending.id);
  const ready = await transitionTask(pending.id, "READY", db);
  await createTaskClaims({
    taskId: ready.id,
    claims: [{ resource: "src/a.txt", access: "WRITE" }],
  });
  const worker = await createWorker({});
  track("worker", worker.id);
  const scratch = await makeTempDir();
  const assignment = await assignTaskToWorker({
    taskId: ready.id,
    workerId: worker.id,
    repositoryId: repository.id,
    workspaceRoot: trackTempPath(`${scratch}/wsroot`),
  });
  track("workspace", assignment.workspace.id);
  for (const e of await db.event.findMany({ where: { taskId: ready.id }, select: { id: true } })) {
    track("event", e.id);
  }
  return {
    repoDir,
    baseCommit: await getCurrentCommit(repoDir),
    taskId: ready.id,
    workerId: worker.id,
    repositoryId: repository.id,
    featureId: feature.id,
  };
}

describe("recover stranded assignment (M20.2b)", () => {
  it("recovers a stranded CLAIMED/ASSIGNED task and worker", async () => {
    const ctx = await setupStranded("happy");
    expect((await db.task.findUniqueOrThrow({ where: { id: ctx.taskId } })).status).toBe("CLAIMED");

    const result = await recoverStrandedAssignment({ taskId: ctx.taskId, actor: "operator-ada" }, db);

    expect(result.taskId).toBe(ctx.taskId);
    expect(result.workerId).toBe(ctx.workerId);
    expect(result.previousTaskStatus).toBe("CLAIMED");
    expect(result.previousWorkerStatus).toBe("ASSIGNED");
    expect((await db.task.findUniqueOrThrow({ where: { id: ctx.taskId } })).status).toBe("READY");
    const worker = await db.worker.findUniqueOrThrow({ where: { id: ctx.workerId } });
    expect(worker.status).toBe("IDLE");
    expect(worker.taskId).toBeNull();
    // History preserved plus exactly one recovery event.
    expect(await db.event.count({ where: { taskId: ctx.taskId, type: "TASK_RECOVERED" } })).toBe(1);
    expect(await db.event.count({ where: { taskId: ctx.taskId, type: "TASK_ASSIGNED" } })).toBe(1);
    // No source-code mutation: main untouched and clean.
    expect(await getCurrentCommit(ctx.repoDir)).toBe(ctx.baseCommit);
    expect(await isClean(ctx.repoDir)).toBe(true);
  });

  it("makes the task schedulable and the worker available again", async () => {
    const ctx = await setupStranded("reuse");
    await recoverStrandedAssignment({ taskId: ctx.taskId, actor: "operator-ada" }, db);

    // The released worker is idle and unlinked (available state). Note:
    // Workspace.workerId is unique, so assigning the SAME worker again would
    // require workspace-row lifecycle work outside M20.2b scope; availability
    // here means IDLE + unlinked, and fresh workers assign cleanly.
    const released = await db.worker.findUniqueOrThrow({ where: { id: ctx.workerId } });
    expect(released.status).toBe("IDLE");
    expect(released.taskId).toBeNull();

    // The recovered task accepts a fresh worker.
    const worker2 = await createWorker({});
    track("worker", worker2.id);
    const scratch = await makeTempDir();
    const reassigned = await assignTaskToWorker({
      taskId: ctx.taskId,
      workerId: worker2.id,
      repositoryId: ctx.repositoryId,
      workspaceRoot: trackTempPath(`${scratch}/wsroot`),
    });
    track("workspace", reassigned.workspace.id);
    expect((await db.task.findUniqueOrThrow({ where: { id: ctx.taskId } })).status).toBe("CLAIMED");
    expect((await db.worker.findUniqueOrThrow({ where: { id: worker2.id } })).status).toBe("ASSIGNED");
  });

  it("rejects tasks that are not stranded", async () => {
    const ctx = await setupStranded("terminal");
    // COMPLETED task.
    await transitionTask(ctx.taskId, "IN_PROGRESS", db);
    await transitionTask(ctx.taskId, "VERIFICATION", db);
    await transitionTask(ctx.taskId, "COMPLETED", db);
    await expect(recoverStrandedAssignment({ taskId: ctx.taskId, actor: "op" }, db)).rejects.toThrow(/not stranded/);

    // READY task with no assignment.
    const repoDir = await initTempRepo();
    const project = await createProject({ name: uniqueName("recover-ready-proj") });
    track("project", project.id);
    const feature = await createFeature({ projectId: project.id, title: "f" });
    track("feature", feature.id);
    const pending = await createTask({ featureId: feature.id, title: "ready-task" });
    track("task", pending.id);
    await transitionTask(pending.id, "READY", db);
    await expect(recoverStrandedAssignment({ taskId: pending.id, actor: "op" }, db)).rejects.toThrow();
    void repoDir;
  });

  it("rejects when the worker may still be active", async () => {
    const ctx = await setupStranded("live");
    // Simulate a live execution: slot acquired, provider may be running.
    await transitionTask(ctx.taskId, "IN_PROGRESS", db);
    const { transitionWorker } = await import("../src/core/service.js");
    await transitionWorker(ctx.workerId, "RUNNING", db);
    await expect(recoverStrandedAssignment({ taskId: ctx.taskId, actor: "op" }, db)).rejects.toThrow();
    // Nothing moved.
    expect((await db.task.findUniqueOrThrow({ where: { id: ctx.taskId } })).status).toBe("IN_PROGRESS");
    expect((await db.worker.findUniqueOrThrow({ where: { id: ctx.workerId } })).status).toBe("RUNNING");
  });

  it("rejects missing actor and unknown tasks", async () => {
    const ctx = await setupStranded("actor");
    await expect(recoverStrandedAssignment({ taskId: ctx.taskId, actor: "  " }, db)).rejects.toThrow(/actor/);
    await expect(recoverStrandedAssignment({ taskId: "no-such-task", actor: "op" }, db)).rejects.toThrow();
    expect(await db.event.count({ where: { taskId: ctx.taskId, type: "TASK_RECOVERED" } })).toBe(0);
  });

  it("exposes atlas recover task with a required actor", async () => {
    const program = createProgram();
    const recover = program.commands.find((c) => c.name() === "recover");
    expect(recover?.commands.map((c) => c.name())).toEqual(["task"]);
    await expect(runRecoverTaskCommand({ taskId: "x" })).rejects.toThrow(/actor/);
  });

  it("rejects a PENDING task with nothing stranded", async () => {
    const repoDir = await initTempRepo();
    const baseCommit = await getCurrentCommit(repoDir);
    const project = await createProject({ name: uniqueName("recover-pending-proj") });
    track("project", project.id);
    const feature = await createFeature({ projectId: project.id, title: "recover-pending-feat" });
    track("feature", feature.id);
    const pending = await createTask({ featureId: feature.id, title: "pending-task" });
    track("task", pending.id);

    await expect(recoverStrandedAssignment({ taskId: pending.id, actor: "op" }, db)).rejects.toThrow(
      /not stranded/,
    );
    expect((await db.task.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe("PENDING");
    expect(await db.event.count({ where: { taskId: pending.id, type: "TASK_RECOVERED" } })).toBe(0);
    expect(await getCurrentCommit(repoDir)).toBe(baseCommit);
    expect(await isClean(repoDir)).toBe(true);
  });

  it("rejects a BLOCKED task without touching scheduler state", async () => {
    const repoDir = await initTempRepo();
    const baseCommit = await getCurrentCommit(repoDir);
    const project = await createProject({ name: uniqueName("recover-blocked-proj") });
    track("project", project.id);
    const feature = await createFeature({ projectId: project.id, title: "recover-blocked-feat" });
    track("feature", feature.id);
    const pending = await createTask({ featureId: feature.id, title: "blocked-task" });
    track("task", pending.id);
    for (const to of ["READY", "CLAIMED", "IN_PROGRESS", "BLOCKED"] as const) {
      await transitionTask(pending.id, to, db);
    }

    await expect(recoverStrandedAssignment({ taskId: pending.id, actor: "op" }, db)).rejects.toThrow(
      /not stranded/,
    );
    expect((await db.task.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe("BLOCKED");
    expect(await db.event.count({ where: { taskId: pending.id, type: "TASK_RECOVERED" } })).toBe(0);
    expect(await getCurrentCommit(repoDir)).toBe(baseCommit);
    expect(await isClean(repoDir)).toBe(true);
  });

  it("rejects a VERIFICATION-stuck task without deciding its outcome", async () => {
    const repoDir = await initTempRepo();
    const baseCommit = await getCurrentCommit(repoDir);
    const project = await createProject({ name: uniqueName("recover-verif-proj") });
    track("project", project.id);
    const feature = await createFeature({ projectId: project.id, title: "recover-verif-feat" });
    track("feature", feature.id);
    const pending = await createTask({ featureId: feature.id, title: "stuck-task" });
    track("task", pending.id);
    for (const to of ["READY", "CLAIMED", "IN_PROGRESS", "VERIFICATION"] as const) {
      await transitionTask(pending.id, to, db);
    }

    await expect(recoverStrandedAssignment({ taskId: pending.id, actor: "op" }, db)).rejects.toThrow(
      /not stranded/,
    );
    expect((await db.task.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe("VERIFICATION");
    expect(await db.event.count({ where: { taskId: pending.id, type: "TASK_RECOVERED" } })).toBe(0);
    expect(await getCurrentCommit(repoDir)).toBe(baseCommit);
    expect(await isClean(repoDir)).toBe(true);
  });

  it("stale classification never authorizes mutation (concurrency firewall)", async () => {
    const ctx = await setupStranded("stale");
    // Advisory read first: SAFE on current state. Deliberately unused below.
    const stale = classifyRecoveryEligibility({
      taskId: ctx.taskId,
      taskStatus: "CLAIMED",
      worker: { id: ctx.workerId, status: "ASSIGNED", taskId: ctx.taskId },
      hasWorkspace: true,
    });
    expect(stale.class).toBe("SAFE_TO_RECOVER");
    // State moves on without the classifier: a live execution starts.
    await transitionTask(ctx.taskId, "IN_PROGRESS", db);
    await transitionWorker(ctx.workerId, "RUNNING", db);
    // The service re-reads fresh rows and refuses despite the stale SAFE result.
    await expect(recoverStrandedAssignment({ taskId: ctx.taskId, actor: "op" }, db)).rejects.toThrow();
    expect((await db.task.findUniqueOrThrow({ where: { id: ctx.taskId } })).status).toBe("IN_PROGRESS");
    expect((await db.worker.findUniqueOrThrow({ where: { id: ctx.workerId } })).status).toBe("RUNNING");
    expect(await db.event.count({ where: { taskId: ctx.taskId, type: "TASK_RECOVERED" } })).toBe(0);
  });

  it("recovers once: a second attempt rejects as already schedulable", async () => {
    const ctx = await setupStranded("double");
    const first = await recoverStrandedAssignment({ taskId: ctx.taskId, actor: "op" }, db);
    expect(first.previousTaskStatus).toBe("CLAIMED");

    await expect(recoverStrandedAssignment({ taskId: ctx.taskId, actor: "op" }, db)).rejects.toThrow(
      /not stranded/,
    );
    // State from the first recovery is preserved exactly.
    expect((await db.task.findUniqueOrThrow({ where: { id: ctx.taskId } })).status).toBe("READY");
    expect((await db.worker.findUniqueOrThrow({ where: { id: ctx.workerId } })).status).toBe("IDLE");
    expect(await db.event.count({ where: { taskId: ctx.taskId, type: "TASK_RECOVERED" } })).toBe(1);
    expect(await getCurrentCommit(ctx.repoDir)).toBe(ctx.baseCommit);
    expect(await isClean(ctx.repoDir)).toBe(true);
  });
});

describe("recovery eligibility classifier (M21.3, pure — no database)", () => {
  const worker = (overrides: Record<string, unknown> = {}) => ({
    id: "w1",
    status: "ASSIGNED",
    taskId: "t1",
    ...overrides,
  });

  it("1. CLAIMED + ASSIGNED linked worker is SAFE with the recovery command", () => {
    const result = classifyRecoveryEligibility({ taskId: "t1", taskStatus: "CLAIMED", worker: worker(), hasWorkspace: true });
    expect(result.class).toBe("SAFE_TO_RECOVER");
    expect(result.nextCommand).toBe("atlas recover task t1 --actor <actor>");
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it("2. CLAIMED without a worker is NOT_SAFE", () => {
    const result = classifyRecoveryEligibility({ taskId: "t1", taskStatus: "CLAIMED", worker: null, hasWorkspace: false });
    expect(result.class).toBe("NOT_SAFE_TO_RECOVER");
    expect(result.nextCommand).toBeUndefined();
  });

  it("3. CLAIMED with an inconsistent (IDLE) worker is NOT_SAFE", () => {
    const result = classifyRecoveryEligibility({
      taskId: "t1",
      taskStatus: "CLAIMED",
      worker: worker({ status: "IDLE" }),
      hasWorkspace: true,
    });
    expect(result.class).toBe("NOT_SAFE_TO_RECOVER");
    expect(result.nextCommand).toBeUndefined();
  });

  it("4. READY is NOT_SAFE (already schedulable)", () => {
    const result = classifyRecoveryEligibility({ taskId: "t1", taskStatus: "READY", worker: null, hasWorkspace: false });
    expect(result.class).toBe("NOT_SAFE_TO_RECOVER");
    expect(result.nextCommand).toBeUndefined();
  });

  it("5. PENDING is NOT_SAFE (not scheduled yet)", () => {
    const result = classifyRecoveryEligibility({ taskId: "t1", taskStatus: "PENDING", worker: null, hasWorkspace: false });
    expect(result.class).toBe("NOT_SAFE_TO_RECOVER");
    expect(result.nextCommand).toBeUndefined();
  });

  it("6. BLOCKED is NOT_SAFE (scheduler-gated)", () => {
    const result = classifyRecoveryEligibility({ taskId: "t1", taskStatus: "BLOCKED", worker: null, hasWorkspace: false });
    expect(result.class).toBe("NOT_SAFE_TO_RECOVER");
    expect(result.nextCommand).toBeUndefined();
  });

  it("7. IN_PROGRESS + RUNNING is NOT_SAFE (possibly live)", () => {
    const result = classifyRecoveryEligibility({
      taskId: "t1",
      taskStatus: "IN_PROGRESS",
      worker: worker({ status: "RUNNING" }),
      hasWorkspace: true,
    });
    expect(result.class).toBe("NOT_SAFE_TO_RECOVER");
    expect(result.nextCommand).toBeUndefined();
  });

  it("8. IN_PROGRESS + terminal worker needs inspection", () => {
    const result = classifyRecoveryEligibility({
      taskId: "t1",
      taskStatus: "IN_PROGRESS",
      worker: worker({ status: "FAILED" }),
      hasWorkspace: true,
    });
    expect(result.class).toBe("HUMAN_INSPECTION_REQUIRED");
    expect(result.nextCommand).toBeUndefined();
  });

  it("9. IN_PROGRESS + absent worker needs inspection", () => {
    const result = classifyRecoveryEligibility({ taskId: "t1", taskStatus: "IN_PROGRESS", worker: null, hasWorkspace: true });
    expect(result.class).toBe("HUMAN_INSPECTION_REQUIRED");
    expect(result.nextCommand).toBeUndefined();
  });

  it("10. VERIFICATION needs inspection", () => {
    const result = classifyRecoveryEligibility({ taskId: "t1", taskStatus: "VERIFICATION", worker: worker({ status: "COMPLETED" }), hasWorkspace: true });
    expect(result.class).toBe("HUMAN_INSPECTION_REQUIRED");
    expect(result.nextCommand).toBeUndefined();
  });

  it("11-14. terminal states start new attempts, never recovery", () => {
    for (const status of ["COMPLETED", "COMPLETED_EMPTY", "FAILED", "CANCELLED"]) {
      const result = classifyRecoveryEligibility({ taskId: "t1", taskStatus: status, worker: null, hasWorkspace: false });
      expect(result.class).toBe("TERMINAL_START_NEW_ATTEMPT");
      expect(result.nextCommand).toBeUndefined();
    }
  });

  it("15. contradictory worker linkage needs inspection", () => {
    const result = classifyRecoveryEligibility({
      taskId: "t1",
      taskStatus: "CLAIMED",
      worker: worker({ taskId: "other-task" }),
      hasWorkspace: true,
    });
    expect(result.class).toBe("HUMAN_INSPECTION_REQUIRED");
    expect(result.nextCommand).toBeUndefined();
  });

  it("unknown future statuses deny by default", () => {
    const result = classifyRecoveryEligibility({ taskId: "t1", taskStatus: "SOMEDAY", worker: null, hasWorkspace: false });
    expect(result.class).toBe("NOT_SAFE_TO_RECOVER");
    expect(result.nextCommand).toBeUndefined();
  });
});
