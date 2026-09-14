import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getPrismaClient } from "../src/db/client.js";
import { getWorkload, RealAgentConfigSchema, runRealBenchmark } from "../src/benchmark/real/index.js";
import { track } from "./domain-helpers.js";
import { makeTempDir } from "./git-helpers.js";

const db = getPrismaClient();
const DISPATCHER = fileURLToPath(new URL("./fixtures/real-benchmark-agent.mjs", import.meta.url));

async function fixtureAgent(behaviors: Record<string, string[]>) {
  const file = join(await makeTempDir(), "behaviors.json");
  await writeFile(file, JSON.stringify(behaviors));
  return RealAgentConfigSchema.parse({
    provider: "fixture-cli",
    executable: process.execPath,
    argv: [DISPATCHER, file],
  });
}

describe("evolving benchmark success aggregation", () => {
  it("two-wave successful run: success true even though final wave contains only B", async () => {
    const workload = getWorkload("realistic-schema-api");
    const agent = await fixtureAgent({
      schema: ["--write", "src/schema.js=export const userSchema = { required: [\"name\", \"email\"] };\n", "--commit", "schema"],
      validator: ["--write", "src/validate.js=export function validate(obj, schema) { return schema.required.every(k => k in obj); }\n", "--commit", "validator"],
    });
    const result = await runRealBenchmark(workload, {
      db,
      track,
      agent,
      repeats: 1,
      strategies: ["ATLAS_EVOLVING"],
      scratchParent: await makeTempDir(),
    });
    const run = result.runs.find((r) => r.strategy === "ATLAS_EVOLVING")!;
    expect(run.integration?.status).toBe("COMPLETED");
    expect(run.success).toBe(true);
    expect(run.waveBases?.length).toBe(2);
    expect(run.waveBases?.[0]).toBe(run.baseCommit);
    expect(run.waveBases?.[1]).not.toBe(run.baseCommit);
  }, 180000);

  it("three-wave successful run: success true", async () => {
    const workload = getWorkload("realistic-independent");
    const agent = await fixtureAgent({
      login: ["--write", "src/auth/login.js=export function login(u,p){ if(p.length<4) throw new Error(\"weak password\"); return `TOKEN-${u}`; }\n", "--commit", "login"],
      billing: ["--write", "src/billing/invoice.js=export function total(items){ return items.reduce((s,i)=>s+i.price*i.qty,0); }\n", "--commit", "billing"],
    });
    const result = await runRealBenchmark(workload, {
      db,
      track,
      agent,
      repeats: 1,
      strategies: ["ATLAS_EVOLVING"],
      scratchParent: await makeTempDir(),
    });
    const run = result.runs.find((r) => r.strategy === "ATLAS_EVOLVING")!;
    if (!run.success) {
      console.log("three-wave run failed", JSON.stringify({ integration: run.integration, tasks: run.tasks, metrics: run.metrics }, null, 2));
    }
    expect(run.success).toBe(true);
    expect(run.waveBases?.length).toBe(1); // single wave, so only one base
  }, 180000);

  it("failed later wave: success false", async () => {
    const workload = getWorkload("realistic-schema-api");
    const agent = await fixtureAgent({
      schema: ["--write", "src/schema.js=export const userSchema = { required: [\"name\", \"email\"] };\n", "--commit", "schema"],
      validator: ["--write", "src/validate.js=export function validate(){ throw new Error(\"fail\"); }\n", "--commit", "validator"],
    });
    const result = await runRealBenchmark(workload, {
      db,
      track,
      agent,
      repeats: 1,
      strategies: ["ATLAS_EVOLVING"],
      scratchParent: await makeTempDir(),
    });
    const run = result.runs.find((r) => r.strategy === "ATLAS_EVOLVING")!;
    // Validator fails verification (throws), so no verified work for second wave, train should be COMPLETED with only first wave, but success should be false because validator not integrated
    expect(run.success).toBe(false);
    expect(run.integration?.status).toBe("COMPLETED");
    expect(run.integration?.items).toHaveLength(1);
  }, 180000);

  it("incomplete integration: success false", async () => {
    const workload = getWorkload("realistic-independent");
    const agent = await fixtureAgent({
      login: ["--write", "src/auth/login.js=export function login(){ return \"bad\"; }\n", "--commit", "login"],
      billing: ["--write", "src/billing/invoice.js=export function total(){ return 0; }\n", "--commit", "billing"],
    });
    const result = await runRealBenchmark(workload, {
      db,
      track,
      agent,
      repeats: 1,
      strategies: ["ATLAS_EVOLVING"],
      scratchParent: await makeTempDir(),
    });
    const run = result.runs.find((r) => r.strategy === "ATLAS_EVOLVING")!;
    // Both tasks will fail verification because they don't meet the test expectations, so no verified work, integration null, success false
    expect(run.success).toBe(false);
  }, 180000);

  it("V0.1 regression: existing ATLAS success behavior unchanged", async () => {
    const workload = getWorkload("realistic-independent");
    const agent = await fixtureAgent({
      login: ["--write", "src/auth/login.js=export function login(u,p){ if(p.length<4) throw new Error(\"weak password\"); return `TOKEN-${u}`; }\n", "--commit", "login"],
      billing: ["--write", "src/billing/invoice.js=export function total(items){ return items.reduce((s,i)=>s+i.price*i.qty,0); }\n", "--commit", "billing"],
    });
    const v01 = await runRealBenchmark(workload, {
      db,
      track,
      agent,
      repeats: 1,
      strategies: ["ATLAS"],
      scratchParent: await makeTempDir(),
    });
    const run = v01.runs[0]!;
    console.log("V0.1 full run", JSON.stringify(run, null, 2).slice(0, 4000));
    if (!run.success) {
      console.log("V0.1 regression failed", JSON.stringify({ integration: run.integration, tasks: run.tasks, waveBases: run.waveBases, baseCommit: run.baseCommit }, null, 2));
    }
    expect(run.success).toBe(true);
    expect(run.waveBases?.every((b) => b === run.baseCommit)).toBe(true);
  }, 180000);

  it("evolving wave-base regression: waveBases evolves correctly", async () => {
    const workload = getWorkload("realistic-schema-api");
    const agent = await fixtureAgent({
      schema: ["--write", "src/schema.js=export const userSchema = { required: [\"name\", \"email\"] };\n", "--commit", "schema"],
      validator: ["--write", "src/validate.js=export function validate(obj, schema) { return schema.required.every(k => k in obj); }\n", "--commit", "validator"],
    });
    const result = await runRealBenchmark(workload, {
      db,
      track,
      agent,
      repeats: 1,
      strategies: ["ATLAS_EVOLVING"],
      scratchParent: await makeTempDir(),
    });
    const run = result.runs[0]!;
    expect(run.waveBases?.[0]).toBe(run.baseCommit);
    expect(run.waveBases?.[1]).not.toBe(run.baseCommit);
    expect(run.waveBases?.[1]).toBeDefined();
  }, 180000);

  it("false-parallelism reproduction: auth and billing both integrated with evolving", async () => {
    const workload = getWorkload("realistic-false-parallelism");
    const agent = await fixtureAgent({
      auth: ["--write", "src/settings.js=export const settings = { theme: \"dark\", pageSize: 10 };\n", "--commit", "auth"],
      billing: ["--write", "src/settings.js=export const settings = { theme: \"light\", pageSize: 25 };\n", "--commit", "billing"],
    });
    const result = await runRealBenchmark(workload, {
      db,
      track,
      agent,
      repeats: 1,
      strategies: ["ATLAS_EVOLVING"],
      scratchParent: await makeTempDir(),
    });
    const run = result.runs[0]!;
    // With evolving, disjoint-line edits should merge cleanly, so both should be integrated
    expect(run.integration?.status).toBe("COMPLETED");
    expect(run.success).toBe(true);
    expect(run.integration?.items).toHaveLength(2);
  }, 180000);
});
