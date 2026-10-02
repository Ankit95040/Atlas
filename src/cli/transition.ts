import { TaskStatus, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { getPrismaClient } from "../db/client.js";
import { recordEvent, transitionTask } from "../core/service.js";
import { EXIT_OK, type CommandOutput } from "./output.js";

function usageError(message: string): Error {
  const error = new Error(message);
  error.name = "TransitionUsageError";
  return error;
}

const TaskTransitionTarget = z.nativeEnum(TaskStatus);

export interface TaskTransitionOptions {
  readonly taskId?: string;
  readonly to?: string;
  readonly actor?: string;
  readonly reason?: string;
}

/**
 * `atlas task transition`: the operator-driven exit from stuck task states.
 * Performs exactly one state-machine edge (enforced by `transitionTask` via
 * `assertTransition` — no new transitions are introduced) and records a
 * `TASK_TRANSITIONED` event with the human's actor and reason so `history`
 * shows who moved the task and why.
 *
 * Typical uses: VERIFICATION-stuck after a REJECTED verdict
 * (`--to IN_PROGRESS` for rework, `--to FAILED` to accept the failure), and
 * orphaned IN_PROGRESS after launcher death (`--to FAILED`, then a second
 * invocation `--to READY` to make the task schedulable again).
 * Terminal states refuse (use a new attempt instead); live RUNNING workers
 * are never touched — inspect first, then decide.
 */
export async function runTaskTransitionCommand(
  options: TaskTransitionOptions,
  db: PrismaClient = getPrismaClient(),
): Promise<CommandOutput> {
  const taskId = options.taskId?.trim() ?? "";
  if (taskId.length === 0) {
    throw usageError("transition requires a task id");
  }
  const parsed = TaskTransitionTarget.safeParse(options.to);
  if (!parsed.success) {
    throw usageError(
      `transition requires --to <one of ${Object.values(TaskStatus).join("|")}>`,
    );
  }
  const actor = options.actor?.trim() ?? "";
  if (actor.length === 0) {
    throw usageError("transition requires --actor <name>: stuck states are only exited by explicit human confirmation");
  }
  const reason = options.reason?.trim() ?? "";
  if (reason.length === 0) {
    throw usageError("transition requires --reason <text>: the reason is recorded on the TASK_TRANSITIONED event");
  }
  const before = await db.task.findUnique({ where: { id: taskId } });
  if (before === null) {
    throw usageError(`task not found: ${taskId}`);
  }
  const previous = before.status;
  const after = await transitionTask(taskId, parsed.data, db);
  await recordEvent(
    {
      type: "TASK_TRANSITIONED",
      featureId: after.featureId,
      taskId: after.id,
      actor,
      payload: { from: previous, to: after.status, reason },
    },
    db,
  );
  const moved = previous === after.status ? " (no-op: already in target state)" : "";
  const human = [
    "atlas task transition",
    `task: ${after.id} (${previous} -> ${after.status})${moved}`,
    `actor: ${actor}`,
    `reason: ${reason}`,
  ].join("\n");
  return {
    exitCode: EXIT_OK,
    human,
    data: {
      taskId: after.id,
      previousStatus: previous,
      resultingStatus: after.status,
      actor,
      reason,
    },
  };
}
