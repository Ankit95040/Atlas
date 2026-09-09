import { describe, expect, it } from "vitest";
import { DomainError, InvalidTransitionError } from "../src/core/errors.js";
import {
  APPROVAL_TRANSITIONS,
  FEATURE_TRANSITIONS,
  PROJECT_TRANSITIONS,
  TASK_TRANSITIONS,
  TEST_RUN_TRANSITIONS,
  WORKER_TRANSITIONS,
  WORKSPACE_TRANSITIONS,
  assertTransition,
} from "../src/core/transitions.js";

describe("domain state machines", () => {
  it("allows the happy-path feature lifecycle", () => {
    const path = ["DRAFT", "PLANNED", "READY", "IN_PROGRESS", "VERIFICATION", "COMPLETED"] as const;
    for (let i = 0; i < path.length - 1; i += 1) {
      expect(() =>
        assertTransition("Feature", path[i] as (typeof path)[number], path[i + 1] as (typeof path)[number], FEATURE_TRANSITIONS),
      ).not.toThrow();
    }
  });

  it("allows the happy-path task lifecycle with claim and verify steps", () => {
    const path = ["PENDING", "READY", "CLAIMED", "IN_PROGRESS", "VERIFICATION", "COMPLETED"] as const;
    for (let i = 0; i < path.length - 1; i += 1) {
      expect(() =>
        assertTransition("Task", path[i] as (typeof path)[number], path[i + 1] as (typeof path)[number], TASK_TRANSITIONS),
      ).not.toThrow();
    }
  });

  it("supports blocking, failure recovery, and claim release on tasks", () => {
    expect(() => assertTransition("Task", "IN_PROGRESS", "BLOCKED", TASK_TRANSITIONS)).not.toThrow();
    expect(() => assertTransition("Task", "BLOCKED", "IN_PROGRESS", TASK_TRANSITIONS)).not.toThrow();
    expect(() => assertTransition("Task", "IN_PROGRESS", "FAILED", TASK_TRANSITIONS)).not.toThrow();
    expect(() => assertTransition("Task", "FAILED", "READY", TASK_TRANSITIONS)).not.toThrow();
    expect(() => assertTransition("Task", "CLAIMED", "READY", TASK_TRANSITIONS)).not.toThrow();
    expect(() => assertTransition("Task", "VERIFICATION", "IN_PROGRESS", TASK_TRANSITIONS)).not.toThrow();
  });

  it("rejects invalid jumps and enforces terminal states", () => {
    expect(() => assertTransition("Task", "PENDING", "COMPLETED", TASK_TRANSITIONS)).toThrow(InvalidTransitionError);
    expect(() => assertTransition("Task", "PENDING", "IN_PROGRESS", TASK_TRANSITIONS)).toThrow(
      InvalidTransitionError,
    );
    expect(() => assertTransition("Task", "COMPLETED", "READY", TASK_TRANSITIONS)).toThrow(InvalidTransitionError);
    expect(() => assertTransition("Task", "CANCELLED", "PENDING", TASK_TRANSITIONS)).toThrow(InvalidTransitionError);
    expect(() => assertTransition("Feature", "DRAFT", "COMPLETED", FEATURE_TRANSITIONS)).toThrow(
      InvalidTransitionError,
    );
    expect(() => assertTransition("Feature", "COMPLETED", "DRAFT", FEATURE_TRANSITIONS)).toThrow(
      InvalidTransitionError,
    );
    expect(() => assertTransition("Approval", "APPROVED", "REJECTED", APPROVAL_TRANSITIONS)).toThrow(
      InvalidTransitionError,
    );
    expect(() => assertTransition("Approval", "PENDING", "PENDING", APPROVAL_TRANSITIONS)).not.toThrow();
  });

  it("treats same-state transitions as idempotent no-ops", () => {
    expect(() => assertTransition("Task", "COMPLETED", "COMPLETED", TASK_TRANSITIONS)).not.toThrow();
    expect(() => assertTransition("Approval", "REJECTED", "REJECTED", APPROVAL_TRANSITIONS)).not.toThrow();
  });

  it("exposes transition errors as domain errors with a stable code", () => {
    try {
      assertTransition("Task", "PENDING", "COMPLETED", TASK_TRANSITIONS);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect(error).toBeInstanceOf(InvalidTransitionError);
      expect((error as DomainError).code).toBe("INVALID_TRANSITION");
    }
  });

  it("covers worker, workspace, test-run, project, and approval lifecycles", () => {
    expect(() => assertTransition("Worker", "IDLE", "ASSIGNED", WORKER_TRANSITIONS)).not.toThrow();
    expect(() => assertTransition("Worker", "RUNNING", "VERIFYING", WORKER_TRANSITIONS)).not.toThrow();
    expect(() => assertTransition("Worker", "VERIFYING", "COMPLETED", WORKER_TRANSITIONS)).not.toThrow();
    expect(() => assertTransition("Worker", "COMPLETED", "IDLE", WORKER_TRANSITIONS)).toThrow(InvalidTransitionError);
    expect(() => assertTransition("Workspace", "CREATING", "READY", WORKSPACE_TRANSITIONS)).not.toThrow();
    expect(() => assertTransition("Workspace", "IN_USE", "VERIFYING", WORKSPACE_TRANSITIONS)).not.toThrow();
    expect(() => assertTransition("Workspace", "CLEANED", "READY", WORKSPACE_TRANSITIONS)).toThrow(
      InvalidTransitionError,
    );
    expect(() => assertTransition("TestRun", "PENDING", "RUNNING", TEST_RUN_TRANSITIONS)).not.toThrow();
    expect(() => assertTransition("TestRun", "RUNNING", "PASSED", TEST_RUN_TRANSITIONS)).not.toThrow();
    expect(() => assertTransition("TestRun", "PENDING", "PASSED", TEST_RUN_TRANSITIONS)).toThrow(
      InvalidTransitionError,
    );
    expect(() => assertTransition("Project", "ACTIVE", "ARCHIVED", PROJECT_TRANSITIONS)).not.toThrow();
    expect(() => assertTransition("Project", "ARCHIVED", "ACTIVE", PROJECT_TRANSITIONS)).toThrow(
      InvalidTransitionError,
    );
    expect(() => assertTransition("Approval", "PENDING", "APPROVED", APPROVAL_TRANSITIONS)).not.toThrow();
  });
});
