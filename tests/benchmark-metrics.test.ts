import { describe, expect, it } from "vitest";
import { assessComparison, compareRuns, deriveBaselineDeltas, deriveComparison } from "../src/benchmark/index.js";
import type { BenchmarkRunResult } from "../src/benchmark/index.js";

function run(
  strategy: "SINGLE_AGENT" | "DUMB_PARALLEL" | "ATLAS",
  overrides: Partial<BenchmarkRunResult> = {},
): BenchmarkRunResult {
  return {
    scenarioId: "s",
    runId: `s-${strategy}`,
    strategy,
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:01:00.000Z",
    wallClockMs: 1000,
    baseCommit: "abc",
    tasks: [],
    scheduling: null,
    integration: null,
    metrics: {
      peakConcurrency: 1,
      taskCount: 0,
      workerCount: 1,
      failures: 0,
      violations: 0,
      rework: 0,
      codeStats: { filesTouched: 0, linesAdded: 0, linesRemoved: 0 },
    },
    evidence: { artifactIds: [], testRunIds: [], commitShas: [], trainBranch: null, integrationOrder: [] },
    provenance: "fake-provider",
    ...overrides,
  };
}

function task(key: string, status = "COMPLETED") {
  return {
    key,
    taskId: `task-${key}`,
    workerId: `worker-${key}`,
    status,
    workerMs: 100,
    verification: "VERIFIED" as const,
    testStatus: "PASSED" as const,
    undeclaredResources: [] as string[],
  };
}

describe("benchmark metrics", () => {
  it("computes rates over recorded evidence only", () => {
    const comparison = deriveComparison({
      SINGLE_AGENT: run("SINGLE_AGENT", {
        tasks: [task("single")],
        integration: { status: "COMPLETED", mergeCommits: ["c1"], conflicts: [], items: [{ key: "single", status: "INTEGRATED" }], order: ["single"] },
      }),
      DUMB_PARALLEL: run("DUMB_PARALLEL", {
        tasks: [task("a"), { ...task("b"), status: "FAILED" }],
        integration: {
          status: "HALTED",
          mergeCommits: ["c2"],
          conflicts: ["b"],
          items: [
            { key: "a", status: "INTEGRATED" },
            { key: "b", status: "CONFLICT" },
          ],
          order: ["a", "b"],
        },
      }),
    });
    expect(comparison.failureRate).toBeCloseTo(1 / 3, 10);
    expect(comparison.conflictRate).toBeCloseTo(1 / 3, 10);
    expect(comparison.reworkRate).toBeCloseTo(1 / 3, 10);
    expect(comparison.speedupVsSingle).toBeNull();
    expect(comparison.costDeltaVsSingle).toBeNull();
  });

  it("returns zeros on empty input instead of NaN", () => {
    expect(deriveComparison({})).toEqual({
      speedupVsSingle: null,
      costDeltaVsSingle: null,
      failureRate: 0,
      conflictRate: 0,
      reworkRate: 0,
    });
  });

  it("derives speedup and cost deltas from declared simulated costs", () => {
    const runs = {
      SINGLE_AGENT: run("SINGLE_AGENT", { wallClockMs: 1000, tasks: [task("single")] }),
      ATLAS: run("ATLAS", { wallClockMs: 400, tasks: [task("a"), task("b")] }),
    };
    const costs = new Map([
      ["single", 0.03],
      ["a", 0.01],
      ["b", 0.01],
    ]);
    const deltas = deriveBaselineDeltas(runs, costs);
    expect(deltas.speedupVsSingle).toBe(2.5);
    expect(deltas.costDeltaVsSingle).toBeCloseTo(-0.01, 10);
    expect(deriveBaselineDeltas({}, costs)).toEqual({ speedupVsSingle: null, costDeltaVsSingle: null });
    expect(deriveBaselineDeltas(runs, new Map())).toEqual({ speedupVsSingle: 2.5, costDeltaVsSingle: null });
  });

  it("flags serialized Atlas runs", () => {
    const runs = {
      ATLAS: run("ATLAS", {
        tasks: [task("a"), task("b")],
        scheduling: { waves: [["a"], ["b"]], conflicts: [["a", "b"]], blocked: [] },
      }),
    };
    const codes = assessComparison(runs, deriveComparison(runs)).map((finding) => finding.code);
    expect(codes).toContain("ATLAS_SERIALIZED");
  });

  it("flags single-agent wins and hollow parallelism", () => {
    const runs = {
      SINGLE_AGENT: run("SINGLE_AGENT", { wallClockMs: 300, tasks: [task("single")] }),
      ATLAS: run("ATLAS", {
        wallClockMs: 900,
        tasks: [task("a"), task("b")],
        metrics: {
          peakConcurrency: 2,
          taskCount: 2,
          workerCount: 2,
          failures: 0,
          violations: 0,
          rework: 0,
          codeStats: { filesTouched: 2, linesAdded: 2, linesRemoved: 0 },
        },
      }),
    };
    const codes = assessComparison(runs, deriveComparison(runs)).map((finding) => finding.code);
    expect(codes).toContain("SINGLE_AGENT_FASTER");
    expect(codes).toContain("SLOWER_DESPITE_PARALLEL");
  });

  it("flags cost without gain and dumb conflicts", () => {
    const runs = {
      SINGLE_AGENT: run("SINGLE_AGENT", {
        wallClockMs: 500,
        tasks: [task("single")],
        integration: { status: "COMPLETED", mergeCommits: ["c1"], conflicts: [], items: [{ key: "single", status: "INTEGRATED" }], order: ["single"] },
      }),
      ATLAS: run("ATLAS", {
        wallClockMs: 400,
        tasks: [task("a")],
        integration: { status: "HALTED", mergeCommits: [], conflicts: [], items: [{ key: "a", status: "TESTS_FAILED" }], order: ["a"] },
      }),
      DUMB_PARALLEL: run("DUMB_PARALLEL", {
        wallClockMs: 450,
        tasks: [task("a"), task("b")],
        integration: {
          status: "HALTED",
          mergeCommits: ["c2"],
          conflicts: ["b"],
          items: [
            { key: "a", status: "INTEGRATED" },
            { key: "b", status: "CONFLICT" },
          ],
          order: ["a", "b"],
        },
      }),
    };
    const derived = { ...deriveComparison(runs), costDeltaVsSingle: 0.05 };
    const codes = assessComparison(runs, derived).map((finding) => finding.code);
    expect(codes).toContain("COSTLIER_WITHOUT_GAIN");
    expect(codes).toContain("DUMB_CONFLICTED");
    expect(codes).not.toContain("ALL_INTEGRATED");
  });

  it("reports all-integrated when every run completes integration", () => {
    const runs = {
      ATLAS: run("ATLAS", {
        tasks: [task("a")],
        integration: { status: "COMPLETED", mergeCommits: ["c"], conflicts: [], items: [{ key: "a", status: "INTEGRATED" }], order: ["a"] },
      }),
    };
    expect(assessComparison(runs, deriveComparison(runs)).map((f) => f.code)).toContain("ALL_INTEGRATED");
  });

  it("compares runs end to end", () => {
    const comparison = compareRuns(
      "s",
      { SINGLE_AGENT: run("SINGLE_AGENT", { tasks: [task("single")] }) },
      new Map([["single", 0.01]]),
    );
    expect(comparison.scenarioId).toBe("s");
    expect(comparison.derived.failureRate).toBe(0);
  });
});
