import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getPrismaClient } from "../src/db/client.js";
import { RealAgentConfigSchema } from "../src/benchmark/real/index.js";
import {
  completedScaleRuns,
  getScaleWorkload,
  loadScaleState,
  runScaleWorkload,
} from "../src/benchmark/scale/index.js";
import { buildScaleFixture } from "../src/benchmark/scale/runner.js";
import { track } from "./domain-helpers.js";
import { makeTempDir } from "./git-helpers.js";

const db = getPrismaClient();
const DISPATCHER = fileURLToPath(new URL("./fixtures/real-benchmark-agent.mjs", import.meta.url));

const FORMAT_IMPL = `export function formatPrice(cents) {
  const dollars = Math.floor(cents / 100);
  const rest = String(cents % 100).padStart(2, "0");
  return \`$\${dollars}.\${rest}\`;
}
`;

const CART_IMPL = `export function total(items) {
  return items.reduce((sum, item) => sum + item.price * item.qty, 0);
}
`;

const SHOUT_IMPL = `export function shout(s) {
  return s.toUpperCase() + "!";
}
`;

async function fixtureAgent() {
  const file = join(await makeTempDir(), "behaviors.json");
  await writeFile(
    file,
    JSON.stringify({
      format: ["--write", `src/format.js=${FORMAT_IMPL}`, "--commit", "format"],
      cart: ["--write", `src/cart.js=${CART_IMPL}`, "--commit", "cart"],
      shout: ["--write", `src/shout.js=${SHOUT_IMPL}`, "--commit", "shout"],
    }),
  );
  return RealAgentConfigSchema.parse({
    provider: "fixture-cli",
    executable: process.execPath,
    argv: [DISPATCHER, file],
    model: "fixture-1.0",
    version: "test",
    temperature: 0,
  });
}

describe("scale runner", () => {
  it("runs both M18 arms with survival gating and resumable persistence", async () => {
    const parent = await makeTempDir();
    const stateDir = await makeTempDir();
    const statePath = join(stateDir, "m18.json");
    const agent = await fixtureAgent();

    const state = await runScaleWorkload(getScaleWorkload("scale-small-catalog"), {
      db,
      track,
      agent,
      repeats: 1,
      scratchParent: parent,
      statePath,
    });

    expect(completedScaleRuns(state)).toBe(2);
    const comparison = state.workloads["scale-small-catalog"];
    expect(comparison).toBeDefined();
    expect(comparison?.summaries).toHaveLength(2);
    for (const run of comparison?.runs ?? []) {
      // Deterministic fixture CLI: every cell succeeds with all contributions alive.
      expect(run.success).toBe(true);
      expect(run.successPredicates).toEqual({
        workerCompletion: true,
        featureCorrectness: true,
        regression: true,
        survival: true,
        noIntervention: true,
      });
      expect(run.survival.map((entry) => entry.status)).toEqual(["SURVIVED", "SURVIVED", "SURVIVED"]);
      expect(run.survivalRate).toBe(1);
      expect(run.humanInterventions).toBe(0);
      expect(run.regressionPassed).toBeNull();
      expect(run.usage).toEqual({ tokens: null, costUsd: null });
      expect(run.integration?.status).toBe("COMPLETED");
    }
    for (const summary of comparison?.summaries ?? []) {
      expect(summary.successRate).toBe(1);
      expect(summary.meanSurvivalRate).toBe(1);
    }

    // Resume loads the same cells and runs nothing new.
    const resumed = await runScaleWorkload(getScaleWorkload("scale-small-catalog"), {
      db,
      track,
      agent,
      repeats: 1,
      scratchParent: parent,
      statePath,
    });
    expect(completedScaleRuns(resumed)).toBe(2);
    const reloaded = await loadScaleState(statePath);
    expect(reloaded?.workloads["scale-small-catalog"]?.runs).toHaveLength(2);
  }, 240000);

  it("rejects out-of-matrix configuration", async () => {
    const parent = await makeTempDir();
    const agent = await fixtureAgent();
    const workload = getScaleWorkload("scale-small-catalog");
    await expect(
      runScaleWorkload(workload, { db, track, agent, strategies: ["DUMB_PARALLEL"], scratchParent: parent }),
    ).rejects.toThrow(/outside the M18 design matrix/);
    await expect(
      runScaleWorkload(workload, { db, track, agent, strategies: [], scratchParent: parent }),
    ).rejects.toThrow(/at least one strategy/);
    await expect(runScaleWorkload(workload, { db, track, agent, repeats: 0, scratchParent: parent })).rejects.toThrow(
      /repeats must be/,
    );
    await expect(
      runScaleWorkload(workload, { db, track, agent, repeats: 1, workerTimeoutMs: 100, scratchParent: parent }),
    ).rejects.toThrow(/workerTimeoutMs/);
  });

  it("writes .gitignore to protect fixture from agent file writes", async () => {
    const dir = await makeTempDir();
    const workload = getScaleWorkload("scale-small-catalog");
    const { repoDir } = await buildScaleFixture(workload, dir);
    const gitignore = await readFile(join(repoDir, ".gitignore"), "utf8");
    expect(gitignore).toContain("node_modules/");
    expect(gitignore).toContain("dist/");
    expect(gitignore).toContain("build/");
  });

  it("captures setup evidence and context in run results", async () => {
    const parent = await makeTempDir();
    const stateDir = await makeTempDir();
    const statePath = join(stateDir, "m18.json");
    const agent = await fixtureAgent();

    const state = await runScaleWorkload(getScaleWorkload("scale-small-catalog"), {
      db,
      track,
      agent,
      repeats: 1,
      scratchParent: parent,
      statePath,
    });

    const comparison = state.workloads["scale-small-catalog"];
    expect(comparison).toBeDefined();
    // Context is recorded on every run.
    for (const run of comparison?.runs ?? []) {
      expect(run.context).toBeDefined();
      expect(run.context.estimatorVersion).toBe(1);
      expect(run.context.modelCapacityTokens).toBe(200_000);
      expect(run.context.repoTokens).toBeGreaterThanOrEqual(0);
      expect(run.context.taskRelevantTokens).toBeGreaterThanOrEqual(0);
      expect(run.context.promptTokensMax).toBeGreaterThanOrEqual(0);
      expect(run.context.promptTokensMean).toBeGreaterThanOrEqual(0);
      expect(run.context.utilizationMax).toBeGreaterThanOrEqual(0);
    }
    // Setup evidence is recorded in state meta.
    expect(state.meta.setupEvidence).not.toBeNull();
    expect(state.meta.setupEvidence?.nodeVersion).toMatch(/^v/);
  }, 240000);

  it("builds snapshot fixtures from clean trees only", async () => {
    const source = await makeTempDir();
    await mkdir(join(source, "src"), { recursive: true });
    await writeFile(join(source, "src", "base.js"), "export const base = 1;\n");
    const dir = await makeTempDir();
    const workload = getScaleWorkload("scale-small-catalog");
    const withSnapshot = {
      ...workload,
      snapshot: { sourceDir: source, ref: "test-fixture", note: "vendored test tree" },
    };
    const { repoDir, baseCommit } = await buildScaleFixture(withSnapshot, dir);
    expect(baseCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(repoDir).toBe(dir);

    const dirty = await makeTempDir();
    await mkdir(join(dirty, ".git"));
    await expect(
      buildScaleFixture({ ...workload, snapshot: { sourceDir: dirty, ref: "x", note: "dirty" } }, await makeTempDir()),
    ).rejects.toThrow(/without .git/);
    await expect(
      buildScaleFixture(
        { ...workload, snapshot: { sourceDir: join(source, "missing"), ref: "x", note: "missing" } },
        await makeTempDir(),
      ),
    ).rejects.toThrow(/not a directory/);
  });
});
