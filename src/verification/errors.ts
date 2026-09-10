import { DomainError } from "../core/errors.js";

/** No test command configured and none supplied explicitly. */
export class NoTestCommandError extends DomainError {
  constructor(reason: string) {
    super("NO_TEST_COMMAND", reason);
    this.name = "NoTestCommandError";
  }
}

/** The test process itself could not be spawned or observed. */
export class TestExecutionError extends DomainError {
  constructor(reason: string) {
    super("TEST_EXECUTION_FAILED", reason);
    this.name = "TestExecutionError";
  }
}

/** Merge-train run refused: no explicit APPROVED decision on file. */
export class MergeTrainNotApprovedError extends DomainError {
  constructor(reason: string) {
    super("MERGE_TRAIN_NOT_APPROVED", reason);
    this.name = "MergeTrainNotApprovedError";
  }
}
