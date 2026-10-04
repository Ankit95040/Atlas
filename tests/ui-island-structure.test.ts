import { describe, expect, it } from "vitest";
import { buildIslandScene } from "../src/ui/island3d/scene.js";
import type { WorkflowGraphData, WorkflowNode } from "../src/ui/data.js";

// Structural state coverage for the M27.5 Island redesign (Phase D).
//
// Pure descriptor tests over synthetic graphs: every spatial input the
// projector consumes is asserted here without WebGL. Statuses exercised:
// empty, single, sequential, parallel, failed, blocked, verification,
// merge, and a 25-task run. No 100/200-task claims: unmeasured.

function node(id: string, status: string, extra: Partial<WorkflowNode> = {}): WorkflowNode {
  return {
    id,
    title: `task-${id}`,
    status,
    workerId: null,
    workerStatus: null,
    workerLink: "none",
    wave: null,
    verdict: null,
    reasons: [],
    integrated: false,
    dependsOn: [],
    ...extra,
  };
}

function graph(nodes: WorkflowNode[], edges: Array<{ from: string; to: string }>, extra: Partial<WorkflowGraphData> = {}): WorkflowGraphData {
  return {
    runId: "run-1",
    runTitle: "run",
    runStatus: "IN_PROGRESS",
    nodes,
    edges,
    phases: [],
    trainHalted: false,
    trainHaltReason: null,
    trainCars: [],
    defaultBranch: "main",
    ...extra,
  };
}

describe("island structural states (M27.5)", () => {
  it("represents an empty run with no invented structures", () => {
    const scene = buildIslandScene(graph([], []));
    expect(scene.buildings).toEqual([]);
    expect(scene.paths).toEqual([]);
    expect(scene.gates).toEqual([]);
    expect(scene.cars).toEqual([]);
    expect(scene.halt).toBeNull();
    expect(scene.harbor.branch).toBe("main");
  });

  it("places a single task at level 0 with no worker", () => {
    const scene = buildIslandScene(graph([node("a", "READY")], []));
    expect(scene.buildings).toHaveLength(1);
    expect(scene.buildings[0]).toMatchObject({ taskId: "a", status: "READY", level: 0, worker: null });
    expect(scene.paths).toEqual([]);
  });

  it("lays sequential tasks on increasing levels with satisfied paths", () => {
    const a = node("a", "COMPLETED");
    const b = node("b", "IN_PROGRESS", { dependsOn: ["a"] });
    const c = node("c", "READY", { dependsOn: ["b"] });
    const scene = buildIslandScene(graph([a, b, c], [{ from: "a", to: "b" }, { from: "b", to: "c" }]));
    const byId = new Map(scene.buildings.map((x) => [x.taskId, x] as const));
    expect(byId.get("a")?.level).toBe(0);
    expect(byId.get("b")?.level).toBe(1);
    expect(byId.get("c")?.level).toBe(2);
    expect(byId.get("b")?.z).toBeGreaterThan(byId.get("a")?.z ?? 0);
    const satisfied = new Map(scene.paths.map((p) => [`${p.fromTaskId}→${p.toTaskId}`, p.satisfied] as const));
    expect(satisfied.get("a→b")).toBe(true);
    expect(satisfied.get("b→c")).toBe(false);
  });

  it("lays parallel tasks on the same level with no paths", () => {
    const scene = buildIslandScene(graph([node("a", "READY"), node("b", "READY")], []));
    expect(scene.buildings.map((x) => x.level)).toEqual([0, 0]);
    expect(scene.paths).toEqual([]);
    expect(scene.buildings[0]?.x).not.toBe(scene.buildings[1]?.x);
  });

  it("carries failed status, verdicts, and gates for evaluation", () => {
    const scene = buildIslandScene(
      graph([node("a", "FAILED", { verdict: "REJECTED", reasons: ["broke"] }), node("b", "BLOCKED", { dependsOn: ["a"] })], [
        { from: "a", to: "b" },
      ]),
    );
    expect(scene.buildings.find((x) => x.taskId === "a")?.status).toBe("FAILED");
    expect(scene.buildings.find((x) => x.taskId === "b")?.status).toBe("BLOCKED");
    expect(scene.gates).toHaveLength(1);
    expect(scene.gates[0]).toMatchObject({ taskId: "a", verdict: "REJECTED", reasons: ["broke"] });
  });

  it("represents verification state on the building", () => {
    const scene = buildIslandScene(graph([node("a", "VERIFICATION")], []));
    expect(scene.buildings[0]).toMatchObject({ status: "VERIFICATION", verdict: null });
  });

  it("orders merge cars and marks integrated tasks", () => {
    const scene = buildIslandScene(
      graph([node("a", "COMPLETED", { integrated: true }), node("b", "COMPLETED", { integrated: true })], [], {
        trainCars: [
          { taskId: "a", title: "task-a", sha: "aaa", subject: "first" },
          { taskId: "b", title: "task-b", sha: "bbb", subject: "second" },
        ],
      }),
    );
    expect(scene.cars.map((c) => c.sha)).toEqual(["aaa", "bbb"]);
    expect(scene.cars[0]).toMatchObject({ taskId: "a", order: 0 });
    expect(scene.buildings.every((x) => x.integrated)).toBe(true);
  });

  it("represents halt with the recorded reason", () => {
    const scene = buildIslandScene(graph([node("a", "FAILED")], [], { trainHalted: true, trainHaltReason: "conflict" }));
    expect(scene.halt).toEqual({ reason: "conflict" });
  });

  it("structures a 25-task run deterministically without invention", () => {
    const nodes: WorkflowNode[] = [];
    const edges: Array<{ from: string; to: string }> = [];
    for (let i = 0; i < 25; i++) {
      const id = `t${i}`;
      nodes.push(
        node(id, i % 5 === 0 ? "COMPLETED" : i % 5 === 1 ? "IN_PROGRESS" : i % 5 === 2 ? "FAILED" : "READY", {
          dependsOn: i === 0 ? [] : [`t${i - 1}`],
        }),
      );
      if (i > 0) {
        edges.push({ from: `t${i - 1}`, to: id });
      }
    }
    const first = buildIslandScene(graph(nodes, edges));
    const second = buildIslandScene(graph(nodes, edges));
    expect(first.buildings).toHaveLength(25);
    expect(first.paths).toHaveLength(24);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    const ids = new Set(nodes.map((n) => n.id));
    for (const b of first.buildings) {
      expect(ids.has(b.taskId)).toBe(true);
    }
    for (const p of first.paths) {
      expect(ids.has(p.fromTaskId) && ids.has(p.toTaskId)).toBe(true);
    }
    expect(first.bounds.rows).toBeGreaterThanOrEqual(20);
  });
});
