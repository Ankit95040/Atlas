import { describe, expect, it } from "vitest";
import type { TaskStatus } from "@prisma/client";
import { InvariantViolationError, NotFoundError } from "../src/core/errors.js";
import { DependencyCycleError, TaskGraph } from "../src/dag/index.js";

function task(id: string) {
  return { id, status: "PENDING" as TaskStatus, claims: [] };
}

/** dep: taskId depends on dependsOnTaskId. */
function build(ids: string[], edges: Array<[string, string]>): TaskGraph {
  const graph = new TaskGraph();
  for (const id of ids) {
    graph.addTask(task(id));
  }
  for (const [dependent, prerequisite] of edges) {
    graph.addDependency(dependent, prerequisite);
  }
  return graph;
}

describe("task dependency graph", () => {
  it("handles an empty graph", () => {
    const graph = new TaskGraph();
    expect(graph.size).toBe(0);
    expect(graph.taskIds()).toEqual([]);
    expect(graph.topologicalOrder()).toEqual([]);
    expect(graph.hasCycle()).toBe(false);
    expect(graph.findCycle()).toBeNull();
    expect(() => graph.assertAcyclic()).not.toThrow();
  });

  it("orders a single task and a linear chain", () => {
    expect(build(["a"], []).topologicalOrder()).toEqual(["a"]);
    expect(
      build(["a", "b", "c"], [
        ["b", "a"],
        ["c", "b"],
      ]).topologicalOrder(),
    ).toEqual(["a", "b", "c"]);
  });

  it("orders A → B with navigation in both directions", () => {
    const graph = build(["a", "b"], [["b", "a"]]);
    expect(graph.topologicalOrder()).toEqual(["a", "b"]);
    expect(graph.getDependencies("b")).toEqual(["a"]);
    expect(graph.getDependencies("a")).toEqual([]);
    expect(graph.getDependents("a")).toEqual(["b"]);
    expect(graph.getDependents("b")).toEqual([]);
  });

  it("orders branching graphs deterministically", () => {
    const graph = build(["a", "b", "c"], [
      ["b", "a"],
      ["c", "a"],
    ]);
    const order = graph.topologicalOrder();
    expect(order[0]).toBe("a");
    expect([...order].sort()).toEqual(["a", "b", "c"]);
  });

  it("orders disconnected graphs deterministically regardless of insertion order", () => {
    const forward = build(["a", "b", "x", "y", "z"], [
      ["b", "a"],
      ["y", "x"],
    ]);
    const backward = build(["z", "y", "x", "b", "a"], [
      ["y", "x"],
      ["b", "a"],
    ]);
    expect(forward.topologicalOrder()).toEqual(backward.topologicalOrder());
    const order = forward.topologicalOrder();
    expect(order.indexOf("a")).toBeLessThan(order.indexOf("b"));
    expect(order.indexOf("x")).toBeLessThan(order.indexOf("y"));
  });

  it("rejects duplicate tasks and duplicate edges", () => {
    const graph = build(["a", "b"], [["b", "a"]]);
    expect(() => graph.addTask(task("a"))).toThrow(InvariantViolationError);
    expect(() => graph.addDependency("b", "a")).toThrow(InvariantViolationError);
  });

  it("rejects self-dependencies", () => {
    const graph = build(["a"], []);
    expect(() => graph.addDependency("a", "a")).toThrow(InvariantViolationError);
  });

  it("fails clearly on missing task references", () => {
    const graph = build(["a"], []);
    expect(() => graph.addDependency("a", "missing")).toThrow(NotFoundError);
    expect(() => graph.addDependency("missing", "a")).toThrow(NotFoundError);
    expect(() => graph.getDependencies("missing")).toThrow(NotFoundError);
    expect(() => graph.getDependents("missing")).toThrow(NotFoundError);
    expect(() => graph.removeTask("missing")).toThrow(NotFoundError);
    expect(() => graph.removeDependency("a", "missing")).toThrow(NotFoundError);
  });

  it("detects a simple cycle with a closed path", () => {
    const graph = build(["a", "b", "c"], [
      ["b", "a"],
      ["c", "b"],
      ["a", "c"],
    ]);
    expect(graph.hasCycle()).toBe(true);
    const cycle = graph.findCycle();
    expect(cycle).not.toBeNull();
    expect(cycle?.[0]).toBe(cycle?.[cycle.length - 1]);
    expect([...(cycle ?? []).slice(0, -1)].sort()).toEqual(["a", "b", "c"]);
    expect(() => graph.assertAcyclic()).toThrow(DependencyCycleError);
    expect(() => graph.topologicalOrder()).toThrow(DependencyCycleError);
  });

  it("detects a multi-node cycle that does not include every task", () => {
    // A → B → C → D → B leaves A outside the loop.
    const graph = build(["a", "b", "c", "d"], [
      ["b", "a"],
      ["c", "b"],
      ["d", "c"],
      ["b", "d"],
    ]);
    expect(graph.hasCycle()).toBe(true);
    const cycle = graph.findCycle() ?? [];
    expect(cycle[0]).toBe(cycle[cycle.length - 1]);
    expect(cycle).toContain("b");
    expect(cycle).toContain("c");
    expect(cycle).toContain("d");
    expect(cycle).not.toContain("a");
    try {
      graph.assertAcyclic();
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DependencyCycleError);
      expect((error as DependencyCycleError).cycle.length).toBeGreaterThan(1);
    }
  });

  it("detects cycles alongside unrelated tasks", () => {
    const graph = build(["x", "y", "solo"], [
      ["y", "x"],
      ["x", "y"],
    ]);
    expect(graph.hasCycle()).toBe(true);
    expect(graph.findCycle() ?? []).not.toContain("solo");
  });

  it("becomes acyclic after removing a cycle edge", () => {
    const graph = build(["a", "b", "c"], [
      ["b", "a"],
      ["c", "b"],
      ["a", "c"],
    ]);
    graph.removeDependency("a", "c");
    expect(graph.hasCycle()).toBe(false);
    expect(graph.topologicalOrder()).toEqual(["a", "b", "c"]);
  });

  it("removing a task cleans up its edges", () => {
    const graph = build(["a", "b"], [["b", "a"]]);
    graph.removeTask("a");
    expect(graph.taskIds()).toEqual(["b"]);
    expect(graph.getDependencies("b")).toEqual([]);
    expect(graph.topologicalOrder()).toEqual(["b"]);
  });

  it("lists edges sorted and deduplicated by construction", () => {
    const graph = build(["a", "b", "c"], [
      ["c", "a"],
      ["b", "a"],
    ]);
    expect(graph.edges()).toEqual([
      { taskId: "b", dependsOnTaskId: "a" },
      { taskId: "c", dependsOnTaskId: "a" },
    ]);
  });
});
