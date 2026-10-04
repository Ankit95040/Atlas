import { describe, expect, it } from "vitest";
import type { TaskOutcome } from "../src/orchestrator/index.js";
import { toRealExecutedTask } from "../src/benchmark/real/strategies.js";

function baseOutcome(overrides: Partial<TaskOutcome> = {}): TaskOutcome {
  return {
    taskId: "task-1",
    workerId: "worker-1",
    execution: {
      taskId: "task-1",
      workerId: "worker-1",
      status: "COMPLETED",
      changedResources: [],
      undeclaredResources: [],
    },
    testRun: null,
    verification: null,
    ...overrides,
  };
}

describe("toRealExecutedTask (M19.1 workerMs preservation)", () => {
  it("preserves measured workerMs instead of nulling it", () => {
    const mapped = toRealExecutedTask(baseOutcome({ workerMs: 1234 }), "a");
    expect(mapped.key).toBe("a");
    expect(mapped.taskId).toBe("task-1");
    expect(mapped.workerId).toBe("worker-1");
    expect(mapped.workerMs).toBe(1234);
  });

  it("maps a missing measurement to null", () => {
    const mapped = toRealExecutedTask(baseOutcome({}), "a");
    expect(mapped.workerMs).toBeNull();
  });

  it("preserves execution, testRun, and verification references", () => {
    const outcome = baseOutcome({ workerMs: 42 });
    const mapped = toRealExecutedTask(outcome, "a");
    expect(mapped.execution).toBe(outcome.execution);
    expect(mapped.testRun).toBe(outcome.testRun);
    expect(mapped.verification).toBe(outcome.verification);
  });
});
