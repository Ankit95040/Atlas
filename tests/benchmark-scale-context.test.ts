import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderSingleAgentPrompt, renderTaskPrompt } from "../src/benchmark/real/prompts.js";
import {
  TOKEN_ESTIMATOR_VERSION,
  assembleContextRecord,
  estimateTokens,
  measurePromptTokensFromPromptString,
  measureRepoTokens,
  measureTaskRelevantTokens,
  renderAeTaskPrompt,
  renderSaUnionPrompt,
} from "../src/benchmark/scale/context.js";
import type { ScaleWorkloadSpec } from "../src/benchmark/scale/types.js";
import { makeTempDir } from "./git-helpers.js";

function testScaleWorkload(): ScaleWorkloadSpec {
  return {
    id: "test-wl",
    name: "Test workload",
    description: "A test workload.",
    level: "SMALL",
    stratum: "SYNTHETIC",
    featureSpec: { title: "Feature", description: "Does things." },
    features: [{ key: "feat", title: "Feat" }],
    baseFiles: [],
    testFiles: [{ path: "test/a.test.mjs", content: "import test from 'node:test';\ntest('x', () => {});\n" }],
    testCommand: ["node", "--test"],
    tasks: [
      {
        key: "aaa",
        title: "Task A",
        description: "Do A.",
        featureKey: "feat",
        claims: [{ resource: "src/a.js", access: "WRITE" }],
        dependsOn: [],
        probes: [{ name: "probe a", command: ["node", "-e", "process.exit(0)"] }],
      },
      {
        key: "bbb",
        title: "Task B",
        description: "Do B.",
        featureKey: "feat",
        claims: [{ resource: "src/b.js", access: "WRITE" }],
        dependsOn: [],
        probes: [{ name: "probe b", command: ["node", "-e", "process.exit(0)"] }],
      },
    ],
    decomposition: { author: "tester", reviewer: "checker" },
    expectedOutcome: "Both integrate.",
    setupCommands: [],
    setupTimeoutMs: 600_000,
  };
}

describe("context", () => {
  it("estimateTokens is deterministic and versioned", () => {
    expect(TOKEN_ESTIMATOR_VERSION).toBe(1);
    const text = "Hello, world! This is a test string.";
    const first = estimateTokens(text);
    const second = estimateTokens(text);
    expect(first).toBe(second);
    expect(first).toBeGreaterThan(0);
  });

  it("estimateTokens handles empty and short strings", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("a")).toBeGreaterThan(0);
    expect(estimateTokens("hello world")).toBeGreaterThan(estimateTokens("hi"));
  });

  it("renderSaUnionPrompt produces the exact frozen SA prompt", () => {
    const scale = testScaleWorkload();
    const saPrompt = renderSaUnionPrompt(scale);

    // Must match the frozen renderer's output exactly.
    const ordered = [...scale.tasks].sort((a, b) => (a.key < b.key ? -1 : 1));
    const expected = renderSingleAgentPrompt(
      ordered.map((t) => ({ key: t.key, title: t.title, description: t.description, claims: t.claims.map((c) => ({ ...c })) })),
      scale.featureSpec.title,
    );
    expect(saPrompt).toBe(expected);
    expect(saPrompt).toContain("Task key: aaa");
    expect(saPrompt).toContain("Task key: bbb");
    expect(saPrompt).toContain("Complete ALL of the following tasks");
  });

  it("renderAeTaskPrompt produces the exact frozen AE prompt", () => {
    const scale = testScaleWorkload();
    const task = scale.tasks[0]!;
    const aePrompt = renderAeTaskPrompt(task, scale.featureSpec.title);

    // Must match the frozen renderer's output exactly.
    const expected = renderTaskPrompt(
      { key: task.key, title: task.title, description: task.description, claims: task.claims.map((c) => ({ ...c })) },
      scale.featureSpec.title,
    );
    expect(aePrompt).toBe(expected);
    expect(aePrompt).toContain("Task key: aaa");
    expect(aePrompt).toContain("Resource claims:");
    expect(aePrompt).not.toContain("Complete ALL of the following tasks");
  });

  it("measurePromptTokensFromPromptString measures the exact renderer output", () => {
    const scale = testScaleWorkload();
    const saPrompt = renderSaUnionPrompt(scale);
    const tokens = measurePromptTokensFromPromptString(saPrompt);

    // Token count must equal estimateTokens of the exact renderer string.
    expect(tokens).toBe(estimateTokens(saPrompt));
    expect(tokens).toBeGreaterThan(0);

    // AE prompt for one task should be smaller than the SA union prompt.
    const aePrompt = renderAeTaskPrompt(scale.tasks[0]!, scale.featureSpec.title);
    const aeTokens = measurePromptTokensFromPromptString(aePrompt);
    expect(aeTokens).toBeLessThan(tokens);
  });

  it("SA prompt tokens > AE prompt tokens for multi-task workload", () => {
    const scale = testScaleWorkload();
    const saTokens = measurePromptTokensFromPromptString(renderSaUnionPrompt(scale));
    const aeTokensMax = Math.max(
      ...scale.tasks.map((t) => measurePromptTokensFromPromptString(renderAeTaskPrompt(t, scale.featureSpec.title))),
    );
    // SA union contains all task sections, so it must be strictly larger.
    expect(saTokens).toBeGreaterThan(aeTokensMax);
  });

  it("measureRepoTokens returns null for missing directory", async () => {
    const result = await measureRepoTokens("/nonexistent/path");
    expect(result).toBeNull();
  });

  it("measureRepoTokens counts text files excluding node_modules and .git", async () => {
    const dir = await makeTempDir();
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "a.js"), "export const a = 1;\n");
    await writeFile(join(dir, "src", "b.js"), "export const b = 2;\n");
    await mkdir(join(dir, "node_modules"), { recursive: true });
    await writeFile(join(dir, "node_modules", "pkg.js"), "module.exports = {};\n");
    await mkdir(join(dir, ".git"), { recursive: true });
    await writeFile(join(dir, ".git", "config"), "[core]\n");

    const result = await measureRepoTokens(dir);
    expect(result).not.toBeNull();
    expect(result!.fileCount).toBe(2);
    expect(result!.totalTokens).toBeGreaterThan(0);
  });

  it("measureTaskRelevantTokens counts claimed paths", async () => {
    const dir = await makeTempDir();
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "target.js"), "export const x = 1;\n");
    await writeFile(join(dir, "src", "other.js"), "export const y = 2;\n");

    const workload = {
      tasks: [{ claims: [{ resource: "src/target.js", access: "WRITE" }] }],
      testFiles: [],
      baseFiles: [],
    } as unknown as ScaleWorkloadSpec;

    const tokens = await measureTaskRelevantTokens({ workload, fixtureDir: dir });
    expect(tokens).toBeGreaterThan(0);
  });

  it("assembleContextRecord computes utilization correctly", () => {
    const record = assembleContextRecord({
      modelCapacityTokens: 200_000,
      repoTokens: 10_000,
      taskRelevantTokens: 5_000,
      promptTokenCounts: [40_000, 20_000],
    });
    expect(record.estimatorVersion).toBe(1);
    expect(record.modelCapacityTokens).toBe(200_000);
    expect(record.repoTokens).toBe(10_000);
    expect(record.taskRelevantTokens).toBe(5_000);
    expect(record.promptTokensMax).toBe(40_000);
    expect(record.promptTokensMean).toBe(30_000);
    expect(record.utilizationMax).toBeCloseTo(0.2);
  });

  it("assembleContextRecord handles empty prompt counts", () => {
    const record = assembleContextRecord({
      modelCapacityTokens: 200_000,
      repoTokens: 0,
      taskRelevantTokens: 0,
      promptTokenCounts: [],
    });
    expect(record.promptTokensMax).toBe(0);
    expect(record.promptTokensMean).toBe(0);
    expect(record.utilizationMax).toBe(0);
  });
});
