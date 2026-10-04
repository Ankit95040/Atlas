import { describe, expect, it } from "vitest";
import {
  M18_LEVEL_REPEATS,
  M18_LEVEL_TASK_BANDS,
  M18_LEVEL_TIMEOUTS_MS,
  ScaleExperimentStateSchema,
  ScaleRunResultSchema,
  ScaleWorkloadSpecSchema,
} from "../src/benchmark/scale/index.js";

function minimalWorkload(overrides: Record<string, unknown> = {}) {
  return {
    id: "test-wl",
    name: "Test workload",
    description: "A test workload.",
    level: "SMALL",
    stratum: "SYNTHETIC",
    featureSpec: { title: "Feature", description: "Does things." },
    features: [{ key: "feat", title: "Feat" }],
    baseFiles: [],
    testFiles: [{ path: "test/a.test.mjs", content: "import test from 'node:test';\ntest('x', () => {});\n" }],
    testCommand: ["node", "--test"],
    tasks: [
      {
        key: "aaa",
        title: "Task A",
        description: "Do A.",
        featureKey: "feat",
        claims: [{ resource: "src/a.js", access: "WRITE" }],
        dependsOn: [],
        probes: [{ name: "probe a", command: ["node", "-e", "process.exit(0)"] }],
      },
      {
        key: "bbb",
        title: "Task B",
        description: "Do B.",
        featureKey: "feat",
        claims: [{ resource: "src/b.js", access: "WRITE" }],
        dependsOn: [],
        probes: [{ name: "probe b", command: ["node", "-e", "process.exit(0)"] }],
      },
    ],
    decomposition: { author: "tester", reviewer: "checker" },
    expectedOutcome: "Both integrate.",
    ...overrides,
  };
}

describe("scale types", () => {
  it("level constants match the design matrix", () => {
    expect(M18_LEVEL_REPEATS).toEqual({ SMALL: 8, MEDIUM: 8, LARGE: 6, XL: 6 });
    expect(M18_LEVEL_TIMEOUTS_MS).toEqual({ SMALL: 600_000, MEDIUM: 600_000, LARGE: 900_000, XL: 1_200_000 });
    expect(M18_LEVEL_TASK_BANDS).toEqual({
      SMALL: { min: 2, max: 4 },
      MEDIUM: { min: 5, max: 8 },
      LARGE: { min: 8, max: 15 },
      XL: { min: 15, max: 25 },
    });
  });

  it("accepts a minimal valid workload", () => {
    const parsed = ScaleWorkloadSpecSchema.parse(minimalWorkload());
    expect(parsed.tasks).toHaveLength(2);
    expect(parsed.decomposition.contextFraction).toBeNull();
    expect(parsed.setupCommands).toEqual([]);
    expect(parsed.setupTimeoutMs).toBe(600_000);
  });

  it("rejects structural defects", () => {
    const dupKeys = minimalWorkload({
      tasks: [
        { key: "aaa", title: "A", description: "d", featureKey: "feat", claims: [{ resource: "src/a.js", access: "WRITE" }], dependsOn: [], probes: [{ name: "p", command: ["node"] }] },
        { key: "aaa", title: "B", description: "d", featureKey: "feat", claims: [{ resource: "src/b.js", access: "WRITE" }], dependsOn: [], probes: [{ name: "p", command: ["node"] }] },
      ],
    });
    expect(() => ScaleWorkloadSpecSchema.parse(dupKeys)).toThrow(/duplicate task keys/);

    const badDep = minimalWorkload();
    (badDep.tasks as Array<{ dependsOn: string[] }>)[0]!.dependsOn = ["ghost"];
    expect(() => ScaleWorkloadSpecSchema.parse(badDep)).toThrow(/unknown task/);

    const noProbes = minimalWorkload();
    (noProbes.tasks as Array<{ probes: unknown[] }>)[0]!.probes = [];
    expect(() => ScaleWorkloadSpecSchema.parse(noProbes)).toThrow();

    const realDerived = minimalWorkload({ stratum: "REAL_DERIVED" });
    expect(() => ScaleWorkloadSpecSchema.parse(realDerived)).toThrow(/snapshot/);
  });

  it("enforces success as the conjunction of sub-predicates", () => {
    const base = {
      workloadId: "w",
      level: "SMALL",
      runId: "w-single-agent-r0",
      repeatIndex: 0,
      strategy: "SINGLE_AGENT",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:01:00.000Z",
      wallClockMs: 60000,
      baseCommit: "abc123",
      trainHead: null,
      workerTimeoutMs: 600000,
      agent: { provider: "p", executable: "e", model: null, version: null, temperature: null },
      decomposition: "human-authored",
      tasks: [],
      scheduling: null,
      integration: null,
      triageClassifications: [],
      survival: [],
      survivalRate: null,
      featureTestsPassed: false,
      regressionPassed: null,
      humanInterventions: 0,
      metrics: {
        peakConcurrency: 0,
        waves: 0,
        taskCount: 0,
        workerCount: 0,
        failures: 0,
        violations: 0,
        rework: 0,
        codeStats: { filesTouched: 0, linesAdded: 0, linesRemoved: 0 },
        workerMsTotal: null,
      },
      usage: { tokens: null, costUsd: null },
      evidence: { artifactIds: [], testRunIds: [], commitShas: [], trainBranch: null, featureTestRunId: null, regressionTestRunId: null },
    };
    const allTrue = {
      workerCompletion: true,
      featureCorrectness: true,
      regression: true,
      survival: true,
      noIntervention: true,
    };
    const context = {
      estimatorVersion: 1,
      modelCapacityTokens: 200_000,
      repoTokens: 0,
      taskRelevantTokens: 0,
      promptTokensMax: 0,
      promptTokensMean: 0,
      utilizationMax: 0,
    };
    // success=true with all predicates true parses.
    expect(() => ScaleRunResultSchema.parse({ ...base, context, successPredicates: allTrue, success: true })).not.toThrow();
    // success=true with any predicate false is rejected: no inflated verdicts.
    expect(() =>
      ScaleRunResultSchema.parse({ ...base, context, successPredicates: { ...allTrue, survival: false }, success: true }),
    ).toThrow(/conjunction/);
    // success=false with all predicates true is equally rejected: no deflated verdicts.
    expect(() => ScaleRunResultSchema.parse({ ...base, context, successPredicates: allTrue, success: false })).toThrow(
      /conjunction/,
    );
  });

  it("round-trips experiment state through JSON", () => {
    const state = {
      version: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      workloads: {},
      meta: { note: "empty", setupEvidence: null },
    };
    expect(ScaleExperimentStateSchema.parse(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });
});
