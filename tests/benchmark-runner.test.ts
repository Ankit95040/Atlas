import { readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { getPrismaClient } from "../src/db/client.js";
import {
  BenchmarkComparisonSchema,
  getScenario,
  runBenchmarkScenario,
} from "../src/benchmark/index.js";
import { track } from "./domain-helpers.js";
import { makeTempDir } from "./git-helpers.js";

const db = getPrismaClient();

async function isEmptyDir(dir: string): Promise<boolean> {
  return (await readdir(dir)).length === 0;
}

describe("benchmark runner", () => {
  it("runs a full comparison with stable JSON and clean filesystem", async () => {
    const parent = await makeTempDir();
    const comparison = await runBenchmarkScenario(getScenario("separate-auth-and-billing"), {
      db,
      track,
      scratchParent: parent,
    });

    expect(comparison.scenarioId).toBe("separate-auth-and-billing");
    expect(Object.keys(comparison.runs).sort()).toEqual(["ATLAS", "DUMB_PARALLEL", "SINGLE_AGENT"]);
    for (const strategy of ["SINGLE_AGENT", "DUMB_PARALLEL", "ATLAS"] as const) {
      const run = comparison.runs[strategy];
      expect(run).toBeDefined();
      expect(run?.provenance).toBe("fake-provider");
      expect(run?.baseCommit).toMatch(/^[0-9a-f]{40}$/);
      expect(run?.integration?.status).toBe("COMPLETED");
      expect(run?.evidence.testRunIds.length).toBeGreaterThan(0);
    }

    const atlas = comparison.runs.ATLAS;
    expect(atlas?.scheduling?.waves).toEqual([["auth", "billing"]]);
    expect(comparison.runs.SINGLE_AGENT?.scheduling).toBeNull();
    expect(comparison.runs.DUMB_PARALLEL?.scheduling).toBeNull();
    expect(typeof comparison.derived.speedupVsSingle).toBe("number");
    expect(comparison.assessment.map((finding) => finding.code)).toContain("ALL_INTEGRATED");

    // Deterministic merge order is recorded in results and evidence
    expect(comparison.runs.SINGLE_AGENT?.integration?.order).toEqual(["single"]);
    expect(comparison.runs.SINGLE_AGENT?.evidence.integrationOrder).toEqual(["single"]);
    expect(comparison.runs.DUMB_PARALLEL?.integration?.order).toEqual(["auth", "billing"]);
    expect(comparison.runs.DUMB_PARALLEL?.evidence.integrationOrder).toEqual(["auth", "billing"]);
    expect(atlas?.integration?.order).toEqual(["auth", "billing"]);
    expect(atlas?.evidence.integrationOrder).toEqual(["auth", "billing"]);
    expect(atlas?.evidence.integrationOrder).toEqual(atlas?.integration?.order);
    expect(atlas?.integration?.order).toEqual(atlas?.scheduling?.waves.flat());

    // Stable serialization: identical JSON round-trip through the Zod contract.
    const revived = BenchmarkComparisonSchema.parse(JSON.parse(JSON.stringify(comparison)));
    expect(revived).toEqual(comparison);

    // Cleanup evidence: scratch parent holds no leftovers.
    expect(await isEmptyDir(parent)).toBe(true);
  }, 180000);

  it("enforces the same-base-state invariant across strategies", async () => {
    const parent = await makeTempDir();
    const comparison = await runBenchmarkScenario(getScenario("migrate-then-use"), {
      db,
      track,
      scratchParent: parent,
      strategies: ["ATLAS", "DUMB_PARALLEL"],
    });
    // Runner asserts main HEAD + cleanliness before/after every strategy;
    // completion without BenchmarkError is the evidence, plus identical bases.
    const bases = new Set(
      [comparison.runs.ATLAS, comparison.runs.DUMB_PARALLEL].map((run) => run?.baseCommit),
    );
    expect(bases.size).toBe(1);
    expect(await isEmptyDir(parent)).toBe(true);
  }, 180000);

  it("rejects empty and duplicate strategy lists", async () => {
    const scenario = getScenario("separate-auth-and-billing");
    await expect(runBenchmarkScenario(scenario, { db, track, strategies: [] })).rejects.toThrow(/at least one strategy/);
    await expect(
      runBenchmarkScenario(scenario, { db, track, strategies: ["ATLAS", "ATLAS"] }),
    ).rejects.toThrow(/duplicate strategies/);
  });

  it("leaves no stray worktrees behind after a failing run", async () => {
    const parent = await makeTempDir();
    const comparison = await runBenchmarkScenario(getScenario("shared-counter"), {
      db,
      track,
      scratchParent: parent,
      strategies: ["DUMB_PARALLEL"],
    });
    // DUMB halts on a genuine Git conflict, yet cleanup still runs.
    expect(comparison.runs.DUMB_PARALLEL?.integration?.status).toBe("HALTED");
    expect(comparison.runs.DUMB_PARALLEL?.integration?.order).toEqual(["alpha", "beta"]);
    expect(comparison.runs.DUMB_PARALLEL?.evidence.integrationOrder).toEqual(["alpha", "beta"]);
    expect(await isEmptyDir(parent)).toBe(true);
  }, 180000);

  it("records deterministic integration order and is repeatable", async () => {
    const parent1 = await makeTempDir();
    const parent2 = await makeTempDir();
    const scenario = getScenario("migrate-then-use");
    const first = await runBenchmarkScenario(scenario, { db, track, scratchParent: parent1 });
    const second = await runBenchmarkScenario(scenario, { db, track, scratchParent: parent2 });

    // ATLAS, DUMB, SINGLE each have deterministic stable orders
    expect(first.runs.ATLAS?.integration?.order).toEqual(["schema", "client"]);
    expect(second.runs.ATLAS?.integration?.order).toEqual(first.runs.ATLAS?.integration?.order);
    expect(first.runs.ATLAS?.evidence.integrationOrder).toEqual(first.runs.ATLAS?.integration?.order);
    expect(second.runs.ATLAS?.evidence.integrationOrder).toEqual(first.runs.ATLAS?.evidence.integrationOrder);

    expect(first.runs.DUMB_PARALLEL?.integration?.order).toEqual(["client", "schema"].sort());
    expect(second.runs.DUMB_PARALLEL?.integration?.order).toEqual(first.runs.DUMB_PARALLEL?.integration?.order);

    expect(first.runs.SINGLE_AGENT?.integration?.order).toEqual(["single"]);
    expect(second.runs.SINGLE_AGENT?.integration?.order).toEqual(["single"]);

    // Mixed scenario also deterministic: shared-resource and false-parallelism
    const shared1 = await runBenchmarkScenario(getScenario("shared-counter"), { db, track, scratchParent: await makeTempDir() });
    const shared2 = await runBenchmarkScenario(getScenario("shared-counter"), { db, track, scratchParent: await makeTempDir() });
    expect(shared1.runs.ATLAS?.integration?.order).toEqual(shared2.runs.ATLAS?.integration?.order);
    expect(shared1.runs.ATLAS?.integration?.order).toHaveLength(2);
    // ATLAS order is wave-flattened; shared-counter has two waves of one each
    expect(shared1.runs.ATLAS?.scheduling?.waves.flat()).toEqual(shared1.runs.ATLAS?.integration?.order);

    const mixed1 = await runBenchmarkScenario(getScenario("mixed-pipeline"), { db, track, scratchParent: await makeTempDir() });
    const mixed2 = await runBenchmarkScenario(getScenario("mixed-pipeline"), { db, track, scratchParent: await makeTempDir() });
    expect(mixed1.runs.ATLAS?.integration?.order).toEqual(["a", "b", "c"]);
    expect(mixed2.runs.ATLAS?.integration?.order).toEqual(mixed1.runs.ATLAS?.integration?.order);
    expect(mixed1.runs.ATLAS?.scheduling?.waves.flat()).toEqual(mixed1.runs.ATLAS?.integration?.order);

    const false1 = await runBenchmarkScenario(getScenario("auth-billing-shared-config"), { db, track, scratchParent: await makeTempDir() });
    const false2 = await runBenchmarkScenario(getScenario("auth-billing-shared-config"), { db, track, scratchParent: await makeTempDir() });
    expect(false1.runs.ATLAS?.integration?.order).toEqual(false2.runs.ATLAS?.integration?.order);
    expect(false1.runs.ATLAS?.integration?.order).toHaveLength(2);
    expect(false1.runs.ATLAS?.scheduling?.waves.flat()).toEqual(false1.runs.ATLAS?.integration?.order);

    expect(await isEmptyDir(parent1)).toBe(true);
    expect(await isEmptyDir(parent2)).toBe(true);
  }, 300000);
});
