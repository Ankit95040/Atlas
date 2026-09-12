import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getPrismaClient } from "../src/db/client.js";
import {
  RealAgentConfigSchema,
  RealBenchmarkComparisonSchema,
  getWorkload,
  runRealBenchmark,
} from "../src/benchmark/real/index.js";
import { track } from "./domain-helpers.js";
import { makeTempDir } from "./git-helpers.js";

const db = getPrismaClient();
const DISPATCHER = fileURLToPath(new URL("./fixtures/real-benchmark-agent.mjs", import.meta.url));

const LOGIN_IMPL = `export function login(username, password) {
  if (password.length < 4) {
    throw new Error("weak password");
  }
  return \`TOKEN-\${username}\`;
}
`;

const BILLING_IMPL = `export function total(items) {
  return items.reduce((sum, item) => sum + item.price * item.qty, 0);
}
`;

async function fixtureAgent(behaviors: Record<string, string[]>) {
  const file = join(await makeTempDir(), "behaviors.json");
  await writeFile(file, JSON.stringify(behaviors));
  return RealAgentConfigSchema.parse({
    provider: "fixture-cli",
    executable: process.execPath,
    argv: [DISPATCHER, file],
    model: "fixture-1.0",
    version: "test",
    temperature: 0,
  });
}

function goodBehaviors(): Record<string, string[]> {
  return {
    login: ["--write", `src/auth/login.js=${LOGIN_IMPL}`, "--commit", "login"],
    billing: ["--write", `src/billing/invoice.js=${BILLING_IMPL}`, "--commit", "billing"],
  };
}

describe("real benchmark runner", () => {
  it("compares all strategies with controlled decomposition and recorded provenance", async () => {
    const parent = await makeTempDir();
    const agent = await fixtureAgent(goodBehaviors());
    const comparison = await runRealBenchmark(getWorkload("realistic-independent"), {
      db,
      track,
      agent,
      repeats: 2,
      scratchParent: parent,
    });

    expect(comparison.summaries).toHaveLength(3);
    for (const summary of comparison.summaries) {
      // Deterministic fake CLI: every cell succeeds on this workload.
      expect(summary.totalRuns).toBe(2);
      expect(summary.successfulRuns).toBe(2);
      expect(summary.successRate).toBe(1);
      expect(summary.medianSuccessfulWallClockMs).toBeGreaterThan(0);
    }
    expect(comparison.runs).toHaveLength(6);
    for (const run of comparison.runs) {
      expect(run.success).toBe(true);
      expect(run.decomposition).toBe("human-authored");
      expect(run.agent.provider).toBe("fixture-cli");
      expect(run.agent.model).toBe("fixture-1.0");
      // Unknown cost stays unknown: never estimated from wall-clock.
      expect(run.usage).toEqual({ tokens: null, costUsd: null });
      expect(run.integration?.status).toBe("COMPLETED");
    }
    // Stable integration order across repeats of the parallel arms.
    const orders = (strategy: string): string[][] =>
      comparison.runs.filter((run) => run.strategy === strategy).map((run) => run.integration?.order ?? []);
    expect(orders("DUMB_PARALLEL")[0]).toEqual(orders("DUMB_PARALLEL")[1]);
    expect(orders("ATLAS")[0]).toEqual(orders("ATLAS")[1]);

    // Stable serialization through the Zod contract.
    const revived = RealBenchmarkComparisonSchema.parse(JSON.parse(JSON.stringify(comparison)));
    expect(revived).toEqual(comparison);

    // Cleanup evidence: scratch parent holds no leftovers.
    expect(await readdir(parent)).toEqual([]);
  }, 240000);

  it("records real failure truthfully without retries", async () => {
    const parent = await makeTempDir();
    const agent = await fixtureAgent({
      login: ["--write", "src/auth/login.js=export function login() { return `WRONG`; }\n", "--commit", "wrong"],
      billing: ["--write", `src/billing/invoice.js=${BILLING_IMPL}`, "--commit", "billing"],
    });
    const comparison = await runRealBenchmark(getWorkload("realistic-independent"), {
      db,
      track,
      agent,
      repeats: 1,
      strategies: ["SINGLE_AGENT"],
      scratchParent: parent,
    });

    expect(comparison.runs).toHaveLength(1);
    const run = comparison.runs[0];
    expect(run).toBeDefined();
    expect(run?.success).toBe(false);
    // The union task ran once and failed its tests: one observation, no retry.
    expect(run?.tasks).toHaveLength(1);
    expect(run?.tasks[0]?.testStatus).toBe("FAILED");
    expect(run?.integration).toBeNull();
    expect(comparison.summaries[0]?.successfulRuns).toBe(0);
    expect(comparison.summaries[0]?.successRate).toBe(0);
    // No successful runs exist, so no median is fabricated.
    expect(comparison.summaries[0]?.medianSuccessfulWallClockMs).toBeNull();
    expect(await readdir(parent)).toEqual([]);
  }, 180000);

  it("rejects invalid experiment configuration", async () => {
    const parent = await makeTempDir();
    const agent = await fixtureAgent(goodBehaviors());
    const workload = getWorkload("realistic-independent");
    await expect(runRealBenchmark(workload, { db, track, agent, strategies: [], scratchParent: parent })).rejects.toThrow(
      /at least one strategy/,
    );
    await expect(
      runRealBenchmark(workload, { db, track, agent, strategies: ["ATLAS", "ATLAS"], scratchParent: parent }),
    ).rejects.toThrow(/duplicate strategies/);
    await expect(runRealBenchmark(workload, { db, track, agent, repeats: 0, scratchParent: parent })).rejects.toThrow(
      /repeats must be/,
    );
    const multiFeature = { ...workload, features: [{ key: "feat", title: "A" }, { key: "extra", title: "B" }] };
    await expect(
      runRealBenchmark(multiFeature, { db, track, agent, strategies: ["ATLAS"], repeats: 1, scratchParent: parent }),
    ).rejects.toThrow(/one feature/);
  });
});
