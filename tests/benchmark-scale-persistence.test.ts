import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import {
  completedScaleRuns,
  emptyScaleState,
  loadScaleState,
  missingScaleCells,
  saveScaleState,
  upsertScaleRun,
} from "../src/benchmark/scale/index.js";
import type { ScaleRunResult } from "../src/benchmark/scale/index.js";
import { makeTempDir } from "./git-helpers.js";

function makeRun(strategy: string, repeatIndex: number): ScaleRunResult {
  return {
    workloadId: "wl",
    level: "SMALL",
    runId: `wl-${strategy.toLowerCase().replace(/_/g, "-")}-r${repeatIndex}`,
    repeatIndex,
    strategy: strategy as ScaleRunResult["strategy"],
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:01:00.000Z",
    wallClockMs: 1000 + repeatIndex,
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
  };
}

describe("scale persistence", () => {
  it("loads null when no file exists and round-trips state", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "state.json");
    expect(await loadScaleState(path)).toBeNull();

    let state = emptyScaleState({ note: "test" });
    state = upsertScaleRun(state, "wl", { level: "SMALL", minSuccessfulRuns: 1 }, makeRun("SINGLE_AGENT", 0));
    state = upsertScaleRun(state, "wl", { level: "SMALL", minSuccessfulRuns: 1 }, makeRun("ATLAS_EVOLVING", 0));
    await saveScaleState(path, state);

    const loaded = await loadScaleState(path);
    expect(loaded?.workloads["wl"]?.runs).toHaveLength(2);
    expect(completedScaleRuns(loaded!)).toBe(2);
    // Atomic write leaves no temp file behind.
    await expect(readFile(`${path}.tmp`, "utf8")).rejects.toThrow();
  });

  it("replaces cells instead of duplicating on resume", async () => {
    let state = emptyScaleState();
    state = upsertScaleRun(state, "wl", { level: "SMALL", minSuccessfulRuns: 1 }, makeRun("SINGLE_AGENT", 0));
    state = upsertScaleRun(state, "wl", { level: "SMALL", minSuccessfulRuns: 1 }, makeRun("SINGLE_AGENT", 0));
    state = upsertScaleRun(state, "wl", { level: "SMALL", minSuccessfulRuns: 1 }, makeRun("SINGLE_AGENT", 1));
    expect(state.workloads["wl"]?.runs).toHaveLength(2);
    expect(missingScaleCells(state, "wl", ["SINGLE_AGENT", "ATLAS_EVOLVING"], 2)).toEqual([
      { strategy: "ATLAS_EVOLVING", repeatIndex: 0 },
      { strategy: "ATLAS_EVOLVING", repeatIndex: 1 },
    ]);
  });

  it("rejects mismatched cells, corrupt JSON, and version drift", async () => {
    const dir = await makeTempDir();
    const state = emptyScaleState();
    expect(() =>
      upsertScaleRun(state, "other", { level: "SMALL", minSuccessfulRuns: 1 }, makeRun("SINGLE_AGENT", 0)),
    ).toThrow(/does not match/);

    const badJson = join(dir, "bad.json");
    await writeFile(badJson, "{not json");
    await expect(loadScaleState(badJson)).rejects.toThrow(/not valid JSON/);

    const badVersion = join(dir, "version.json");
    await writeFile(badVersion, JSON.stringify({ ...(state as object), version: 99 }));
    await expect(loadScaleState(badVersion)).rejects.toThrow();
  });
});
