import {
  ApprovalStatus,
  FeatureStatus,
  ProjectStatus,
  TaskStatus,
  TestRunStatus,
  WorkerStatus,
  WorkspaceStatus,
} from "@prisma/client";
import { InvalidTransitionError } from "./errors.js";

export type TransitionMap<S extends string> = Record<S, readonly S[]>;

export const PROJECT_TRANSITIONS: TransitionMap<ProjectStatus> = {
  ACTIVE: ["PAUSED", "ARCHIVED"],
  PAUSED: ["ACTIVE", "ARCHIVED"],
  ARCHIVED: [],
};

export const FEATURE_TRANSITIONS: TransitionMap<FeatureStatus> = {
  DRAFT: ["PLANNED", "CANCELLED"],
  PLANNED: ["READY", "CANCELLED"],
  READY: ["IN_PROGRESS", "CANCELLED"],
  IN_PROGRESS: ["VERIFICATION", "CANCELLED"],
  VERIFICATION: ["COMPLETED", "IN_PROGRESS", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
};

export const TASK_TRANSITIONS: TransitionMap<TaskStatus> = {
  PENDING: ["READY", "CANCELLED"],
  READY: ["CLAIMED", "CANCELLED"],
  CLAIMED: ["IN_PROGRESS", "READY", "CANCELLED"],
  IN_PROGRESS: ["BLOCKED", "VERIFICATION", "COMPLETED_EMPTY", "FAILED", "CANCELLED"],
  BLOCKED: ["IN_PROGRESS", "CANCELLED"],
  VERIFICATION: ["COMPLETED", "FAILED", "IN_PROGRESS"],
  COMPLETED: [],
  COMPLETED_EMPTY: [],
  FAILED: ["READY", "CANCELLED"],
  CANCELLED: [],
};

export const WORKER_TRANSITIONS: TransitionMap<WorkerStatus> = {
  IDLE: ["ASSIGNED", "STOPPED"],
  ASSIGNED: ["RUNNING", "IDLE", "STOPPED"],
  RUNNING: ["VERIFYING", "FAILED", "STOPPED"],
  VERIFYING: ["COMPLETED", "FAILED", "STOPPED"],
  COMPLETED: [],
  FAILED: ["IDLE"],
  STOPPED: ["IDLE"],
};

export const WORKSPACE_TRANSITIONS: TransitionMap<WorkspaceStatus> = {
  CREATING: ["READY", "FAILED"],
  READY: ["IN_USE", "CLEANED", "FAILED"],
  IN_USE: ["VERIFYING", "FAILED"],
  VERIFYING: ["CLEANED", "FAILED"],
  CLEANED: [],
  FAILED: ["CLEANED"],
};

export const TEST_RUN_TRANSITIONS: TransitionMap<TestRunStatus> = {
  PENDING: ["RUNNING", "CANCELLED"],
  RUNNING: ["PASSED", "FAILED", "CANCELLED"],
  PASSED: [],
  FAILED: [],
  CANCELLED: [],
};

export const APPROVAL_TRANSITIONS: TransitionMap<ApprovalStatus> = {
  PENDING: ["APPROVED", "REJECTED"],
  APPROVED: [],
  REJECTED: [],
};

/**
 * Assert that `to` is reachable from `from`. Same-state transitions are
 * allowed as idempotent no-ops. Throws InvalidTransitionError otherwise.
 */
export function assertTransition<S extends string>(
  entity: string,
  from: S,
  to: S,
  allowed: TransitionMap<S>,
): void {
  if (from === to) {
    return;
  }
  const next: readonly S[] = allowed[from] ?? [];
  if (!next.includes(to)) {
    throw new InvalidTransitionError(entity, from, to);
  }
}
