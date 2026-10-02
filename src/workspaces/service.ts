import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Prisma } from "@prisma/client";
import type { EventType, PrismaClient, Task, Worker } from "@prisma/client";
import { getPrismaClient } from "../db/client.js";
import { NotFoundError } from "../core/errors.js";
import { recordEvent, TERMINAL_WORKER_STATUS_SET, transitionTask, transitionWorker } from "../core/service.js";
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

/** Owners that prove a task is currently being worked. Anything else holding
 * a link is a stale reservation (terminal) or corruption (anything else). */
const LIVE_WORKER_STATUSES: ReadonlySet<string> = new Set(["ASSIGNED", "RUNNING", "VERIFYING"]);

/**
 * M23.1 historical linkage: Worker.taskId is CURRENT ASSIGNMENT ONLY, so a
 * terminal worker's link is null while its history lives on in event
 * payloads (WORKER_ASSIGNED / TASK_ASSIGNED / TASK_STARTED / TASK_COMPLETED
 * / TASK_FAILED / VERIFICATION_COMPLETED all carry workerId). Resolves the
 * latest historically linked worker for read-only display/diagnosis when the
 * live link is absent. Live assignment queries keep using Worker.taskId.
 */
/** Lifecycle event types carrying workerId in their payload (M23.1 historical linkage). */
export const WORKER_LINK_EVENT_TYPES: EventType[] = [
  "WORKER_ASSIGNED",
  "TASK_ASSIGNED",
  "TASK_STARTED",
  "TASK_COMPLETED",
  "TASK_FAILED",
  "VERIFICATION_COMPLETED",
];

/** Extract a workerId from a lifecycle event payload, if present. */
export function payloadWorkerId(payload: string | null): string | null {
  if (payload === null || payload.length === 0) {
    return null;
  }
  try {
    let parsed: unknown = JSON.parse(payload);
    if (typeof parsed === "string") {
      parsed = JSON.parse(parsed);
    }
    const workerId = (parsed as { workerId?: unknown } | null)?.workerId;
    return typeof workerId === "string" && workerId.length > 0 ? workerId : null;
  } catch {
    return null;
  }
}

export async function findHistoricalWorkerId(
  db: PrismaClient,
  taskId: string,
): Promise<string | null> {
  const events = await db.event.findMany({
    where: { taskId, type: { in: WORKER_LINK_EVENT_TYPES } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 25,
  });
  for (const event of events) {
    const workerId = payloadWorkerId(event.payload);
    if (workerId !== null) {
      return workerId;
    }
  }
  return null;
}

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

      // M23.1 assignment-time stale-owner release (defensive backstop): the
      // unique index on Worker.taskId arbitrates CURRENT assignment, but
      // terminal workers may still hold a historical reservation (released
      // eagerly on the success/failure paths, yet reachable here via manual
      // transitions or pre-fix databases). Decide on transactional state,
      // never on the pre-read: a LIVE owner means a genuine concurrent
      // assignment and refuses; a TERMINAL owner is released in this same
      // transaction so a re-executable task is assignable again. The unique
      // constraint remains the final guard — two racers cannot both link.
      const currentOwner = await tx.worker.findUnique({ where: { taskId: task.id } });
      if (currentOwner !== null && currentOwner.id !== worker.id) {
        if (LIVE_WORKER_STATUSES.has(currentOwner.status)) {
          throw new WorkspaceAlreadyAssignedError(
            `task ${task.id} is assigned to live worker ${currentOwner.id} (${currentOwner.status}): concurrent assignment refused, no state changed`,
          );
        }
        if (!TERMINAL_WORKER_STATUS_SET.has(currentOwner.status)) {
          throw new WorkspaceAlreadyAssignedError(
            `task ${task.id} is linked to worker ${currentOwner.id} in unexpected state ${currentOwner.status}: inspect before assigning`,
          );
        }
        await tx.worker.update({ where: { id: currentOwner.id }, data: { taskId: null } });
      }

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
      // M19.5 lifecycle: the worker side of the same assignment.
      await tx.event.create({
        data: {
          type: "WORKER_ASSIGNED",
          projectId,
          featureId: task.featureId,
          taskId: task.id,
          actor: "atlas-workspace-service",
          payload: JSON.stringify({ workerId: worker.id, taskId: task.id, workspaceId: workspace.id }),
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
      const cleanupNote =
        cleanupError !== undefined ? "; worktree cleanup also failed and may need manual removal" : "";
      // M23.1: narrow P2002 classification. The pre-write checks above
      // release stale terminal reservations, so a surviving taskId conflict
      // is a lost race, not a stale link — but say so from evidence, not
      // assumption: re-read the owner and report what is actually there.
      const target = Array.isArray((error.meta as { target?: unknown } | null)?.target)
        ? ((error.meta as { target: unknown }).target as unknown[]).map(String)
        : [];
      if (target.includes("taskId")) {
        const owner = await db.worker.findUnique({ where: { taskId: task.id } }).catch(() => null);
        if (owner !== null && owner.id !== worker.id && LIVE_WORKER_STATUSES.has(owner.status)) {
          throw new WorkspaceAlreadyAssignedError(
            `task ${task.id} is assigned to live worker ${owner.id} (${owner.status}): concurrent assignment refused, no state changed${cleanupNote}`,
          );
        }
        throw new WorkspaceAlreadyAssignedError(
          `concurrent assignment race for task ${task.id}: another assigner linked first and this attempt changed nothing${cleanupNote}`,
        );
      }
      if (target.includes("workerId")) {
        throw new WorkspaceAlreadyAssignedError(
          `worker ${worker.id} already owns a workspace: worker/workspace uniqueness conflict, no state changed${cleanupNote}`,
        );
      }
      throw new WorkspaceAlreadyAssignedError(
        `unique conflict during assignment of task ${task.id} (constraint target: ${target.join(",") || "unknown"}): refusing rather than mislabeling it${cleanupNote}`,
      );
    }
    return compensateWorktree(repoRoot, worktree.path, error);
  }
}

export interface RecoverStrandedAssignmentResult {
  readonly taskId: string;
  readonly workerId: string;
  readonly workspaceId: string;
  readonly previousTaskStatus: string;
  readonly previousWorkerStatus: string;
}

export type RecoveryEligibilityClass =
  | "SAFE_TO_RECOVER"
  | "NOT_SAFE_TO_RECOVER"
  | "TERMINAL_START_NEW_ATTEMPT"
  | "HUMAN_INSPECTION_REQUIRED";

export interface RecoveryEligibility {
  readonly class: RecoveryEligibilityClass;
  readonly reason: string;
  readonly nextCommand?: string;
}

const TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set([
  "COMPLETED",
  "COMPLETED_EMPTY",
  "FAILED",
  "CANCELLED",
]);

/**
 * M21.3 single authoritative recovery-eligibility classifier. Pure: no reads,
 * no writes, no Git, no scheduling, no liveness inference. Both the mutating
 * recovery service and the read-only CLI displays consult this function, so
 * the rule exists in exactly one place.
 *
 * The only SAFE pattern is CLAIMED + linked ASSIGNED worker + workspace:
 * slot acquisition strictly precedes provider invocation, so an ASSIGNED
 * worker provably never ran. Every other pattern either has nothing stranded
 * (NOT_SAFE), is over (TERMINAL — start a new attempt instead), or is
 * ambiguous in a way no automation may resolve (HUMAN_INSPECTION).
 * Unknown future statuses deny by default (NOT_SAFE).
 */
export function classifyRecoveryEligibility(args: {
  taskId: string;
  taskStatus: string;
  worker: { id: string; status: string; taskId: string | null } | null;
  hasWorkspace: boolean;
}): RecoveryEligibility {
  const { taskId, taskStatus, worker, hasWorkspace } = args;
  const notStranded = (guidance: string): string =>
    `task ${taskId} is not stranded (status ${taskStatus}); ${guidance}`;
  if (taskStatus !== "CLAIMED") {
    if (TERMINAL_TASK_STATUSES.has(taskStatus)) {
      return {
        class: "TERMINAL_START_NEW_ATTEMPT",
        reason: notStranded("terminal state — start a new attempt instead of recovering"),
      };
    }
    if (taskStatus === "VERIFICATION") {
      return {
        class: "HUMAN_INSPECTION_REQUIRED",
        reason: notStranded("verification outcome requires human inspection — recovery cannot decide it"),
      };
    }
    if (taskStatus === "IN_PROGRESS") {
      if (worker !== null && worker.status === "RUNNING" && worker.taskId === taskId) {
        return {
          class: "NOT_SAFE_TO_RECOVER",
          reason: notStranded(
            `worker ${worker.id} may still be active — Atlas records no process liveness, so recovery is refused`,
          ),
        };
      }
      return {
        class: "HUMAN_INSPECTION_REQUIRED",
        reason: notStranded("without a matching RUNNING worker the state is inconsistent — inspect before acting"),
      };
    }
    const detail =
      taskStatus === "READY"
        ? "already schedulable"
        : taskStatus === "PENDING"
          ? "not yet scheduled"
          : taskStatus === "BLOCKED"
            ? "gated on dependencies by the scheduler"
            : "in a non-recoverable state";
    return { class: "NOT_SAFE_TO_RECOVER", reason: notStranded(`${detail} — nothing to recover`) };
  }
  if (worker === null || !hasWorkspace) {
    return {
      class: "NOT_SAFE_TO_RECOVER",
      reason: `task ${taskId} has no recoverable assignment (no linked worker/workspace)`,
    };
  }
  if (worker.taskId !== null && worker.taskId !== taskId) {
    return {
      class: "HUMAN_INSPECTION_REQUIRED",
      reason: `worker ${worker.id} is linked to a different task (${worker.taskId}); linkage contradicts task ${taskId} — inspect before acting`,
    };
  }
  if (worker.status !== "ASSIGNED") {
    return {
      class: "NOT_SAFE_TO_RECOVER",
      reason: `worker ${worker.id} is ${worker.status}, not ASSIGNED; a live or completed execution may exist, so recovery is refused`,
    };
  }
  return {
    class: "SAFE_TO_RECOVER",
    reason:
      `task ${taskId} is stranded (status CLAIMED) with a pre-execution assignment: ` +
      `slot acquisition strictly precedes provider invocation, so worker ${worker.id} provably never ran`,
    nextCommand: `atlas recover task ${taskId} --actor <actor>`,
  };
}

/**
 * M20.2b explicit human-confirmed recovery for stranded assignments.
 *
 * Recoverable pattern (and ONLY this pattern): the task is CLAIMED and its
 * linked worker is ASSIGNED, i.e. assignment completed but the execution
 * slot was never acquired — Atlas can prove the provider never ran, because
 * slot acquisition (ASSIGNED→RUNNING) strictly precedes provider invocation.
 * Atlas records no PIDs and performs no liveness probes, so anything else
 * (IN_PROGRESS/RUNNING work that may still be alive, terminal states, tasks
 * without assignments) is rejected rather than guessed at. There is no
 * --force escape: unprovable cases stay stranded by design (a future
 * heartbeat/lease mechanism could extend this boundary).
 *
 * On success, in order: the worker returns to IDLE and is unlinked (safe to
 * retry — a half-finished recovery leaves the worker released, never the
 * task re-armed), the task returns to READY (existing transition edge), and
 * a TASK_RECOVERED event records previous/resulting states. Nothing is
 * deleted: the workspace row, worktree, and all history are preserved as
 * evidence for later inspection.
 *
 * Deliberately out of scope: VERIFICATION-stuck tasks (a REJECTED verdict or
 * failed cumulative tests need a human to read the verification evidence and
 * decide between rework and abandonment — no automatic transition exists),
 * and run-level or worker-level recovery commands (a run mixes terminal,
 * live, and stranded tasks, so no uniform safe operation exists; recovery
 * stays per-assignment, the only boundary with proof-grade safety).
 */
export async function recoverStrandedAssignment(
  args: { taskId: string; actor: string },
  db: PrismaClient = getPrismaClient(),
): Promise<RecoverStrandedAssignmentResult> {
  if (args.actor.trim().length === 0) {
    throw new TaskAssignmentError("recovery requires a non-empty actor: pass --actor <name>");
  }
  const task = await db.task.findUnique({ where: { id: args.taskId } });
  if (task === null) {
    throw new NotFoundError("Task", args.taskId);
  }
  const worker = await db.worker.findUnique({ where: { taskId: task.id }, include: { workspace: true } });
  // Single source of truth: the advisory classifier decides, but a stale
  // classification never authorizes mutation — the transition guards below
  // re-validate current state at write time.
  const eligibility = classifyRecoveryEligibility({
    taskId: task.id,
    taskStatus: task.status,
    worker: worker === null ? null : { id: worker.id, status: worker.status, taskId: worker.taskId },
    hasWorkspace: worker?.workspace != null,
  });
  if (eligibility.class !== "SAFE_TO_RECOVER") {
    throw new TaskAssignmentError(eligibility.reason);
  }
  if (worker === null || worker.workspace === null) {
    throw new TaskAssignmentError(`task ${task.id} has no recoverable assignment (no linked worker/workspace)`);
  }

  const previousTaskStatus = task.status;
  const previousWorkerStatus = worker.status;
  await transitionWorker(worker.id, "IDLE", db);
  await db.worker.update({ where: { id: worker.id }, data: { taskId: null } });
  await transitionTask(task.id, "READY", db);
  await recordEvent(
    {
      type: "TASK_RECOVERED",
      featureId: task.featureId,
      taskId: task.id,
      actor: args.actor,
      payload: {
        workerId: worker.id,
        workspaceId: worker.workspace.id,
        previousTaskStatus,
        previousWorkerStatus,
        resultingTaskStatus: "READY",
        resultingWorkerStatus: "IDLE",
      },
    },
    db,
  );
  return {
    taskId: task.id,
    workerId: worker.id,
    workspaceId: worker.workspace.id,
    previousTaskStatus,
    previousWorkerStatus,
  };
}
