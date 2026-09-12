import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { runGit } from "../src/git/index.js";
import {
  RealWorkloadSpecSchema,
  buildRealFixture,
  getWorkload,
  listWorkloadIds,
} from "../src/benchmark/real/index.js";
import { BenchmarkError } from "../src/benchmark/errors.js";
import { makeTempDir } from "./git-helpers.js";

const EXPECTED_KINDS: Record<string, string> = {
  "realistic-independent": "REALISTIC_INDEPENDENT",
  "realistic-shared-config": "REALISTIC_SHARED_RESOURCE",
  "realistic-schema-api": "REALISTIC_DEPENDENCY_CHAIN",
  "realistic-mixed": "REALISTIC_MIXED",
  "realistic-false-parallelism": "REALISTIC_FALSE_PARALLELISM",
  "realistic-order-sensitive": "REALISTIC_INTEGRATION_CONFLICT",
};

async function treeContents(dir: string): Promise<Array<[string, string]>> {
  const result = await runGit(["ls-files"], { cwd: dir });
  const paths = result.stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0).sort();
  const out: Array<[string, string]> = [];
  for (const path of paths) {
    out.push([path, await readFile(join(dir, path), "utf8")]);
  }
  return out;
}

describe("real benchmark workloads", () => {
  it("lists the six built-in workloads with the right kinds", () => {
    expect(listWorkloadIds()).toEqual(Object.keys(EXPECTED_KINDS).sort());
    for (const id of listWorkloadIds()) {
      const workload = getWorkload(id);
      expect(workload.id).toBe(id);
      expect(workload.kind).toBe(EXPECTED_KINDS[id]);
      expect(workload.tasks.length).toBeGreaterThan(0);
      expect(workload.testCommand.length).toBeGreaterThan(0);
      for (const task of workload.tasks) {
        expect(task.description.length).toBeGreaterThan(0);
        expect(task.claims.length).toBeGreaterThan(0);
      }
    }
  });

  it("rejects unknown workload ids", () => {
    expect(() => getWorkload("nope")).toThrow(BenchmarkError);
  });

  it("rejects malformed workloads", () => {
    const base = getWorkload("realistic-independent");
    const firstTask = base.tasks[0];
    if (firstTask === undefined) {
      throw new Error("fixture tasks missing");
    }
    expect(() => RealWorkloadSpecSchema.parse({ ...base, tasks: [] })).toThrow(ZodError);
    expect(() =>
      RealWorkloadSpecSchema.parse({ ...base, tasks: [{ ...firstTask, dependsOn: ["ghost"] }] }),
    ).toThrow(ZodError);
    expect(() => RealWorkloadSpecSchema.parse({ ...base, tasks: [{ ...firstTask, dependsOn: [firstTask.key] }] })).toThrow(
      ZodError,
    );
    expect(() =>
      RealWorkloadSpecSchema.parse({ ...base, baseFiles: [{ path: "/absolute.txt", content: "x" }] }),
    ).toThrow(ZodError);
    expect(() =>
      RealWorkloadSpecSchema.parse({ ...base, testFiles: [{ path: "../escape.txt", content: "x" }] }),
    ).toThrow(ZodError);
  });

  it("builds deterministic fixture trees with real test files", async () => {
    const workload = getWorkload("realistic-schema-api");
    const first = await buildRealFixture(workload, await makeTempDir());
    const second = await buildRealFixture(workload, await makeTempDir());
    expect(await treeContents(first.repoDir)).toEqual(await treeContents(second.repoDir));
    expect(first.baseCommit).toMatch(/^[0-9a-f]{40}$/);
    const testPaths = (await treeContents(first.repoDir)).map(([path]) => path).filter((path) => path.endsWith(".test.mjs"));
    expect(testPaths.length).toBeGreaterThan(0);
  });

  it("every workload dependency graph is acyclic and claim-bearing", () => {
    for (const id of listWorkloadIds()) {
      const workload = getWorkload(id);
      const keys = new Set(workload.tasks.map((task) => task.key));
      const visited = new Set<string>();
      const visit = (key: string, stack: string[]): void => {
        if (stack.includes(key)) {
          throw new Error(`cycle at ${key}`);
        }
        if (visited.has(key)) {
          return;
        }
        visited.add(key);
        for (const dep of workload.tasks.find((task) => task.key === key)?.dependsOn ?? []) {
          if (!keys.has(dep)) {
            throw new Error(`unknown dep ${dep}`);
          }
          visit(dep, [...stack, key]);
        }
      };
      for (const key of keys) {
        visit(key, []);
      }
    }
  });
});
