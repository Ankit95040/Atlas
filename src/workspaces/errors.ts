import { DomainError } from "../core/errors.js";

/**
 * Assignment-layer failures. All extend DomainError (via TaskAssignmentError),
 * so callers can catch TaskAssignmentError for any assignment failure, or the
 * specific subclass. Core NotFoundError and unwrapped pre-side-effect git
 * truth errors (e.g. NotGitRepositoryError) may also surface; they too are
 * DomainErrors.
 */

export class TaskAssignmentError extends DomainError {
  constructor(message: string, code = "TASK_ASSIGNMENT_FAILED") {
    super(code, message);
    this.name = "TaskAssignmentError";
  }
}

export class TaskNotAssignableError extends TaskAssignmentError {
  constructor(taskId: string, detail: string) {
    super(`task ${taskId} cannot be assigned: ${detail}`, "TASK_NOT_ASSIGNABLE");
    this.name = "TaskNotAssignableError";
  }
}

export class WorkerNotAvailableError extends TaskAssignmentError {
  constructor(workerId: string, detail: string) {
    super(`worker ${workerId} is not available: ${detail}`, "WORKER_NOT_AVAILABLE");
    this.name = "WorkerNotAvailableError";
  }
}

export class WorkspaceAlreadyAssignedError extends TaskAssignmentError {
  constructor(detail: string) {
    super(detail, "WORKSPACE_ALREADY_ASSIGNED");
    this.name = "WorkspaceAlreadyAssignedError";
  }
}

export class WorkspaceCreationError extends TaskAssignmentError {
  readonly originalError: unknown;
  readonly cleanupError?: unknown;

  constructor(message: string, options: { originalError?: unknown; cleanupError?: unknown } = {}) {
    super(message, "WORKSPACE_CREATION_FAILED");
    this.name = "WorkspaceCreationError";
    this.originalError = options.originalError;
    if (options.cleanupError !== undefined) {
      this.cleanupError = options.cleanupError;
    }
  }
}
