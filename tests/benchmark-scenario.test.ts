import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { runGit } from "../src/git/index.js";
import {
  BenchmarkScenarioSchema,
  buildScenarioRepo,
  getScenario,
  listScenarioIds,
  separateAuthAndBilling,
} from "../src/benchmark/index.js";
import { BenchmarkError } from "../src/benchmark/index.js";
import { makeTempDir } from "./git-helpers.js";

async function treeContents(dir: string): Promise<Array<[string, string]>> {
  const result = await runGit(["ls-files"], { cwd: dir });
  const paths = result.stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0).sort();
  const out: Array<[string, string]> = [];
  for (const path of paths) {
    out.push([path, await readFile(join(dir, path), "utf8")]);
  }
  return out;
}

describe("benchmark scenarios", () => {
  it("lists the six built-in scenarios", () => {
    expect(listScenarioIds()).toEqual([
      "auth-billing-shared-config",
      "cross-feature-api-web",
      "migrate-then-use",
      "mixed-pipeline",
      "separate-auth-and-billing",
      "shared-counter",
    ]);
  });

  it("parses every built-in scenario with the right kind", () => {
    const kinds: Record<string, string> = {
      "separate-auth-and-billing": "INDEPENDENT_TASKS",
      "shared-counter": "SHARED_RESOURCE",
      "migrate-then-use": "DEPENDENCY_CHAIN",
      "mixed-pipeline": "MIXED",
      "cross-feature-api-web": "CROSS_FEATURE_DEPENDENCY",
      "auth-billing-shared-config": "FALSE_PARALLELISM",
    };
    for (const id of listScenarioIds()) {
      const scenario = getScenario(id);
      expect(scenario.id).toBe(id);
      expect(scenario.kind).toBe(kinds[id]);
      expect(scenario.tasks.length).toBeGreaterThan(0);
    }
  });

  it("rejects unknown scenario ids", () => {
    expect(() => getScenario("nope")).toThrow(BenchmarkError);
  });

  it("rejects malformed scenarios", () => {
    const base = separateAuthAndBilling();
    const firstTask = base.tasks[0];
    const secondTask = base.tasks[1];
    if (firstTask === undefined || secondTask === undefined) {
      throw new Error("fixture tasks missing");
    }
    expect(() => BenchmarkScenarioSchema.parse({ ...base, tasks: [] })).toThrow(ZodError);
    expect(() =>
      BenchmarkScenarioSchema.parse({ ...base, tasks: [{ ...firstTask, dependsOn: ["ghost"] }] }),
    ).toThrow(ZodError);
    expect(() =>
      BenchmarkScenarioSchema.parse({ ...base, tasks: [{ ...firstTask, dependsOn: [firstTask.key] }] }),
    ).toThrow(ZodError);
    expect(() =>
      BenchmarkScenarioSchema.parse({
        ...base,
        tasks: [
          { ...firstTask, key: "dup" },
          { ...secondTask, key: "dup" },
        ],
      }),
    ).toThrow(ZodError);
    expect(() =>
      BenchmarkScenarioSchema.parse({ ...base, tasks: [{ ...firstTask, files: [{ path: "../escape.txt", content: "x" }] }] }),
    ).toThrow(ZodError);
    expect(() =>
      BenchmarkScenarioSchema.parse({ ...base, tasks: [{ ...firstTask, claims: [{ resource: "x", access: "DELETE" }] }] }),
    ).toThrow(ZodError);
  });

  it("builds deterministic fixture trees (contents, not SHAs)", async () => {
    const scenario = separateAuthAndBilling();
    const first = await buildScenarioRepo(scenario, await makeTempDir());
    const second = await buildScenarioRepo(scenario, await makeTempDir());
    expect(await treeContents(first.repoDir)).toEqual(await treeContents(second.repoDir));
    expect(first.baseCommit).toMatch(/^[0-9a-f]{40}$/);
    const checkMjs = await readFile(join(first.repoDir, "check.mjs"), "utf8");
    expect(checkMjs).toBe(scenario.testScript);
  });
});
