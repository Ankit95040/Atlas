import { describe, expect, it } from "vitest";
import {
  classifyFailureMode,
  failureModeBreakdown,
  fitCrossoverInteraction,
  newcombeDifferenceInterval,
  summarizeContext,
  summarizeScaleLevel,
  summarizeScaleRuns,
  wilsonInterval,
} from "../src/benchmark/scale/index.js";
import type { ScaleRunResult } from "../src/benchmark/scale/index.js";

function makeRun(overrides: Partial<ScaleRunResult> & { strategy: "SINGLE_AGENT" | "ATLAS_EVOLVING" }): ScaleRunResult {
  return {
    workloadId: "wl",
    level: "SMALL",
    runId: `wl-${overrides.strategy.toLowerCase().replace(/_/g, "-")}-r${overrides.repeatIndex ?? 0}`,
    repeatIndex: 0,
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:01:00.000Z",
    wallClockMs: 1000,
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
    context: {
      estimatorVersion: 1,
      modelCapacityTokens: 200_000,
      repoTokens: 0,
      taskRelevantTokens: 0,
      promptTokensMax: 0,
      promptTokensMean: 0,
      utilizationMax: 0,
    },
    evidence: { artifactIds: [], testRunIds: [], commitShas: [], trainBranch: null, featureTestRunId: null, regressionTestRunId: null },
    successPredicates: {
      workerCompletion: false,
      featureCorrectness: false,
      regression: true,
      survival: false,
      noIntervention: true,
    },
    success: false,
    ...overrides,
  };
}

function successRun(strategy: "SINGLE_AGENT" | "ATLAS_EVOLVING", wallClockMs: number, survivalRate: number | null = 1) {
  return makeRun({
    strategy,
    wallClockMs,
    survivalRate,
    featureTestsPassed: true,
    successPredicates: {
      workerCompletion: true,
      featureCorrectness: true,
      regression: true,
      survival: true,
      noIntervention: true,
    },
    success: true,
  });
}

describe("scale aggregation", () => {
  it("computes Wilson intervals with verified anchors", () => {
    expect(wilsonInterval(0, 0)).toEqual({ lo: 0, hi: 0 });
    const perfect = wilsonInterval(10, 10);
    expect(perfect.hi).toBe(1);
    expect(perfect.lo).toBeCloseTo(0.7224, 3);
    const half = wilsonInterval(30, 60);
    expect(half.lo).toBeLessThan(0.5);
    expect(half.hi).toBeGreaterThan(0.5);
  });

  it("computes Newcombe difference intervals that match M17-scale evidence", () => {
    const m17like = newcombeDifferenceInterval(51, 60, 55, 60);
    expect(m17like.lo).toBeLessThan(0);
    expect(m17like.hi).toBeGreaterThan(0);
    const clear = newcombeDifferenceInterval(55, 60, 20, 60);
    expect(clear.lo).toBeGreaterThan(0.3);
  });

  it("summarizes runs per strategy with survival means", () => {
    const runs = [
      successRun("SINGLE_AGENT", 1000, 1),
      successRun("SINGLE_AGENT", 3000, 0.5),
      makeRun({ strategy: "SINGLE_AGENT", wallClockMs: 5000, survivalRate: 0 }),
    ];
    const summary = summarizeScaleRuns("SINGLE_AGENT", runs, 1);
    expect(summary.totalRuns).toBe(3);
    expect(summary.successfulRuns).toBe(2);
    expect(summary.successRate).toBeCloseTo(2 / 3);
    expect(summary.medianSuccessfulWallClockMs).toBe(2000);
    expect(summary.meanSurvivalRate).toBeCloseTo(0.5);
    expect(summarizeScaleRuns("SINGLE_AGENT", [], 1).successRate).toBe(0);
  });

  it("contrasts arms per level with AE-minus-SA intervals", () => {
    const runs = [
      successRun("SINGLE_AGENT", 1000),
      makeRun({ strategy: "SINGLE_AGENT" }),
      successRun("ATLAS_EVOLVING", 2000),
      successRun("ATLAS_EVOLVING", 4000),
    ];
    const level = summarizeScaleLevel(runs, "SMALL", 1);
    expect(level.arms).toHaveLength(2);
    expect(level.aeMinusSa?.diff).toBeCloseTo(0.5);
    expect(level.aeMinusSa?.ci.lo).toBeLessThan(0.5);
    const single = summarizeScaleLevel(runs.slice(0, 2), "SMALL", 1);
    expect(single.aeMinusSa).toBeNull();
  });

  it("recovers a positive interaction from crossover-shaped data", () => {
    const outcomes: Array<{ strategy: string; complexity: number; success: boolean }> = [];
    const saRates = [9, 7, 3, 1];
    for (let level = 1; level <= 4; level += 1) {
      for (let i = 0; i < 10; i += 1) {
        outcomes.push({ strategy: "SINGLE_AGENT", complexity: level, success: i < (saRates[level - 1] ?? 0) });
        outcomes.push({ strategy: "ATLAS_EVOLVING", complexity: level, success: i < 9 });
      }
    }
    const fit = fitCrossoverInteraction(outcomes);
    expect(fit.converged).toBe(true);
    expect(fit.n).toBe(80);
    // SA degrades with complexity while AE holds: positive interaction.
    expect(fit.interaction.estimate).toBeGreaterThan(0);
    expect(fit.interaction.p).toBeLessThan(0.05);
    // Complexity main effect is negative (SA, the reference arm, degrades).
    expect(fit.complexity.estimate).toBeLessThan(0);
  });

  it("estimates near-zero interaction for arm-invariant data", () => {
    const outcomes: Array<{ strategy: string; complexity: number; success: boolean }> = [];
    for (let level = 1; level <= 4; level += 1) {
      for (const strategy of ["SINGLE_AGENT", "ATLAS_EVOLVING"]) {
        for (let i = 0; i < 10; i += 1) {
          outcomes.push({ strategy, complexity: level, success: i < 8 - level });
        }
      }
    }
    const fit = fitCrossoverInteraction(outcomes);
    expect(fit.converged).toBe(true);
    // Both arms degrade identically: no interaction.
    expect(Math.abs(fit.interaction.estimate)).toBeLessThan(0.5);
    expect(fit.interaction.p).toBeGreaterThan(0.05);
  });

  it("rejects out-of-matrix strategies and empty input", () => {
    expect(() => fitCrossoverInteraction([{ strategy: "DUMB_PARALLEL", complexity: 1, success: true }])).toThrow(
      /only the two M18 arms/,
    );
    expect(() => fitCrossoverInteraction([])).toThrow(/at least one outcome/);
  });

  it("classifies dominant failure modes upstream-first", () => {
    expect(classifyFailureMode(successRun("SINGLE_AGENT", 1000), 600000)).toBe("NONE");
    expect(classifyFailureMode(makeRun({ strategy: "SINGLE_AGENT", regressionPassed: false }), 600000)).toBe("F7_REGRESSION");

    const violation = makeRun({ strategy: "ATLAS_EVOLVING" });
    violation.tasks = [
      { key: "a", taskId: "t", workerId: "w", status: "CLAIM_VIOLATION", workerMs: 1, verification: "NOT_EVALUATED", testStatus: "NOT_RUN", error: null },
    ];
    expect(classifyFailureMode(violation, 600000)).toBe("F2_WORKER_FLAKINESS");

    const timeout = makeRun({ strategy: "SINGLE_AGENT", wallClockMs: 600000 });
    timeout.tasks = [
      { key: "single", taskId: "t", workerId: "w", status: "FAILED", workerMs: 600000, verification: "NOT_EVALUATED", testStatus: "NOT_RUN", error: "command timed out after 600000ms" },
    ];
    expect(classifyFailureMode(timeout, 600000)).toBe("F6_TIMEOUT");

    const earlyCrash = makeRun({ strategy: "SINGLE_AGENT", wallClockMs: 1000 });
    earlyCrash.tasks = [
      { key: "single", taskId: "t", workerId: "w", status: "FAILED", workerMs: 1000, verification: "NOT_EVALUATED", testStatus: "NOT_RUN", error: "boom" },
    ];
    expect(classifyFailureMode(earlyCrash, 600000)).toBe("F2_WORKER_FLAKINESS");

    const halted = makeRun({ strategy: "ATLAS_EVOLVING" });
    halted.tasks = [
      { key: "a", taskId: "t", workerId: "w", status: "COMPLETED", workerMs: 1, verification: "VERIFIED", testStatus: "PASSED", error: null },
    ];
    halted.integration = { status: "HALTED", conflicts: ["a"], items: [], order: [] };
    halted.survival = [
      { key: "a", status: "NEVER_MERGED", probePassed: false, diffNonEmpty: false, attributed: false, detail: "" },
    ];
    expect(classifyFailureMode(halted, 600000)).toBe("F4_TRAIN_HALT");

    const overwrite = makeRun({ strategy: "ATLAS_EVOLVING" });
    overwrite.integration = { status: "COMPLETED", conflicts: [], items: [], order: [] };
    overwrite.survival = [
      { key: "a", status: "OVERWRITTEN", probePassed: false, diffNonEmpty: true, attributed: true, detail: "" },
    ];
    expect(classifyFailureMode(overwrite, 600000)).toBe("F3_SILENT_OVERWRITE");

    const contextLoss = makeRun({ strategy: "SINGLE_AGENT" });
    contextLoss.integration = { status: "COMPLETED", conflicts: [], items: [], order: [] };
    contextLoss.survival = [
      { key: "a", status: "OVERWRITTEN", probePassed: false, diffNonEmpty: true, attributed: true, detail: "" },
    ];
    expect(classifyFailureMode(contextLoss, 600000)).toBe("F1_CONTEXT_LOSS");

    const breakdown = failureModeBreakdown([halted, overwrite], "ATLAS_EVOLVING", 600000);
    expect(breakdown.F4_TRAIN_HALT).toBe(1);
    expect(breakdown.F3_SILENT_OVERWRITE).toBe(1);
    expect(breakdown.NONE).toBe(0);
  });

  it("summarizes context across runs", () => {
    const runA = makeRun({
      strategy: "SINGLE_AGENT",
      context: {
        estimatorVersion: 1,
        modelCapacityTokens: 200_000,
        repoTokens: 10_000,
        taskRelevantTokens: 5_000,
        promptTokensMax: 40_000,
        promptTokensMean: 40_000,
        utilizationMax: 0.2,
      },
    });
    const runB = makeRun({
      strategy: "ATLAS_EVOLVING",
      context: {
        estimatorVersion: 1,
        modelCapacityTokens: 200_000,
        repoTokens: 10_000,
        taskRelevantTokens: 5_000,
        promptTokensMax: 20_000,
        promptTokensMean: 10_000,
        utilizationMax: 0.1,
      },
    });
    const summary = summarizeContext([runA, runB]);
    expect(summary).not.toBeNull();
    expect(summary!.repoTokens).toBe(10_000);
    expect(summary!.taskRelevantTokens).toBe(5_000);
    expect(summary!.meanPromptTokensMax).toBe(30_000);
    expect(summary!.meanPromptTokensMean).toBe(25_000);
    expect(summary!.meanUtilizationMax).toBeCloseTo(0.15);
    expect(summary!.runCount).toBe(2);
  });

  it("summarizeContext returns null for empty runs", () => {
    expect(summarizeContext([])).toBeNull();
  });
});
