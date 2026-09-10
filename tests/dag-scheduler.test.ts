import { describe, expect, it } from "vitest";
import type { TaskStatus, WorkerStatus } from "@prisma/client";
import { NotFoundError } from "../src/core/errors.js";
import { normalizeClaimInput } from "../src/claims/index.js";
import type { NormalizedClaim } from "../src/claims/index.js";
import { DependencyCycleError, planSchedule } from "../src/dag/index.js";
import type { ExecutionPlan } from "../src/dag/index.js";

function t(id: string, status: TaskStatus = "READY" as TaskStatus, claims: NormalizedClaim[] = []) {
  return { id, status, claims };
}

function w(id: string, status: WorkerStatus = "IDLE" as WorkerStatus) {
  return { id, status };
}

const W = (resource: string): NormalizedClaim => normalizeClaimInput(resource, "WRITE");
const R = (resource: string): NormalizedClaim => normalizeClaimInput(resource, "READ");

function groupsOf(plan: ExecutionPlan): string[][] {
  return plan.groups.map((group) => group.tasks);
}

describe("claim-aware scheduler", () => {
  it("schedules independent ready tasks together", () => {
    const plan = planSchedule({
      tasks: [t("a"), t("b")],
      dependencies: [],
      workers: [w("w1"), w("w2")],
      maxConcurrency: 2,
    });
    expect(groupsOf(plan)).toEqual([["a", "b"]]);
    expect(plan.groups[0]?.reason).toBe("PARALLEL_ELIGIBLE");
    expect(plan.blockedTasks).toEqual([]);
    expect(plan.resourceConflicts).toEqual([]);
    expect(plan.capacity).toBe(2);
  });

  it("treats completed prerequisites as satisfied", () => {
    const plan = planSchedule({
      tasks: [t("a", "COMPLETED" as TaskStatus), t("b", "PENDING" as TaskStatus)],
      dependencies: [{ taskId: "b", dependsOnTaskId: "a" }],
      workers: [w("w1")],
      maxConcurrency: 2,
    });
    expect(groupsOf(plan)).toEqual([["b"]]);
    expect(plan.blockedTasks).toEqual([
      { taskId: "a", reason: "TASK_NOT_READY", blockedBy: [], detail: "status COMPLETED is not eligible to run" },
    ]);
  });

  it("blocks tasks on pending prerequisites", () => {
    const plan = planSchedule({
      tasks: [t("a", "PENDING" as TaskStatus), t("b", "PENDING" as TaskStatus)],
      dependencies: [{ taskId: "b", dependsOnTaskId: "a" }],
      workers: [w("w1"), w("w2")],
      maxConcurrency: 2,
    });
    expect(groupsOf(plan)).toEqual([["a"]]);
    expect(plan.blockedTasks).toEqual([{ taskId: "b", reason: "BLOCKED_BY_DEPENDENCY", blockedBy: ["a"] }]);
  });

  it("blocks tasks on running prerequisites", () => {
    const plan = planSchedule({
      tasks: [t("a", "IN_PROGRESS" as TaskStatus), t("b", "PENDING" as TaskStatus)],
      dependencies: [{ taskId: "b", dependsOnTaskId: "a" }],
      workers: [w("w1")],
      maxConcurrency: 1,
    });
    expect(plan.blockedTasks).toContainEqual({ taskId: "b", reason: "BLOCKED_BY_DEPENDENCY", blockedBy: ["a"] });
  });

  it("never treats failed prerequisites as completed", () => {
    const plan = planSchedule({
      tasks: [t("a", "FAILED" as TaskStatus), t("b", "PENDING" as TaskStatus)],
      dependencies: [{ taskId: "b", dependsOnTaskId: "a" }],
      workers: [w("w1")],
      maxConcurrency: 1,
    });
    expect(groupsOf(plan)).toEqual([]);
    expect(plan.blockedTasks).toContainEqual({ taskId: "b", reason: "BLOCKED_BY_DEPENDENCY", blockedBy: ["a"] });
    expect(plan.blockedTasks).toContainEqual({
      taskId: "a",
      reason: "TASK_NOT_READY",
      blockedBy: [],
      detail: "status FAILED is not eligible to run",
    });
  });

  it("lists only the uncompleted prerequisites", () => {
    const plan = planSchedule({
      tasks: [
        t("a", "COMPLETED" as TaskStatus),
        t("b", "PENDING" as TaskStatus),
        t("d", "PENDING" as TaskStatus),
      ],
      dependencies: [
        { taskId: "d", dependsOnTaskId: "a" },
        { taskId: "d", dependsOnTaskId: "b" },
      ],
      workers: [w("w1")],
      maxConcurrency: 2,
    });
    expect(plan.blockedTasks).toContainEqual({ taskId: "d", reason: "BLOCKED_BY_DEPENDENCY", blockedBy: ["b"] });
  });

  it("shares READ+READ claims in one wave", () => {
    const plan = planSchedule({
      tasks: [t("a", "READY" as TaskStatus, [R("src/x.ts")]), t("b", "READY" as TaskStatus, [R("src/x.ts")])],
      dependencies: [],
      workers: [w("w1"), w("w2")],
      maxConcurrency: 2,
    });
    expect(groupsOf(plan)).toEqual([["a", "b"]]);
    expect(plan.resourceConflicts).toEqual([]);
  });

  it("serializes READ+WRITE, WRITE+READ, and WRITE+WRITE with kinds", () => {
    const rw = planSchedule({
      tasks: [t("a", "READY" as TaskStatus, [R("f.ts")]), t("b", "READY" as TaskStatus, [W("f.ts")])],
      dependencies: [],
      workers: [w("w1"), w("w2")],
      maxConcurrency: 2,
    });
    expect(groupsOf(rw)).toEqual([["a"], ["b"]]);
    expect(rw.resourceConflicts).toEqual([
      {
        taskA: "a",
        taskB: "b",
        reason: "SERIALIZED_RESOURCE_CONFLICT",
        details: [{ resourceA: "f.ts", resourceB: "f.ts", accessA: "READ", accessB: "WRITE", kind: "READ_WRITE" }],
      },
    ]);

    const wr = planSchedule({
      tasks: [t("a", "READY" as TaskStatus, [W("f.ts")]), t("b", "READY" as TaskStatus, [R("f.ts")])],
      dependencies: [],
      workers: [w("w1"), w("w2")],
      maxConcurrency: 2,
    });
    expect(groupsOf(wr)).toEqual([["a"], ["b"]]);
    expect(wr.resourceConflicts[0]?.details[0]?.kind).toBe("WRITE_READ");

    const ww = planSchedule({
      tasks: [t("a", "READY" as TaskStatus, [W("f.ts")]), t("b", "READY" as TaskStatus, [W("f.ts")])],
      dependencies: [],
      workers: [w("w1"), w("w2")],
      maxConcurrency: 2,
    });
    expect(groupsOf(ww)).toEqual([["a"], ["b"]]);
    expect(ww.resourceConflicts[0]?.details[0]?.kind).toBe("WRITE_WRITE");
  });

  it("conflicts parent directories with child files in both directions", () => {
    const parentFirst = planSchedule({
      tasks: [t("a", "READY" as TaskStatus, [W("src/auth")]), t("b", "READY" as TaskStatus, [W("src/auth/login.ts")])],
      dependencies: [],
      workers: [w("w1"), w("w2")],
      maxConcurrency: 2,
    });
    expect(groupsOf(parentFirst)).toEqual([["a"], ["b"]]);

    const childFirst = planSchedule({
      tasks: [t("a", "READY" as TaskStatus, [W("src/auth/login.ts")]), t("b", "READY" as TaskStatus, [W("src/auth")])],
      dependencies: [],
      workers: [w("w1"), w("w2")],
      maxConcurrency: 2,
    });
    expect(groupsOf(childFirst)).toEqual([["a"], ["b"]]);
    expect(childFirst.resourceConflicts).toHaveLength(1);
  });

  it("keeps similarly-prefixed but unrelated paths concurrent", () => {
    const plan = planSchedule({
      tasks: [t("a", "READY" as TaskStatus, [W("src/auth")]), t("b", "READY" as TaskStatus, [W("src/authentication/x.ts")])],
      dependencies: [],
      workers: [w("w1"), w("w2")],
      maxConcurrency: 2,
    });
    expect(groupsOf(plan)).toEqual([["a", "b"]]);
    expect(plan.resourceConflicts).toEqual([]);
  });

  it("serializes every pair of mutually conflicting tasks", () => {
    const plan = planSchedule({
      tasks: [
        t("x", "READY" as TaskStatus, [W("shared.ts")]),
        t("y", "READY" as TaskStatus, [W("shared.ts")]),
        t("z", "READY" as TaskStatus, [W("shared.ts")]),
      ],
      dependencies: [],
      workers: [w("w1"), w("w2"), w("w3")],
      maxConcurrency: 3,
    });
    expect(groupsOf(plan)).toEqual([["x"], ["y"], ["z"]]);
    expect(plan.resourceConflicts.map((entry) => [entry.taskA, entry.taskB])).toEqual([
      ["x", "y"],
      ["x", "z"],
      ["y", "z"],
    ]);
  });

  it("packs one wave per worker with a single worker", () => {
    const plan = planSchedule({
      tasks: [t("a"), t("b"), t("c")],
      dependencies: [],
      workers: [w("w1")],
      maxConcurrency: 5,
    });
    expect(groupsOf(plan)).toEqual([["a"], ["b"], ["c"]]);
    expect(plan.capacity).toBe(1);
  });

  it("packs waves across two workers", () => {
    const plan = planSchedule({
      tasks: [t("a"), t("b"), t("c")],
      dependencies: [],
      workers: [w("w1"), w("w2")],
      maxConcurrency: 2,
    });
    expect(groupsOf(plan)).toEqual([
      ["a", "b"],
      ["c"],
    ]);
  });

  it("packs waves across three workers", () => {
    const plan = planSchedule({
      tasks: [t("a"), t("b"), t("c"), t("d")],
      dependencies: [],
      workers: [w("w1"), w("w2"), w("w3")],
      maxConcurrency: 3,
    });
    expect(groupsOf(plan)).toEqual([
      ["a", "b", "c"],
      ["d"],
    ]);
  });

  it("respects maxConcurrency below worker count", () => {
    const plan = planSchedule({
      tasks: [t("a"), t("b"), t("c")],
      dependencies: [],
      workers: [w("w1"), w("w2"), w("w3")],
      maxConcurrency: 1,
    });
    expect(groupsOf(plan)).toEqual([["a"], ["b"], ["c"]]);
    expect(plan.capacity).toBe(1);
  });

  it("caps capacity at worker count above maxConcurrency", () => {
    const plan = planSchedule({
      tasks: [t("a"), t("b"), t("c")],
      dependencies: [],
      workers: [w("w1"), w("w2")],
      maxConcurrency: 10,
    });
    expect(groupsOf(plan)).toEqual([
      ["a", "b"],
      ["c"],
    ]);
    expect(plan.capacity).toBe(2);
  });

  it("rejects invalid maxConcurrency values", () => {
    const base = { tasks: [t("a")], dependencies: [], workers: [w("w1")] };
    expect(() => planSchedule({ ...base, maxConcurrency: 0 })).toThrow();
    expect(() => planSchedule({ ...base, maxConcurrency: -1 })).toThrow();
    expect(() => planSchedule({ ...base, maxConcurrency: 1.5 })).toThrow();
  });

  it("marks ready tasks worker-unavailable when no workers are idle", () => {
    const plan = planSchedule({
      tasks: [t("a"), t("b")],
      dependencies: [],
      workers: [],
      maxConcurrency: 2,
    });
    expect(groupsOf(plan)).toEqual([]);
    expect(plan.blockedTasks.map((entry) => entry.reason)).toEqual(["WORKER_UNAVAILABLE", "WORKER_UNAVAILABLE"]);
    expect(plan.capacity).toBe(0);
  });

  it("marks active and terminal task states not ready", () => {
    const statuses = ["CLAIMED", "IN_PROGRESS", "BLOCKED", "VERIFICATION", "COMPLETED", "CANCELLED"] as const;
    const plan = planSchedule({
      tasks: statuses.map((status, index) => t(`t${index}`, status as TaskStatus)),
      dependencies: [],
      workers: [w("w1")],
      maxConcurrency: 6,
    });
    expect(groupsOf(plan)).toEqual([]);
    expect(plan.blockedTasks).toHaveLength(statuses.length);
    for (const entry of plan.blockedTasks) {
      expect(entry.reason).toBe("TASK_NOT_READY");
      expect(entry.detail).toContain("not eligible to run");
    }
  });

  it("counts only idle workers and echoes sorted inputs", () => {
    const plan = planSchedule({
      tasks: [t("b"), t("a")],
      dependencies: [{ taskId: "b", dependsOnTaskId: "a" }],
      workers: [w("w2", "ASSIGNED" as WorkerStatus), w("w1")],
      maxConcurrency: 5,
    });
    expect(plan.availableWorkers).toEqual(["w1"]);
    expect(plan.capacity).toBe(1);
    expect(plan.dependencies).toEqual([{ taskId: "b", dependsOnTaskId: "a" }]);
  });

  it("is byte-identical across repeated runs", () => {
    const input = {
      tasks: [t("c"), t("a", "PENDING" as TaskStatus, [W("x.ts")]), t("b", "READY" as TaskStatus, [R("x.ts")])],
      dependencies: [
        { taskId: "c", dependsOnTaskId: "b" },
        { taskId: "b", dependsOnTaskId: "a" },
      ],
      workers: [w("w2"), w("w1")],
      maxConcurrency: 2,
    };
    const first = JSON.stringify(planSchedule(input));
    expect(JSON.stringify(planSchedule(input))).toBe(first);
    expect(JSON.stringify(planSchedule(input))).toBe(first);
  });

  it("is order-insensitive to shuffled inputs", () => {
    const ordered = {
      tasks: [t("a"), t("b"), t("c", "PENDING" as TaskStatus)],
      dependencies: [
        { taskId: "b", dependsOnTaskId: "a" },
        { taskId: "c", dependsOnTaskId: "b" },
      ],
      workers: [w("w1"), w("w2")],
      maxConcurrency: 2,
    };
    const shuffled = {
      tasks: [t("c", "PENDING" as TaskStatus), t("a"), t("b")],
      dependencies: [
        { taskId: "c", dependsOnTaskId: "b" },
        { taskId: "b", dependsOnTaskId: "a" },
      ],
      workers: [w("w2"), w("w1")],
      maxConcurrency: 2,
    };
    expect(planSchedule(shuffled)).toEqual(planSchedule(ordered));
  });

  it("plans the documented auth/payment/session scenario across completions", () => {
    const workers = [w("w1"), w("w2")];
    const first = planSchedule({
      tasks: [
        t("a", "READY" as TaskStatus, [W("src/auth")]),
        t("b", "READY" as TaskStatus, [W("src/payment")]),
        t("c", "READY" as TaskStatus, [W("src/auth/session")]),
      ],
      dependencies: [{ taskId: "c", dependsOnTaskId: "a" }],
      workers,
      maxConcurrency: 2,
    });
    expect(groupsOf(first)).toEqual([["a", "b"]]);
    expect(first.blockedTasks).toEqual([{ taskId: "c", reason: "BLOCKED_BY_DEPENDENCY", blockedBy: ["a"] }]);

    const second = planSchedule({
      tasks: [
        t("a", "COMPLETED" as TaskStatus, [W("src/auth")]),
        t("b", "READY" as TaskStatus, [W("src/payment")]),
        t("c", "READY" as TaskStatus, [W("src/auth/session")]),
      ],
      dependencies: [{ taskId: "c", dependsOnTaskId: "a" }],
      workers,
      maxConcurrency: 2,
    });
    expect(groupsOf(second)).toEqual([["b", "c"]]);
    expect(second.resourceConflicts).toEqual([]);
  });

  it("rejects cyclic, dangling, self, and duplicate-id inputs", () => {
    const workers = [w("w1")];
    expect(() =>
      planSchedule({
        tasks: [t("a"), t("b")],
        dependencies: [
          { taskId: "a", dependsOnTaskId: "b" },
          { taskId: "b", dependsOnTaskId: "a" },
        ],
        workers,
        maxConcurrency: 1,
      }),
    ).toThrow(DependencyCycleError);
    expect(() =>
      planSchedule({
        tasks: [t("a")],
        dependencies: [{ taskId: "a", dependsOnTaskId: "ghost" }],
        workers,
        maxConcurrency: 1,
      }),
    ).toThrow(NotFoundError);
    expect(() =>
      planSchedule({
        tasks: [t("a")],
        dependencies: [{ taskId: "a", dependsOnTaskId: "a" }],
        workers,
        maxConcurrency: 1,
      }),
    ).toThrow();
    expect(() =>
      planSchedule({ tasks: [t("a"), t("a")], dependencies: [], workers, maxConcurrency: 1 }),
    ).toThrow();
  });

  it("returns an empty plan for empty tasks", () => {
    const plan = planSchedule({ tasks: [], dependencies: [], workers: [w("w1")], maxConcurrency: 2 });
    expect(plan.groups).toEqual([]);
    expect(plan.blockedTasks).toEqual([]);
    expect(plan.resourceConflicts).toEqual([]);
    expect(plan.dependencies).toEqual([]);
  });
});
