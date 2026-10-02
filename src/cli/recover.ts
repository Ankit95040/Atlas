import type { PrismaClient } from "@prisma/client";
import { getPrismaClient } from "../db/client.js";
import { recoverStrandedAssignment } from "../workspaces/index.js";
import { EXIT_OK, type CommandOutput } from "./output.js";

function usageError(message: string): Error {
  const error = new Error(message);
  error.name = "RecoverUsageError";
  return error;
}

export interface RecoverTaskOptions {
  readonly taskId: string;
  readonly actor?: string;
}

/**
 * `atlas recover task`: release one stranded CLAIMED/ASSIGNED assignment so
 * the task becomes schedulable and the worker becomes available again.
 * Human-confirmed by invocation; refuses every other state with the reason.
 * Read-only except for this explicit recovery transition; never deletes rows,
 * worktrees, or history.
 */
export async function runRecoverTaskCommand(
  options: RecoverTaskOptions,
  db: PrismaClient = getPrismaClient(),
): Promise<CommandOutput> {
  if (options.actor === undefined || options.actor.trim().length === 0) {
    throw usageError("recovery requires --actor <name>: stranded assignments are only released by explicit human confirmation");
  }
  const recovered = await recoverStrandedAssignment({ taskId: options.taskId, actor: options.actor }, db);
  const human = [
    "atlas recover task",
    `task: ${recovered.taskId} (${recovered.previousTaskStatus} -> READY)`,
    `worker: ${recovered.workerId} (${recovered.previousWorkerStatus} -> IDLE, unlinked)`,
    `workspace: ${recovered.workspaceId} (preserved for inspection)`,
  ].join("\n");
  return {
    exitCode: EXIT_OK,
    human,
    data: {
      taskId: recovered.taskId,
      workerId: recovered.workerId,
      workspaceId: recovered.workspaceId,
      previousTaskStatus: recovered.previousTaskStatus,
      previousWorkerStatus: recovered.previousWorkerStatus,
      resultingTaskStatus: "READY",
      resultingWorkerStatus: "IDLE",
    },
  };
}
