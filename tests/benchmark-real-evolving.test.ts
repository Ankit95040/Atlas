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

describe("real benchmark evolving base", () => {
  it("ATLAS_EVOLVING uses evolving wave bases while ATLAS V0.1 does not", async () => {
    const workload = getWorkload("realistic-false-parallelism");
    const file = join(await makeTempDir(), "behaviors.json");
    await writeFile(
      file,
      JSON.stringify({
        auth: ["--write", "src/settings.js=export const settings = { theme: \"dark\", pageSize: 10 };\n", "--commit", "auth"],
        billing: ["--write", "src/settings.js=export const settings = { theme: \"light\", pageSize: 25 };\n", "--commit", "billing"],
      }),
    );
    const agent = RealAgentConfigSchema.parse({
      provider: "fixture-cli",
      executable: process.execPath,
      argv: [DISPATCHER, file],
    });

    const v01 = await runRealBenchmark(workload, {
      db,
      track,
      agent,
      repeats: 1,
      strategies: ["ATLAS"],
      scratchParent: await makeTempDir(),
    });
    const v02 = await runRealBenchmark(workload, {
      db,
      track,
      agent,
      repeats: 1,
      strategies: ["ATLAS_EVOLVING"],
      scratchParent: await makeTempDir(),
    });

    const v01Run = v01.runs.find((r) => r.strategy === "ATLAS")!;
    const v02Run = v02.runs.find((r) => r.strategy === "ATLAS_EVOLVING")!;

    // V0.1: both waves based on same original base, so second wave conflicts and HALTED
    expect(v01Run.integration?.status).toBe("HALTED");
    expect(v01Run.triageClassifications).toContain("GIT_CONFLICT");
    // V0.2: second wave based on first wave's train head, so disjoint-line edits merge cleanly
    expect(v02Run.integration?.status).toBe("COMPLETED");
    expect(v02Run.waveBases).toBeDefined();
    expect(v02Run.waveBases?.length).toBeGreaterThan(1);
    expect(v02Run.waveBases![0]).not.toBe(v02Run.waveBases![1]);
    // Both should have same scheduling decision (serialized)
    expect(v01Run.scheduling?.waves).toEqual([["auth"], ["billing"]]);
    expect(v02Run.scheduling?.waves).toEqual([["auth"], ["billing"]]);
  }, 180000);
});
