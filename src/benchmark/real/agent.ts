import { CommandWorkerProvider } from "../../workers/index.js";
import { BenchmarkError } from "../errors.js";
import type { RealAgentConfig } from "./types.js";

/** Assemble the exact argv a worker executes: base argv plus the rendered prompt. */
export function buildAgentCommand(prompt: string, config: RealAgentConfig): string[] {
  // Schema bounds (argv <= 40 plus executable, optional flag, and the single
  // prompt element) always fit the provider's 50-element argv bound.
  return [config.executable, ...config.argv, ...(config.promptFlag !== undefined ? [config.promptFlag] : []), prompt];
}

/**
 * Provider factory input shared by all three strategy arms: the same prompt
 * bytes reach the same executable under the same M11 boundary, so only
 * orchestration differs between arms.
 */
export function buildAgentProvider(prompt: string, config: RealAgentConfig): CommandWorkerProvider {
  return new CommandWorkerProvider({
    command: buildAgentCommand(prompt, config),
    timeoutMs: config.timeoutMs,
    envAllowlist: [...config.envAllowlist],
  });
}
