import { describe, expect, it } from "vitest";
import { getPrismaClient } from "../src/db/client.js";
import { buildScenarioRepo, getScenario } from "../src/benchmark/index.js";
import type { StrategyContext } from "../src/benchmark/strategies.js";
import { runAtlas, runDumbParallel, runSingleAgent } from "../src/benchmark/strategies.js";
import { runGit } from "../src/git/index.js";
import { track } from "./domain-helpers.js";
import { makeTempDir } from "./git-helpers.js";

const db = getPrismaClient();

async function mergeParents(repoDir: string, sha: string): Promise<string[]> {
  const result = await runGit(["log", "--format=%P", "-n", "1", sha], { cwd: repoDir });
  return result.stdout.trim().split(/\s+/).filter((parent) => parent.length > 0);
}

function keyOf(out: { executed: Array<{ key: string; taskId: string }> }, taskId: string): string | undefined {
  return out.executed.find((task) => task.taskId === taskId)?.key;
}

async function strategyContext(scenarioId: string, runId: string): Promise<StrategyContext> {
  const scenario = getScenario(scenarioId);
  const fixtureRoot = await makeTempDir();
  const { repoDir, baseCommit } = await buildScenarioRepo(scenario, fixtureRoot);
  const scratchRoot = await makeTempDir();
  return { db, scenario, repoDir, baseCommit, runId, scratchRoot, track };
}

describe("benchmark strategies", () => {
  it("runs all three strategies on independent tasks with identical work", async () => {
    const single = await strategyContext("separate-auth-and-billing", "strat-single");
    const singleOut = await runSingleAgent(single);
    expect(singleOut.integration.status).toBe("COMPLETED");
    expect(singleOut.executed).toHaveLength(1);
    expect(singleOut.peakConcurrency).toBe(1);
    expect(singleOut.integrationOrder).toEqual(["single"]);

    const dumb = await strategyContext("separate-auth-and-billing", "strat-dumb");
    const dumbOut = await runDumbParallel(dumb);
    expect(dumbOut.integration.status).toBe("COMPLETED");
    expect(dumbOut.executed).toHaveLength(2);
    expect(dumbOut.peakConcurrency).toBe(2);
    // DUMB uses explicit stable scenario-key order (sorted)
    expect(dumbOut.integrationOrder).toEqual(["auth", "billing"]);

    const atlas = await strategyContext("separate-auth-and-billing", "strat-atlas");
    const atlasOut = await runAtlas(atlas);
    expect(atlasOut.integration.status).toBe("COMPLETED");
    expect(atlasOut.waves.map((wave) => [...wave].sort())).toEqual([["auth", "billing"]]);
    expect(atlasOut.conflicts).toEqual([]);
    expect(atlasOut.peakConcurrency).toBe(2);
    // ATLAS uses wave-flattened scenario-key order; here single wave so same as DUMB
    expect(atlasOut.integrationOrder).toEqual(atlasOut.waves.flat());
    expect(atlasOut.integrationOrder).toEqual(["auth", "billing"]);
    expect(atlasOut.integrationOrder).toEqual(dumbOut.integrationOrder);
  }, 180000);

  it("serializes shared resources under ATLAS and conflicts under DUMB", async () => {
    const atlasCtx = await strategyContext("shared-counter", "strat-shared-atlas");
    const atlasOut = await runAtlas(atlasCtx);
    expect(atlasOut.waves).toHaveLength(2);
    expect(atlasOut.waves.map((wave) => wave.length)).toEqual([1, 1]);
    expect(atlasOut.conflicts).toEqual([["alpha", "beta"]]);
    // Serialization is the correct decision, not a cure: the second merge
    // still conflicts because both branches rewrote the same lines.
    // Integration follows the scheduler's wave order exactly: the first
    // wave's task integrates, the second wave's task conflicts.
    expect(atlasOut.integration.status).toBe("HALTED");
    const atlasIntegrated = atlasOut.integration.items.filter((item) => item.status === "INTEGRATED");
    const atlasConflicted = atlasOut.integration.items.filter((item) => item.status === "CONFLICT");
    expect(atlasIntegrated).toHaveLength(1);
    expect(atlasConflicted).toHaveLength(1);
    expect(atlasOut.waves.flat()).toHaveLength(2);
    expect(atlasIntegrated.map((item) => keyOf(atlasOut, item.taskId))).toEqual([atlasOut.waves.flat()[0]]);
    expect(atlasConflicted.map((item) => keyOf(atlasOut, item.taskId))).toEqual([atlasOut.waves.flat()[1]]);
    // Exact integration order must be wave-flattened scenario-key order
    expect(atlasOut.integrationOrder).toEqual(atlasOut.waves.flat());
    expect(atlasOut.integrationOrder).toHaveLength(2);
    // Verify Git parent chain matches effective order: second task's merge would conflict, so only first merges
    // but order is still recorded deterministically.

    const dumbCtx = await strategyContext("shared-counter", "strat-shared-dumb");
    const dumbOut = await runDumbParallel(dumbCtx);
    expect(dumbOut.integration.status).toBe("HALTED");
    const conflicted = dumbOut.integration.items.filter((item) => item.status === "CONFLICT");
    const integrated = dumbOut.integration.items.filter((item) => item.status === "INTEGRATED");
    expect(conflicted).toHaveLength(1);
    expect(integrated).toHaveLength(1);
    expect(conflicted[0]?.reason ?? "").toContain("shared/counter.txt");
    // DUMB uses explicit stable scenario-key order (sorted)
    expect(dumbOut.integrationOrder).toEqual(["alpha", "beta"]);
    // Integration order is deterministic: first sorted key integrates, second conflicts
    expect(integrated.map((item) => keyOf(dumbOut, item.taskId))).toEqual([dumbOut.integrationOrder[0]]);
    expect(conflicted.map((item) => keyOf(dumbOut, item.taskId))).toEqual([dumbOut.integrationOrder[1]]);
  }, 180000);

  it("respects dependency order in chains", async () => {
    const ctx = await strategyContext("migrate-then-use", "strat-chain");
    const out = await runAtlas(ctx);
    expect(out.waves).toEqual([["schema"], ["client"]]);
    expect(out.integration.status).toBe("COMPLETED");
    expect(out.integrationOrder).toEqual(["schema", "client"]);
    expect(out.integrationOrder).toEqual(out.waves.flat());
    // Verify Git parent chain matches order: client merge's parents contain schema merge
    const mergeOf = new Map(
      out.integration.items.filter((item) => item.mergeCommit !== undefined).map((item) => [keyOf(out, item.taskId), item.mergeCommit as string]),
    );
    expect(await mergeParents(ctx.repoDir, mergeOf.get("client") ?? "")).toContain(mergeOf.get("schema") ?? "");
  }, 180000);

  it("finds partial parallelism in mixed graphs", async () => {
    const ctx = await strategyContext("mixed-pipeline", "strat-mixed");
    const out = await runAtlas(ctx);
    expect(out.waves.map((wave) => [...wave].sort()).sort()).toEqual([["a", "b"], ["c"]]);
    // Integration follows the scheduler's wave order exactly: the first
    // wave's task (a, then b) merges cleanly, then c conflicts with b's
    // identical-line edit.
    expect(out.integration.status).toBe("HALTED");
    expect(out.integration.items).toHaveLength(3);
    expect(out.waves.flat()).toEqual(["a", "b", "c"]);
    expect(out.integrationOrder).toEqual(["a", "b", "c"]);
    expect(out.integrationOrder).toEqual(out.waves.flat());
    const byKey = new Map(out.integration.items.map((item) => [keyOf(out, item.taskId), item]));
    expect(byKey.get("a")?.status).toBe("INTEGRATED");
    expect(byKey.get("b")?.status).toBe("INTEGRATED");
    expect(byKey.get("c")?.status).toBe("CONFLICT");
    expect(byKey.get("c")?.reason ?? "").toContain("src/b.txt");
    // Parent chain proves processing order: c never merged, a and b did.
    const mergeOf = new Map(
      out.integration.items.filter((item) => item.mergeCommit !== undefined).map((item) => [keyOf(out, item.taskId), item.mergeCommit as string]),
    );
    expect(await mergeParents(ctx.repoDir, mergeOf.get("b") ?? "")).toContain(mergeOf.get("a") ?? "");
    // Effective order is exactly wave-flattened: a first, b second, c (conflicted) last
    expect(out.integrationOrder[0]).toBe("a");
    expect(out.integrationOrder[1]).toBe("b");
    expect(out.integrationOrder[2]).toBe("c");
  }, 180000);

  it("handles cross-feature dependencies", async () => {
    const ctx = await strategyContext("cross-feature-api-web", "strat-cross");
    const out = await runAtlas(ctx);
    expect(out.waves).toEqual([["api"], ["web"]]);
    expect(out.integration.status).toBe("COMPLETED");
  }, 180000);

  it("detects false parallelism from claims despite unrelated labels", async () => {
    const ctx = await strategyContext("auth-billing-shared-config", "strat-false-atlas");
    const out = await runAtlas(ctx);
    expect(out.waves).toHaveLength(2);
    expect(out.conflicts).toEqual([["auth", "billing"]]);
    expect(out.integration.status).toBe("HALTED");
    // Exact integration order: the train follows the scheduler's wave order,
    // so the first wave's task integrates and the second wave's conflicts.
    expect(out.waves.flat()).toHaveLength(2);
    const byKey = new Map(out.integration.items.map((item) => [keyOf(out, item.taskId), item]));
    expect(byKey.get(out.waves.flat()[0])?.status).toBe("INTEGRATED");
    expect(byKey.get(out.waves.flat()[1])?.status).toBe("CONFLICT");
    expect(out.integrationOrder).toEqual(out.waves.flat());
    expect(out.integrationOrder).toHaveLength(2);

    const dumbCtx = await strategyContext("auth-billing-shared-config", "strat-false-dumb");
    const dumbOut = await runDumbParallel(dumbCtx);
    expect(dumbOut.integration.status).toBe("HALTED");
    expect(dumbOut.integration.items.filter((item) => item.status === "CONFLICT")).toHaveLength(1);
    expect(dumbOut.integrationOrder).toEqual(["auth", "billing"]);
    expect(dumbOut.integrationOrder).toEqual([...dumbOut.integrationOrder].sort());
    // DUMB parallel also deterministic sorted order, but still HALTED
    expect(dumbOut.integrationOrder).toHaveLength(2);
  }, 180000);

  it("produces identical integration order on repeated identical inputs", async () => {
    async function processingOrder(runId: string): Promise<{ waves: string[][]; order: string[]; integrationOrder: string[] }> {
      const ctx = await strategyContext("migrate-then-use", runId);
      const out = await runAtlas(ctx);
      expect(out.integration.status).toBe("COMPLETED");
      const mergeOf = new Map(
        out.integration.items
          .filter((item) => item.mergeCommit !== undefined)
          .map((item) => [keyOf(out, item.taskId), item.mergeCommit as string]),
      );
      // Chain the merges child→parent: the later merge's parents contain the
      // earlier. Wave order is [[schema],[client]], so schema merges first.
      const clientMerge = mergeOf.get("client") ?? "";
      const schemaMerge = mergeOf.get("schema") ?? "";
      expect(clientMerge).toMatch(/^[0-9a-f]{40}$/);
      expect(schemaMerge).toMatch(/^[0-9a-f]{40}$/);
      expect(await mergeParents(ctx.repoDir, clientMerge)).toContain(schemaMerge);
      // Effective order must be deterministic and equal to waves.flat()
      expect(out.integrationOrder).toEqual(out.waves.flat());
      expect(out.integrationOrder).toEqual(["schema", "client"]);
      return { waves: out.waves, order: ["schema", "client"], integrationOrder: out.integrationOrder };
    }

    const first = await processingOrder("strat-determinism-1");
    const second = await processingOrder("strat-determinism-2");
    expect(first.waves).toEqual([["schema"], ["client"]]);
    expect(second.waves).toEqual(first.waves);
    expect(second.order).toEqual(first.order);
    expect(second.integrationOrder).toEqual(first.integrationOrder);
    expect(first.integrationOrder).toEqual(["schema", "client"]);
  }, 180000);
});
