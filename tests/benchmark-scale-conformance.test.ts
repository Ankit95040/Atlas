import { describe, expect, it } from "vitest";
import {
  getScaleWorkload,
  listScaleWorkloadIds,
  simulateWaves,
  validateLevelConformance,
} from "../src/benchmark/scale/index.js";
import { toRealWorkloadSpec } from "../src/benchmark/scale/runner.js";
import type { ScaleWorkloadSpec } from "../src/benchmark/scale/types.js";

interface TaskInput {
  key: string;
  claims: Array<[string, "READ" | "WRITE"]>;
  dependsOn?: string[];
}

function buildWorkload(level: ScaleWorkloadSpec["level"], tasks: TaskInput[]): ScaleWorkloadSpec {
  return {
    id: `test-${level.toLowerCase()}`,
    name: "Test",
    description: "Test workload.",
    level,
    stratum: "SYNTHETIC",
    featureSpec: { title: "Feature", description: "Does things." },
    features: [{ key: "feat", title: "Feat" }],
    baseFiles: [],
    testFiles: [{ path: "test/a.test.mjs", content: "import test from 'node:test';\ntest('x', () => {});\n" }],
    testCommand: ["node", "--test"],
    tasks: tasks.map((task) => ({
      key: task.key,
      title: `Task ${task.key}`,
      description: `Do ${task.key}.`,
      featureKey: "feat",
      claims: task.claims.map(([resource, access]) => ({ resource, access })),
      dependsOn: task.dependsOn ?? [],
      probes: [{ name: `probe ${task.key}`, command: ["node", "-e", "process.exit(0)"] }],
    })),
    decomposition: { author: "tester", reviewer: "checker" },
    expectedOutcome: "Integrates.",
  };
}

function mediumWorkload(): ScaleWorkloadSpec {
  return buildWorkload("MEDIUM", [
    { key: "t1", claims: [["src/one.js", "WRITE"]] },
    { key: "t2", claims: [["src/two.js", "WRITE"]] },
    { key: "t3", claims: [["src/shared.js", "WRITE"]], dependsOn: ["t1"] },
    { key: "t4", claims: [["src/shared.js", "WRITE"]], dependsOn: ["t2"] },
    { key: "t5", claims: [["src/other.js", "WRITE"]], dependsOn: ["t3"] },
    { key: "t6", claims: [["src/shared.js", "WRITE"]] },
  ]);
}

function largeWorkload(): ScaleWorkloadSpec {
  return buildWorkload("LARGE", [
    { key: "a", claims: [["src/a.js", "WRITE"]] },
    { key: "b", claims: [["src/b.js", "WRITE"]] },
    { key: "c", claims: [["src/hub.js", "WRITE"]], dependsOn: ["a"] },
    { key: "d", claims: [["src/hub.js", "WRITE"]], dependsOn: ["b"] },
    { key: "e", claims: [["src/hub.js", "WRITE"]], dependsOn: ["c"] },
    { key: "f", claims: [["src/f.js", "WRITE"]], dependsOn: ["c", "d"] },
    { key: "g", claims: [["src/g.js", "WRITE"]] },
    { key: "h", claims: [["src/h.js", "WRITE"]], dependsOn: ["f"] },
    { key: "i", claims: [["src/i.js", "WRITE"]] },
  ]);
}

function xlWorkload(): ScaleWorkloadSpec {
  return buildWorkload("XL", [
    { key: "k1", claims: [["src/k1.js", "WRITE"]] },
    { key: "k2", claims: [["src/k2.js", "WRITE"]], dependsOn: ["k1"] },
    { key: "k3", claims: [["src/k3.js", "WRITE"]], dependsOn: ["k2"] },
    { key: "k4", claims: [["src/k4.js", "WRITE"]], dependsOn: ["k3"] },
    { key: "k5", claims: [["src/hot.js", "WRITE"]], dependsOn: ["k4"] },
    { key: "j1", claims: [["src/j1.js", "WRITE"]], dependsOn: ["k2", "k3"] },
    { key: "j2", claims: [["src/j2.js", "WRITE"]], dependsOn: ["k3", "k4", "k5"] },
    { key: "c1", claims: [["src/hot.js", "WRITE"]], dependsOn: ["k1"] },
    { key: "c2", claims: [["src/hot.js", "WRITE"]], dependsOn: ["k2"] },
    { key: "c3", claims: [["src/hot.js", "WRITE"]] },
    { key: "d1", claims: [["src/duo.js", "WRITE"]], dependsOn: ["k1"] },
    { key: "d2", claims: [["src/duo.js", "WRITE"]] },
    { key: "f1", claims: [["src/f1.js", "WRITE"]] },
    { key: "f2", claims: [["src/f2.js", "WRITE"]] },
    { key: "f3", claims: [["src/f3.js", "WRITE"]] },
    { key: "f4", claims: [["src/f4.js", "WRITE"]] },
  ]);
}

describe("scale conformance", () => {
  it("accepts the bundled Small workload with a single full-width wave", () => {
    const workload = getScaleWorkload("scale-small-catalog");
    expect(listScaleWorkloadIds()).toContain("scale-small-catalog");
    expect(validateLevelConformance(workload)).toEqual([]);
    expect(simulateWaves(workload)).toEqual([["cart", "format", "shout"]]);
  });

  it("rejects unknown workload ids", () => {
    expect(() => getScaleWorkload("nope")).toThrow(/unknown M18 scale workload/);
  });

  it("accepts crafted Medium/Large/XL shapes", () => {
    expect(validateLevelConformance(mediumWorkload())).toEqual([]);
    expect(validateLevelConformance(largeWorkload())).toEqual([]);
    expect(validateLevelConformance(xlWorkload())).toEqual([]);
  });

  it("rejects task-count, density, chain, and contention defects", () => {
    const tooMany = buildWorkload("SMALL", [
      { key: "a", claims: [["src/a.js", "WRITE"]] },
      { key: "b", claims: [["src/b.js", "WRITE"]] },
      { key: "c", claims: [["src/c.js", "WRITE"]] },
      { key: "d", claims: [["src/d.js", "WRITE"]] },
      { key: "e", claims: [["src/e.js", "WRITE"]] },
    ]);
    expect(validateLevelConformance(tooMany).join(" ")).toMatch(/task count/);

    const chained = buildWorkload("SMALL", [
      { key: "a", claims: [["src/a.js", "WRITE"]] },
      { key: "b", claims: [["src/b.js", "WRITE"]], dependsOn: ["a"] },
      { key: "c", claims: [["src/c.js", "WRITE"]], dependsOn: ["b"] },
    ]);
    expect(validateLevelConformance(chained).join(" ")).toMatch(/chain|density/);

    const cyclic = buildWorkload("SMALL", [
      { key: "a", claims: [["src/a.js", "WRITE"]], dependsOn: ["b"] },
      { key: "b", claims: [["src/b.js", "WRITE"]], dependsOn: ["a"] },
    ]);
    expect(validateLevelConformance(cyclic).join(" ")).toMatch(/cycle|dry-run/);

    const overContended = buildWorkload("SMALL", [
      { key: "a", claims: [["src/s.js", "WRITE"]] },
      { key: "b", claims: [["src/s.js", "WRITE"]] },
      { key: "c", claims: [["src/s.js", "WRITE"]] },
    ]);
    expect(validateLevelConformance(overContended).join(" ")).toMatch(/pairs/);

    const sparseMedium = buildWorkload(
      "MEDIUM",
      ["m1", "m2", "m3", "m4", "m5"].map((key) => ({ key, claims: [[`src/${key}.js`, "WRITE"]] as [string, "WRITE"] })),
    );
    expect(validateLevelConformance(sparseMedium).join(" ")).toMatch(/density|pairs/);
  });

  it("maps levels to scale kinds for the frozen arms", () => {
    expect(toRealWorkloadSpec(getScaleWorkload("scale-small-catalog")).kind).toBe("REALISTIC_INDEPENDENT");
    const medium = toRealWorkloadSpec(mediumWorkload());
    expect(medium.kind).toBe("REALISTIC_DEPENDENCY_CHAIN");
    expect(medium.tasks).toHaveLength(6);
    // Conversion preserves everything the arms consume.
    expect(medium.testCommand).toEqual(["node", "--test"]);
    expect(medium.tasks.map((task) => task.key).sort()).toEqual(["t1", "t2", "t3", "t4", "t5", "t6"]);
  });
});
