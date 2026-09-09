import { resolve } from "node:path";
import { z } from "zod";
import type { Task, Worker, Workspace } from "@prisma/client";
import { idSchema } from "../core/inputs.js";
import { TaskAssignmentError } from "./errors.js";

export const AssignTaskInput = z.object({
  taskId: idSchema,
  workerId: idSchema,
  repositoryId: idSchema,
  workspaceRoot: z.string().trim().min(1, "workspaceRoot must not be empty"),
  /** Base ref/commit the worktree starts from. Defaults to HEAD. Validated by Git. */
  base: z.string().trim().min(1, "base must not be empty").optional(),
});

export type AssignTaskInput = z.infer<typeof AssignTaskInput>;

export interface WorktreeSnapshot {
  readonly path: string;
  readonly branch: string;
  readonly commit: string;
}

export interface AssignmentResult {
  readonly task: Task;
  readonly worker: Worker;
  readonly workspace: Workspace;
  readonly worktree: WorktreeSnapshot;
  readonly projectId: string;
  /** True when the request matched an existing completed assignment (no side effects). */
  readonly alreadyAssigned: boolean;
}

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function assertPathSegment(label: string, value: string): void {
  if (!SAFE_SEGMENT.test(value)) {
    throw new TaskAssignmentError(
      `cannot build workspace path: ${label} ${JSON.stringify(value)} is not filesystem-safe`,
    );
  }
}

/**
 * Deterministic workspace path strategy:
 *
 *   <workspaceRoot>/<projectId>/<workerId>/<taskId>
 *
 * All segments are validated cuid-style (no separators, no `..`), and the
 * root is resolved to absolute. The result always lies outside any repository
 * because the Git layer independently refuses destinations inside the repo
 * root. Stable: same inputs always yield the same path.
 */
export function buildWorkspacePath(
  workspaceRoot: string,
  projectId: string,
  workerId: string,
  taskId: string,
): string {
  if (workspaceRoot.trim().length === 0) {
    throw new TaskAssignmentError("cannot build workspace path: workspaceRoot must not be empty");
  }
  assertPathSegment("projectId", projectId);
  assertPathSegment("workerId", workerId);
  assertPathSegment("taskId", taskId);
  return resolve(workspaceRoot, projectId, workerId, taskId);
}
