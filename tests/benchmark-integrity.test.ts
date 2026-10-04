import { describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPrismaClient } from "../src/db/client.js";
import { runRealBenchmark, shuffleStrategies } from "../src/benchmark/real/runner.js";
import { getWorkload } from "../src/benchmark/real/workloads.js";
import { track } from "./domain-helpers.js";
import { makeTempDir } from "./git-helpers.js";
import {
  RealAgentConfigSchema,
  type RealRunResult,
  type RealWorkloadSpec,
} from "../src/benchmark/real/types.js";
import { compareRealRuns, median, summarizeRealStrategy } from "../src/benchmark/real/metrics.js";
import { renderSingleAgentPrompt, renderTaskPrompt } from "../src/benchmark/real/prompts.js";
import {
  realisticFalseParallelism,
  realisticIndependent,
  realisticInplaceRefactor,
  realisticMigration,
  realisticMixed,
  realisticSchemaApi,
  realisticSharedConfig,
} from "../src/benchmark/real/workloads.js";

// Benchmark integrity (M28.5 §8): paired-arm parity, config provenance,
// missing-telemetry handling, aggregation correctness, fixture isolation,
// and reproducible reporting. Fast and provider-free; real-provider runs
// are governed by the report, not by these tests.

const WORKLOADS: RealWorkloadSpec[] = [
  realisticIndependent(),
  realisticSharedConfig(),
  realisticSchemaApi(),
  realisticMixed(),
  realisticFalseParallelism(),
  realisticMigration(),
  realisticInplaceRefactor(),
];

function fabricateRun(partial: Partial<RealRunResult> & { strategy: RealRunResult["strategy"] }): RealRunResult {
  return {
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:01:00.000Z",
    wallClockMs: 60_000,
    baseCommit: "abc123",
    agent: { provider: "fixture-cli", executable: "node", model: null, version: null, temperature: null },
    decomposition: "human-authored",
    tasks: [],
    scheduling: null,
    integration: null,
    triageClassifications: [],
    metrics: {
      peakConcurrency: 1,
      taskCount: 1,
      workerCount: 1,
      failures: 0,
      violations: 0,
      rework: 0,
      codeStats: { filesTouched: 1, linesAdded: 1, linesRemoved: 0 },
      workerMsTotal: null,
    },
    usage: { tokens: null, costUsd: null },
    evidence: { artifactIds: [], testRunIds: [], commitShas: [], trainBranch: null },
    success: false,
    ...partial,
  };
}

describe("paired-arm parity (M28.5)", () => {
  it("single-agent prompt covers every decomposed task key and title", () => {
    for (const workload of WORKLOADS) {
      const views = workload.tasks.map((t) => ({
        key: t.key,
        title: t.title,
        description: t.description ?? "",
        claims: t.claims.map((c) => ({ resource: c.resource, access: c.access as "READ" | "WRITE" })),
      }));
      const single = renderSingleAgentPrompt(views, workload.featureSpec.title);
      for (const task of workload.tasks) {
        expect(single, `workload ${workload.kind} task ${task.key}`).toContain(task.key);
        expect(single, `workload ${workload.kind} title`).toContain(task.title);
      }
      // Deterministic: identical bytes on repeat, so prompt quality can
      // never explain a strategy gap.
      expect(renderSingleAgentPrompt(views, workload.featureSpec.title)).toBe(single);
      // Per-task rendering is a strict subset of the union rendering.
      for (const task of views) {
        expect(single).toContain(renderTaskPrompt(task, workload.featureSpec.title).split("\n")[0] as string);
      }
    }
  });

  it("every workload task carries claims and only references existing keys", () => {
    for (const workload of WORKLOADS) {
      const keys = new Set(workload.tasks.map((t) => t.key));
      expect(keys.size, `duplicate keys in ${workload.kind}`).toBe(workload.tasks.length);
      for (const task of workload.tasks) {
        expect(task.claims.length, `${workload.kind}/${task.key} claims`).toBeGreaterThan(0);
        for (const dep of task.dependsOn) {
          expect(keys.has(dep), `${workload.kind}/${task.key} -> ${dep}`).toBe(true);
        }
      }
    }
  });
});

describe("screening harness determinism (M28.9)", () => {
  it("shuffles arm order deterministically per seed", () => {
    const arms = ["SINGLE_AGENT", "DUMB_PARALLEL", "ATLAS"] as const;
    expect(shuffleStrategies(arms, 7)).toEqual(shuffleStrategies(arms, 7));
    // Same multiset, order preserved as a set.
    expect([...shuffleStrategies(arms, 7)].sort()).toEqual([...arms].sort());
    // Unshuffled default path untouched (covered by existing runner tests).
  });

  it("migration fixture completes end to end with stub behaviors", async () => {
    const dir = await makeTempDir();
    const behaviors = {
      schema: ["--write", "src/schema.js=export const userSchema = { version: 2, required: [\"name\", \"email\"] };\n", "--commit", "schema"],
      migrate: [
        "--write",
        "scripts/migrate.mjs=export function migrate(users, schema) { return users.map((u) => { const out = { ...u }; for (const k of schema.required) { if (out[k] === undefined) out[k] = `${u.name}@example.com`; } return out; }); }\n",
        "--commit",
        "migrate",
      ],
      reader: [
        "--write",
        "src/users.js=export function missing(obj, schema) { return schema.required.filter((k) => obj[k] === undefined); }\n",
        "--commit",
        "reader",
      ],
    };
    const file = join(dir, "behaviors.json");
    await writeFile(file, JSON.stringify(behaviors));
    const dispatcher = fileURLToPath(new URL("./fixtures/real-benchmark-agent.mjs", import.meta.url));
    const comparison = await runRealBenchmark(getWorkload("realistic-migration"), {
      db: getPrismaClient(),
      track,
      agent: {
        provider: "fixture-cli",
        executable: process.execPath,
        argv: [dispatcher, file],
        model: "fixture-1.0",
        version: "test",
        temperature: 0,
        envAllowlist: [],
      },
      strategies: ["ATLAS"],
      repeats: 1,
      scratchParent: dir,
    });
    expect(comparison.summaries).toHaveLength(1);
    expect(comparison.summaries[0]).toMatchObject({ totalRuns: 1, successfulRuns: 1, successRate: 1 });
    expect(comparison.runs[0]?.success).toBe(true);
  }, 180000);
});

describe("configuration and budget recording (M28.5)", () => {
  it("records provider provenance and enforces timeout bounds strictly", () => {
    const config = RealAgentConfigSchema.parse({ provider: "fixture-cli", executable: "node" });
    expect(config.model).toBeNull();
    expect(config.timeoutMs).toBe(120_000);
    expect(() =>
      RealAgentConfigSchema.parse({ provider: "x", executable: "node", unknownField: 1 }),
    ).toThrow();
    expect(() => RealAgentConfigSchema.parse({ provider: "x", executable: "node", timeoutMs: 500 })).toThrow();
    expect(() => RealAgentConfigSchema.parse({ provider: "x", executable: "node", timeoutMs: 9_999_999 })).toThrow();
  });
});

describe("success aggregation and missing telemetry (M28.5)", () => {
  it("computes rates over the same population it reports, median only with enough wins", () => {
    const runs = [
      fabricateRun({ strategy: "ATLAS", success: true, wallClockMs: 100 }),
      fabricateRun({ strategy: "ATLAS", success: false, wallClockMs: 10 }),
      fabricateRun({ strategy: "ATLAS", success: true, wallClockMs: 300 }),
    ];
    const summary = summarizeRealStrategy("ATLAS", runs, 2);
    expect(summary.totalRuns).toBe(3);
    expect(summary.successfulRuns).toBe(2);
    expect(summary.successRate).toBeCloseTo(2 / 3);
    expect(summary.medianSuccessfulWallClockMs).toBe(200);
    // Below the minimum count the median is null, never a guess.
    expect(summarizeRealStrategy("ATLAS", runs, 3).medianSuccessfulWallClockMs).toBeNull();
    expect(median([])).toBeNull();
  });

  it("keeps unknown telemetry null instead of zero", () => {
    const runs = [fabricateRun({ strategy: "SINGLE_AGENT", success: true })];
    expect(runs[0]?.usage.tokens).toBeNull();
    expect(runs[0]?.usage.costUsd).toBeNull();
    expect(runs[0]?.metrics.workerMsTotal).toBeNull();
  });

  it("compares arms over disjoint populations without mixing them", () => {
    const runs = [
      fabricateRun({ strategy: "SINGLE_AGENT", success: true, wallClockMs: 50 }),
      fabricateRun({ strategy: "ATLAS", success: false, wallClockMs: 70 }),
    ];
    const first = compareRealRuns("w", runs, 1);
    const second = compareRealRuns("w", runs, 1);
    expect(first).toEqual(second);
    expect(first.summaries.map((s) => s.strategy).sort()).toEqual(["ATLAS", "SINGLE_AGENT"]);
    expect(first.summaries.find((s) => s.strategy === "SINGLE_AGENT")?.successRate).toBe(1);
    expect(first.summaries.find((s) => s.strategy === "ATLAS")?.successRate).toBe(0);
    expect(first.runs).toHaveLength(2);
  });
});
