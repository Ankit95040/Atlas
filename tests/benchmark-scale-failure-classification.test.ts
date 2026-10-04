import { describe, expect, it } from "vitest";
import { classifyScaleFailure } from "../src/benchmark/scale/runner.js";
import type { ScaleRunResult } from "../src/benchmark/scale/types.js";

type Task = ScaleRunResult["tasks"][number];

function task(overrides: Partial<Task> = {}): Task {
  return {
    key: "a",
    taskId: "t",
    workerId: "w",
    status: "COMPLETED",
    workerMs: 1,
    verification: "VERIFIED",
    testStatus: "PASSED",
    error: null,
    errorCode: null,
    ...overrides,
  };
}

function failedTask(error: string, errorCode: Task["errorCode"] = null): Task {
  return task({ status: "FAILED", verification: "NOT_EVALUATED", testStatus: "NOT_RUN", error, errorCode });
}

describe("classifyScaleFailure (M19.2 structured evidence)", () => {
  it("returns NONE for successful runs", () => {
    expect(
      classifyScaleFailure({ success: true, tasks: [task()], integrationStatus: null, verificationFailed: false }),
    ).toBe("NONE");
  });

  it("maps structured TIMEOUT to WORKER_FAILURE, not provider failure", () => {
    expect(
      classifyScaleFailure({
        success: false,
        tasks: [failedTask("command-worker: command failed: command terminated by SIGTERM", "TIMEOUT")],
        integrationStatus: null,
        verificationFailed: false,
      }),
    ).toBe("WORKER_FAILURE");
  });

  it("maps structured EXIT_NONZERO to WORKER_FAILURE", () => {
    expect(
      classifyScaleFailure({
        success: false,
        tasks: [failedTask("command-worker: command failed: command exited with code 1", "EXIT_NONZERO")],
        integrationStatus: null,
        verificationFailed: false,
      }),
    ).toBe("WORKER_FAILURE");
  });

  it("maps structured SPAWN_FAILED to WORKER_FAILURE", () => {
    expect(
      classifyScaleFailure({
        success: false,
        tasks: [failedTask("command-worker: command failed: command failed to start: spawn ENOENT", "SPAWN_FAILED")],
        integrationStatus: null,
        verificationFailed: false,
      }),
    ).toBe("WORKER_FAILURE");
  });

  it("does NOT treat an incidental 3-digit stderr number as a provider failure", () => {
    // M18 false-positive class: "517" inside agent chatter matched 5\d\d.
    expect(
      classifyScaleFailure({
        success: false,
        tasks: [failedTask("command terminated by SIGTERM: output line 517 of the log", "TIMEOUT")],
        integrationStatus: null,
        verificationFailed: false,
      }),
    ).toBe("WORKER_FAILURE");
    expect(
      classifyScaleFailure({
        success: false,
        tasks: [failedTask("command exited with code 1: boom-517", "EXIT_NONZERO")],
        integrationStatus: null,
        verificationFailed: false,
      }),
    ).toBe("WORKER_FAILURE");
  });

  it("maps structured RATE_LIMIT to PROVIDER_FAILURE", () => {
    expect(
      classifyScaleFailure({
        success: false,
        tasks: [failedTask("command-worker: command failed: command exited with code 1", "RATE_LIMIT")],
        integrationStatus: null,
        verificationFailed: false,
      }),
    ).toBe("PROVIDER_FAILURE");
  });

  it("still detects genuine provider failures from text", () => {
    expect(
      classifyScaleFailure({
        success: false,
        tasks: [failedTask("provider returned malformed output: String must contain at most 5000 character(s)")],
        integrationStatus: null,
        verificationFailed: false,
      }),
    ).toBe("PROVIDER_FAILURE");
    expect(
      classifyScaleFailure({
        success: false,
        tasks: [failedTask("command-worker: command failed: command exited with code 1: Error: rate limit exceeded, retry later")],
        integrationStatus: null,
        verificationFailed: false,
      }),
    ).toBe("PROVIDER_FAILURE");
  });

  it("prefers genuine provider text over a structured timeout code", () => {
    // Rate-limited then stalled then killed: the provider signal wins.
    expect(
      classifyScaleFailure({
        success: false,
        tasks: [failedTask("command terminated by SIGTERM: Error: rate limit exceeded", "TIMEOUT")],
        integrationStatus: null,
        verificationFailed: false,
      }),
    ).toBe("PROVIDER_FAILURE");
  });

  it("keeps integration, worker, verification, and unknown outcomes", () => {
    expect(
      classifyScaleFailure({ success: false, tasks: [task()], integrationStatus: "HALTED", verificationFailed: false }),
    ).toBe("INTEGRATION_FAILURE");
    expect(
      classifyScaleFailure({
        success: false,
        tasks: [failedTask("command-worker: command failed: boom")],
        integrationStatus: null,
        verificationFailed: false,
      }),
    ).toBe("WORKER_FAILURE");
    expect(
      classifyScaleFailure({ success: false, tasks: [task()], integrationStatus: null, verificationFailed: true }),
    ).toBe("VERIFICATION_FAILURE");
    expect(
      classifyScaleFailure({ success: false, tasks: [task()], integrationStatus: null, verificationFailed: false }),
    ).toBe("UNKNOWN");
  });
});
