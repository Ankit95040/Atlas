import { relative } from "node:path";
import { describe, expect, it } from "vitest";
import { NotFoundError } from "../src/core/errors.js";
import {
  createFeature,
  createProject,
  createRepository,
  createTask,
  createWorker,
  transitionTask,
  transitionWorker,
} from "../src/core/service.js";
import {
  buildWorkerBranchName,
  getCurrentBranch,
  getCurrentCommit,
  getWorktree,
  getWorktrees,
  isClean,
  worktreeExists,
} from "../src/git/index.js";
import { getPrismaClient } from "../src/db/client.js";
import {
  TaskAssignmentError,
  TaskNotAssignableError,
  WorkerNotAvailableError,
  WorkspaceAlreadyAssignedError,
  WorkspaceCreationError,
  assignTaskToWorker,
  buildWorkspacePath,
  compensateWorktree,
  getAssignment,
} from "../src/workspaces/index.js";
import { track, uniqueName } from "./domain-helpers.js";
import { initTempRepo, makeTempDir, trackTempPath } from "./git-helpers.js";

const db = getPrismaClient();

async function setupChain(suffix: string, repoDir: string) {
  const project = await createProject({ name: uniqueName(`ws-proj-${suffix}`) });
  track("project", project.id);
  const repository = await createRepository({ projectId: project.id, name: "main", localPath: repoDir });
  track("repository", repository.id);
  const feature = await createFeature({ projectId: project.id, title: `feat-${suffix}` });
  track("feature", feature.id);
  const pending = await createTask({ featureId: feature.id, title: `task-${suffix}` });
  track("task", pending.id);
  const task = await transitionTask(pending.id, "READY");
  const worker = await createWorker({});
  track("worker", worker.id);
  return { project, repository, feature, task, worker };
}

async function makeWorkspaceRoot(name: string): Promise<string> {
  const scratch = await makeTempDir();
  return trackTempPath(`${scratch}/${name}`);
}

async function trackTaskEvents(taskId: string): Promise<void> {
  for (const e of await db.event.findMany({ where: { taskId } })) track("event", e.id);
}

describe("workspace assignment service", () => {
  it("assigns an eligible task to an idle worker with a real isolated worktree", async () => {
    const repoDir = await initTempRepo();
    const { project, repository, task, worker } = await setupChain("happy", repoDir);
    const workspaceRoot = await makeWorkspaceRoot( "wsroot");

    const headBefore = await getCurrentCommit(repoDir);
    const result = await assignTaskToWorker({
      taskId: task.id,
      workerId: worker.id,
      repositoryId: repository.id,
      workspaceRoot,
    });
    track("workspace", result.workspace.id);

    expect(result.alreadyAssigned).toBe(false);
    expect(result.task.status).toBe("CLAIMED");
    expect(result.worker.status).toBe("ASSIGNED");
    expect(result.worker.taskId).toBe(task.id);
    expect(result.workspace.status).toBe("READY");
    expect(result.workspace.workerId).toBe(worker.id);
    expect(result.workspace.path).toBe(
      buildWorkspacePath(workspaceRoot, project.id, worker.id, task.id),
    );
    expect(result.workspace.branch).toBe(buildWorkerBranchName(worker.id, task.id));

    expect(await worktreeExists(repoDir, result.workspace.path)).toBe(true);
    const live = await getWorktree(repoDir, result.workspace.path);
    expect(live.branch).toBe(result.workspace.branch);
    expect(live.commit).toBe(headBefore);
    expect(result.worktree.commit).toBe(headBefore);

    const events = await db.event.findMany({ where: { taskId: task.id, type: "TASK_ASSIGNED" } });
    expect(events).toHaveLength(1);
    track("event", events[0].id);
    const payload = JSON.parse(events[0].payload ?? "{}");
    expect(payload).toMatchObject({
      taskId: task.id,
      workerId: worker.id,
      workspaceId: result.workspace.id,
      branch: result.workspace.branch,
      path: result.workspace.path,
    });

    // Main repository untouched: same HEAD, still main, still clean.
    expect(await getCurrentCommit(repoDir)).toBe(headBefore);
    expect(await getCurrentBranch(repoDir)).toBe("main");
    expect(await isClean(repoDir)).toBe(true);
  });

  it("returns the existing assignment on repeat requests without side effects", async () => {
    const repoDir = await initTempRepo();
    const { task, worker, repository } = await setupChain("idem", repoDir);
    const workspaceRoot = await makeWorkspaceRoot( "wsroot");
    const input = { taskId: task.id, workerId: worker.id, repositoryId: repository.id, workspaceRoot };

    const first = await assignTaskToWorker(input);
    track("workspace", first.workspace.id);
    await trackTaskEvents(task.id);
    const eventCount = await db.event.count({ where: { taskId: task.id, type: "TASK_ASSIGNED" } });
    const listed = await getWorktrees(repoDir);

    const second = await assignTaskToWorker(input);
    expect(second.alreadyAssigned).toBe(true);
    expect(second.workspace.id).toBe(first.workspace.id);
    expect(second.worktree.path).toBe(first.worktree.path);

    expect(await db.workspace.count({ where: { workerId: worker.id } })).toBe(1);
    expect(await getWorktrees(repoDir)).toHaveLength(listed.length);
    expect(await db.event.count({ where: { taskId: task.id, type: "TASK_ASSIGNED" } })).toBe(eventCount);
  });

  it("rejects completed, cancelled, in-progress, and pending tasks", async () => {
    const repoDir = await initTempRepo();
    const workspaceRoot = await makeWorkspaceRoot( "wsroot");

    const done = await setupChain("done", repoDir);
    await transitionTask(done.task.id, "CLAIMED");
    await transitionTask(done.task.id, "IN_PROGRESS");
    await transitionTask(done.task.id, "VERIFICATION");
    await transitionTask(done.task.id, "COMPLETED");
    await expect(
      assignTaskToWorker({ taskId: done.task.id, workerId: done.worker.id, repositoryId: done.repository.id, workspaceRoot }),
    ).rejects.toThrow(TaskNotAssignableError);

    const cancelled = await setupChain("cancel", repoDir);
    await transitionTask(cancelled.task.id, "CANCELLED");
    await expect(
      assignTaskToWorker({ taskId: cancelled.task.id, workerId: cancelled.worker.id, repositoryId: cancelled.repository.id, workspaceRoot }),
    ).rejects.toThrow(TaskNotAssignableError);

    const running = await setupChain("run", repoDir);
    await transitionTask(running.task.id, "CLAIMED");
    await transitionTask(running.task.id, "IN_PROGRESS");
    await expect(
      assignTaskToWorker({ taskId: running.task.id, workerId: running.worker.id, repositoryId: running.repository.id, workspaceRoot }),
    ).rejects.toThrow(TaskNotAssignableError);

    const pendingChain = await setupChain("pend", repoDir);
    // A fresh PENDING task (setupChain leaves tasks READY) is not assignable.
    const pendingTask = await createTask({ featureId: pendingChain.feature.id, title: "pending-task" });
    track("task", pendingTask.id);
    await expect(
      assignTaskToWorker({ taskId: pendingTask.id, workerId: pendingChain.worker.id, repositoryId: pendingChain.repository.id, workspaceRoot }),
    ).rejects.toThrow(TaskNotAssignableError);
  });

  it("rejects a worker already assigned to another task and unavailable workers", async () => {
    const repoDir = await initTempRepo();
    const workspaceRoot = await makeWorkspaceRoot( "wsroot");
    const first = await setupChain("busy-a", repoDir);
    const assigned = await assignTaskToWorker({
      taskId: first.task.id,
      workerId: first.worker.id,
      repositoryId: first.repository.id,
      workspaceRoot,
    });
    track("workspace", assigned.workspace.id);
    const assignedEvents = await db.event.findMany({ where: { taskId: first.task.id } });
    for (const e of assignedEvents) track("event", e.id);

    const second = await setupChain("busy-b", repoDir);
    await expect(
      assignTaskToWorker({ taskId: second.task.id, workerId: first.worker.id, repositoryId: second.repository.id, workspaceRoot }),
    ).rejects.toThrow(WorkspaceAlreadyAssignedError);
    // No partial state for the losing task.
    expect(await db.workspace.count({ where: { workerId: first.worker.id } })).toBe(1);

    const stopped = await setupChain("stopped", repoDir);
    await transitionWorker(stopped.worker.id, "STOPPED");
    await expect(
      assignTaskToWorker({ taskId: stopped.task.id, workerId: stopped.worker.id, repositoryId: stopped.repository.id, workspaceRoot }),
    ).rejects.toThrow(WorkerNotAvailableError);
  });

  it("rejects a task already claimed by a different worker", async () => {
    const repoDir = await initTempRepo();
    const workspaceRoot = await makeWorkspaceRoot( "wsroot");
    const first = await setupChain("claim-a", repoDir);
    const assigned = await assignTaskToWorker({
      taskId: first.task.id,
      workerId: first.worker.id,
      repositoryId: first.repository.id,
      workspaceRoot,
    });
    track("workspace", assigned.workspace.id);
    for (const e of await db.event.findMany({ where: { taskId: first.task.id } })) track("event", e.id);

    const second = await setupChain("claim-b", repoDir);
    await expect(
      assignTaskToWorker({ taskId: first.task.id, workerId: second.worker.id, repositoryId: first.repository.id, workspaceRoot }),
    ).rejects.toThrow(WorkspaceAlreadyAssignedError);
  });

  it("rejects unknown ids and cross-project repositories", async () => {
    const repoDir = await initTempRepo();
    const workspaceRoot = await makeWorkspaceRoot( "wsroot");
    const chain = await setupChain("rel", repoDir);

    await expect(
      assignTaskToWorker({ taskId: "missing", workerId: chain.worker.id, repositoryId: chain.repository.id, workspaceRoot }),
    ).rejects.toThrow(NotFoundError);
    await expect(
      assignTaskToWorker({ taskId: chain.task.id, workerId: "missing", repositoryId: chain.repository.id, workspaceRoot }),
    ).rejects.toThrow(NotFoundError);
    await expect(
      assignTaskToWorker({ taskId: chain.task.id, workerId: chain.worker.id, repositoryId: "missing", workspaceRoot }),
    ).rejects.toThrow(NotFoundError);

    const other = await setupChain("other-proj", repoDir);
    await expect(
      assignTaskToWorker({ taskId: chain.task.id, workerId: chain.worker.id, repositoryId: other.repository.id, workspaceRoot }),
    ).rejects.toThrow(TaskAssignmentError);
  });

  it("leaves no fake workspace when git worktree creation fails", async () => {
    const repoDir = await initTempRepo();
    const { task, worker, repository } = await setupChain("gitfail", repoDir);
    const workspaceRoot = await makeWorkspaceRoot( "wsroot");

    await expect(
      assignTaskToWorker({ taskId: task.id, workerId: worker.id, repositoryId: repository.id, workspaceRoot, base: "refs/heads/definitely-missing" }),
    ).rejects.toThrow(WorkspaceCreationError);

    expect(await db.workspace.count({ where: { workerId: worker.id } })).toBe(0);
    expect((await db.worker.findUniqueOrThrow({ where: { id: worker.id } })).status).toBe("IDLE");
    expect((await db.task.findUniqueOrThrow({ where: { id: task.id } })).status).toBe("READY");
    expect(await getWorktrees(repoDir)).toHaveLength(1);
  });

  it("compensates the worktree when persistence fails", async () => {
    const repoDir = await initTempRepo();
    const { project, task, worker, repository } = await setupChain("comp", repoDir);
    const workspaceRoot = await makeWorkspaceRoot( "wsroot");
    const expectedPath = buildWorkspacePath(workspaceRoot, project.id, worker.id, task.id);
    const txFailingDb = {
      ...db,
      $transaction: () => Promise.reject(new Error("simulated persistence failure")),
    };

    let caught: unknown;
    try {
      await assignTaskToWorker(
        { taskId: task.id, workerId: worker.id, repositoryId: repository.id, workspaceRoot },
        txFailingDb,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(WorkspaceCreationError);
    const failure = caught as WorkspaceCreationError;
    expect(String((failure.originalError as Error)?.message ?? failure.originalError)).toContain(
      "simulated persistence failure",
    );
    expect(failure.cleanupError).toBeUndefined();

    expect(await worktreeExists(repoDir, expectedPath)).toBe(false);
    expect(await db.workspace.count({ where: { workerId: worker.id } })).toBe(0);
    expect((await db.worker.findUniqueOrThrow({ where: { id: worker.id } })).status).toBe("IDLE");
    expect((await db.task.findUniqueOrThrow({ where: { id: task.id } })).status).toBe("READY");
  });

  it("reports cleanup failure separately when compensation cannot remove the worktree", async () => {
    const repoDir = await initTempRepo();
    const scratch = await makeTempDir();
    const missing = trackTempPath(`${scratch}/never-created`);
    let caught: unknown;
    try {
      await compensateWorktree(repoDir, missing, new Error("original boom"));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(WorkspaceCreationError);
    const failure = caught as WorkspaceCreationError;
    expect((failure.originalError as Error).message).toBe("original boom");
    expect(failure.cleanupError).toBeDefined();
  });

  it("keeps workspaces outside the repository root on a stable deterministic path", async () => {
    const repoDir = await initTempRepo();
    const { project, task, worker, repository } = await setupChain("path", repoDir);
    const workspaceRoot = await makeWorkspaceRoot( "wsroot");

    const again = buildWorkspacePath(workspaceRoot, project.id, worker.id, task.id);
    const expected = buildWorkspacePath(workspaceRoot, project.id, worker.id, task.id);
    expect(again).toBe(expected);

    const result = await assignTaskToWorker({
      taskId: task.id,
      workerId: worker.id,
      repositoryId: repository.id,
      workspaceRoot,
    });
    track("workspace", result.workspace.id);
    await trackTaskEvents(task.id);
    expect(relative(repoDir, result.workspace.path).startsWith("..")).toBe(true);
    expect(() => buildWorkspacePath(workspaceRoot, "../evil", worker.id, task.id)).toThrow(TaskAssignmentError);
    expect(() => buildWorkspacePath("", project.id, worker.id, task.id)).toThrow(TaskAssignmentError);
  });

  it("reuses the git branch naming instead of duplicating it", async () => {
    const repoDir = await initTempRepo();
    const { task, worker, repository } = await setupChain("branch", repoDir);
    const workspaceRoot = await makeWorkspaceRoot( "wsroot");
    const result = await assignTaskToWorker({
      taskId: task.id,
      workerId: worker.id,
      repositoryId: repository.id,
      workspaceRoot,
    });
    track("workspace", result.workspace.id);
    await trackTaskEvents(task.id);
    expect(result.workspace.branch).toBe(buildWorkerBranchName(worker.id, task.id));
  });

  it("supports an explicit base commit for the worktree", async () => {
    const repoDir = await initTempRepo();
    const { task, worker, repository } = await setupChain("base", repoDir);
    const workspaceRoot = await makeWorkspaceRoot( "wsroot");
    const head = await getCurrentCommit(repoDir);
    const result = await assignTaskToWorker({
      taskId: task.id,
      workerId: worker.id,
      repositoryId: repository.id,
      workspaceRoot,
      base: head,
    });
    track("workspace", result.workspace.id);
    await trackTaskEvents(task.id);
    expect(result.worktree.commit).toBe(head);
  });

  it("exposes getAssignment reads without side effects", async () => {
    const repoDir = await initTempRepo();
    const { task, worker, repository } = await setupChain("read", repoDir);
    const workspaceRoot = await makeWorkspaceRoot( "wsroot");

    expect(await getAssignment(task.id, worker.id)).toBeNull();
    expect(await getAssignment(task.id, "missing")).toBeNull();

    const assigned = await assignTaskToWorker({
      taskId: task.id,
      workerId: worker.id,
      repositoryId: repository.id,
      workspaceRoot,
    });
    track("workspace", assigned.workspace.id);
    await trackTaskEvents(task.id);
    const read = await getAssignment(task.id, worker.id);
    expect(read?.workspace.id).toBe(assigned.workspace.id);
    expect(read?.alreadyAssigned).toBe(true);
    expect(read?.worktree.commit).toBe(assigned.worktree.commit);
  });

  it("validates assignment input at the boundary", async () => {
    await expect(assignTaskToWorker({ taskId: "", workerId: "w", repositoryId: "r", workspaceRoot: "/tmp/x" })).rejects.toThrow();
    await expect(assignTaskToWorker({ taskId: "t", workerId: "w", repositoryId: "r", workspaceRoot: "  " })).rejects.toThrow();
  });
});
