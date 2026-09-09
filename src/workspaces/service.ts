import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Prisma } from "@prisma/client";
import type { PrismaClient, Task, Worker } from "@prisma/client";
import { getPrismaClient } from "../db/client.js";
import { NotFoundError } from "../core/errors.js";
import { TASK_TRANSITIONS, WORKER_TRANSITIONS, WORKSPACE_TRANSITIONS, assertTransition } from "../core/transitions.js";
import {
  buildWorkerBranchName,
  createWorktree,
  getWorktree,
  removeWorktree,
  validateRepository,
} from "../git/index.js";
import { AssignTaskInput, buildWorkspacePath, type AssignmentResult } from "./types.js";
import {
  TaskAssignmentError,
  TaskNotAssignableError,
  WorkerNotAvailableError,
  WorkspaceAlreadyAssignedError,
  WorkspaceCreationError,
} from "./errors.js";

type WorkerRow = Pick<Worker, "id" | "status" | "taskId">;

// ---------- Assignment rules (conservative, deterministic) ----------

function taskNotAssignable(task: Pick<Task, "id" | "status">): TaskNotAssignableError {
  return new TaskNotAssignableError(task.id, `status ${task.status} does not allow assignment`);
}

async function assertTaskAssignable(
  db: PrismaClient,
  task: Pick<Task, "id" | "status">,
): Promise<void> {
  if (task.status === "READY") {
    return;
  }
  if (task.status === "CLAIMED") {
    const owner = await db.worker.findUnique({ where: { taskId: task.id } });
    throw new WorkspaceAlreadyAssignedError(
      owner === null
        ? `task ${task.id} is already claimed`
        : `task ${task.id} is already assigned to worker ${owner.id}`,
    );
  }
  throw taskNotAssignable(task);
}

function assertWorkerAvailable(worker: WorkerRow): void {
  if (worker.status === "IDLE" && worker.taskId === null) {
    return;
  }
  if (worker.taskId !== null) {
    throw new WorkspaceAlreadyAssignedError(
      `worker ${worker.id} is already assigned to task ${worker.taskId}`,
    );
  }
  throw new WorkerNotAvailableError(worker.id, `status ${worker.status} is not available for assignment`);
}

// ---------- Compensation (Git + SQLite are not one transaction) ----------

async function tryRemoveWorktree(repoRoot: string, worktreePath: string): Promise<unknown> {
  try {
    await removeWorktree(repoRoot, worktreePath, { force: true });
    return undefined;
  } catch (error) {
    return error;
  }
}

/**
 * Best-effort compensation after persistence fails: remove the just-created
 * worktree so no orphan is left behind. Always throws WorkspaceCreationError
 * carrying the original failure; a failed cleanup is reported separately via
 * `cleanupError` instead of replacing the original error.
 */
export async function compensateWorktree(
  repoRoot: string,
  worktreePath: string,
  originalError: unknown,
): Promise<never> {
  const cleanupError = await tryRemoveWorktree(repoRoot, worktreePath);
  throw new WorkspaceCreationError("assignment persistence failed after the git worktree was created", {
    originalError,
    ...(cleanupError !== undefined ? { cleanupError } : {}),
  });
}

// ---------- Reads ----------

/**
 * Return the completed assignment for a task/worker pair, or null.
 * The worktree is re-read live from Git (source of truth), which also derives
 * the repository root from the workspace path itself — no extra link needed.
 */
export async function getAssignment(
  taskId: string,
  workerId: string,
  db: PrismaClient = getPrismaClient(),
): Promise<AssignmentResult | null> {
  const [task, worker] = await Promise.all([
    db.task.findUnique({ where: { id: taskId } }),
    db.worker.findUnique({ where: { id: workerId }, include: { workspace: true } }),
  ]);
  if (task === null || worker === null || worker.taskId !== task.id || worker.workspace === null) {
    return null;
  }
  const feature = await db.feature.findUnique({ where: { id: task.featureId } });
  if (feature === null) {
    return null;
  }
  const workspace = worker.workspace;
  const repoRoot = await validateRepository(workspace.path);
  const live = await getWorktree(repoRoot, workspace.path);
  return {
    task,
    worker,
    workspace,
    worktree: {
      path: live.path,
      branch: live.branch ?? workspace.branch ?? buildWorkerBranchName(worker.id, task.id),
      commit: live.commit,
    },
    projectId: feature.projectId,
    alreadyAssigned: true,
  };
}

// ---------- Core workflow: Task → Worker → Workspace → Git worktree ----------

/**
 * Explicitly assign a task to a worker with an isolated Git worktree.
 *
 * Flow: validate everything → create worktree (outside any tx) → persist all
 * rows + transitions + TASK_ASSIGNED event in one Prisma transaction → on
 * persistence failure, compensate by removing the new worktree.
 *
 * Idempotent: repeating the identical request returns the existing assignment
 * (alreadyAssigned: true) with zero side effects — no new worktree, row, or
 * event. Assignment is not execution: the task stops at CLAIMED, never
 * IN_PROGRESS.
 */
export async function assignTaskToWorker(
  raw: unknown,
  db: PrismaClient = getPrismaClient(),
): Promise<AssignmentResult> {
  const input = AssignTaskInput.parse(raw);

  const existing = await getAssignment(input.taskId, input.workerId, db);
  if (existing !== null) {
    return existing;
  }

  const [task, worker, repository] = await Promise.all([
    db.task.findUnique({ where: { id: input.taskId } }),
    db.worker.findUnique({ where: { id: input.workerId }, include: { workspace: true } }),
    db.repository.findUnique({ where: { id: input.repositoryId } }),
  ]);
  if (task === null) {
    throw new NotFoundError("Task", input.taskId);
  }
  if (worker === null) {
    throw new NotFoundError("Worker", input.workerId);
  }
  if (repository === null) {
    throw new NotFoundError("Repository", input.repositoryId);
  }
  const feature = await db.feature.findUnique({ where: { id: task.featureId } });
  if (feature === null) {
    throw new NotFoundError("Feature", task.featureId);
  }
  if (repository.projectId !== feature.projectId) {
    throw new TaskAssignmentError(
      `repository ${repository.id} does not belong to the task's project ${feature.projectId}`,
    );
  }
  const projectId = feature.projectId;

  await assertTaskAssignable(db, task);
  assertWorkerAvailable(worker);

  const workspacePath = buildWorkspacePath(input.workspaceRoot, projectId, worker.id, task.id);
  const branch = buildWorkerBranchName(worker.id, task.id);

  try {
    await mkdir(resolve(input.workspaceRoot), { recursive: true });
  } catch (error) {
    throw new WorkspaceCreationError(`cannot prepare workspace root ${input.workspaceRoot}`, {
      originalError: error,
    });
  }

  const repoRoot = await validateRepository(repository.localPath);
  let worktree;
  try {
    worktree = await createWorktree({
      repoPath: repoRoot,
      path: workspacePath,
      branch,
      ...(input.base !== undefined ? { base: input.base } : {}),
    });
  } catch (error) {
    throw new WorkspaceCreationError(`git worktree creation failed for task ${task.id}`, {
      originalError: error,
    });
  }

  try {
    const persisted = await db.$transaction(async (tx) => {
      const freshTask = await tx.task.findUnique({ where: { id: task.id } });
      const freshWorker = await tx.worker.findUnique({ where: { id: worker.id } });
      if (freshTask === null) {
        throw new NotFoundError("Task", task.id);
      }
      if (freshWorker === null) {
        throw new NotFoundError("Worker", worker.id);
      }
      // Re-validate under the transaction: concurrent state changes surface here.
      await assertTaskAssignable(db, freshTask);
      assertWorkerAvailable(freshWorker);

      const created = await tx.workspace.create({
        data: { workerId: worker.id, path: worktree.path, branch },
      });
      assertTransition("Workspace", created.status, "READY", WORKSPACE_TRANSITIONS);
      const workspace = await tx.workspace.update({
        where: { id: created.id },
        data: { status: "READY" },
      });

      assertTransition("Worker", freshWorker.status, "ASSIGNED", WORKER_TRANSITIONS);
      const updatedWorker = await tx.worker.update({
        where: { id: worker.id },
        data: { taskId: task.id, status: "ASSIGNED" },
      });

      assertTransition("Task", freshTask.status, "CLAIMED", TASK_TRANSITIONS);
      const updatedTask = await tx.task.update({
        where: { id: task.id },
        data: { status: "CLAIMED" },
      });

      await tx.event.create({
        data: {
          type: "TASK_ASSIGNED",
          projectId,
          featureId: task.featureId,
          taskId: task.id,
          actor: "atlas-workspace-service",
          payload: JSON.stringify({
            taskId: task.id,
            workerId: worker.id,
            workspaceId: workspace.id,
            projectId,
            repositoryId: repository.id,
            branch,
            path: worktree.path,
            commit: worktree.commit,
            base: input.base ?? "HEAD",
          }),
        },
      });
      return { workspace, updatedWorker, updatedTask };
    });

    return {
      task: persisted.updatedTask,
      worker: persisted.updatedWorker,
      workspace: persisted.workspace,
      worktree: { path: worktree.path, branch, commit: worktree.commit },
      projectId,
      alreadyAssigned: false,
    };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const cleanupError = await tryRemoveWorktree(repoRoot, worktree.path);
      throw new WorkspaceAlreadyAssignedError(
        `conflicting concurrent assignment involving worker ${worker.id}` +
          (cleanupError !== undefined ? "; worktree cleanup also failed and may need manual removal" : ""),
      );
    }
    return compensateWorktree(repoRoot, worktree.path, error);
  }
}
