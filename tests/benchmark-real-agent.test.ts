import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { CommandWorkerProvider } from "../src/workers/index.js";
import { RealAgentConfigSchema, buildAgentCommand, buildAgentProvider } from "../src/benchmark/real/index.js";

const CONFIG = {
  provider: "fixture-cli",
  executable: "/usr/local/bin/agent",
  argv: ["--mode", "work"],
  timeoutMs: 60000,
  envAllowlist: [],
  model: "fixture-1.0",
  version: null,
  temperature: 0,
};

describe("real agent configuration", () => {
  it("validates config with strictness and sane defaults", () => {
    const parsed = RealAgentConfigSchema.parse({ provider: "x", executable: "agent" });
    expect(parsed.timeoutMs).toBe(120000);
    expect(parsed.argv).toEqual([]);
    expect(parsed.envAllowlist).toEqual([]);
    expect(parsed.model).toBeNull();
    expect(() => RealAgentConfigSchema.parse({ provider: "x", executable: "" })).toThrow(ZodError);
    expect(() => RealAgentConfigSchema.parse({ provider: "x", executable: "a", workspace: "/tmp" })).toThrow(ZodError);
  });

  it("assembles argv with the prompt last and no shell", () => {
    expect(buildAgentCommand("do work", RealAgentConfigSchema.parse(CONFIG))).toEqual([
      "/usr/local/bin/agent",
      "--mode",
      "work",
      "do work",
    ]);
    expect(
      buildAgentCommand("do work", RealAgentConfigSchema.parse({ ...CONFIG, promptFlag: "--prompt" })),
    ).toEqual(["/usr/local/bin/agent", "--mode", "work", "--prompt", "do work"]);
  });

  it("keeps assembled argv within the provider bound by construction", () => {
    const longest = RealAgentConfigSchema.parse({ ...CONFIG, argv: Array.from({ length: 40 }, (_, i) => `a${i}`) });
    // 1 executable + 40 base args + 1 prompt element: always under the provider's 50-element bound.
    expect(buildAgentCommand("prompt", longest)).toHaveLength(42);
  });

  it("builds a CommandWorkerProvider implementing the worker boundary", async () => {
    const provider = buildAgentProvider("do work", RealAgentConfigSchema.parse(CONFIG));
    expect(provider).toBeInstanceOf(CommandWorkerProvider);
    expect(typeof provider.execute).toBe("function");
  });

  it("records unknown provenance as null rather than inventing it", () => {
    const parsed = RealAgentConfigSchema.parse({ provider: "mystery", executable: "agent" });
    expect(parsed.model).toBeNull();
    expect(parsed.version).toBeNull();
    expect(parsed.temperature).toBeNull();
  });
});
