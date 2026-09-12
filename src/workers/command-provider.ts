import { execFile } from "node:child_process";
import { z } from "zod";
import type { WorkerExecutionInput } from "./types.js";
import type { WorkerProvider } from "./provider.js";

/**
 * Configuration for {@link CommandWorkerProvider}. Strict: unknown keys
 * (notably any caller-supplied workspace path) are rejected. The workspace
 * always comes from Atlas state (`WorkerExecutionInput.workspacePath`),
 * never from this config.
 */
export const CommandWorkerConfigSchema = z
  .object({
    /** Explicit argv, executable first. Never a shell string. */
    command: z.array(z.string().min(1, "command argument must not be empty")).min(1).max(50),
    /** Kill and fail the execution after this long. Mirrors M9 test bounds. */
    timeoutMs: z.number().int().min(1000).max(3600000).default(120000),
    /**
     * Host environment variables forwarded into the child, by exact name.
     * Default is empty: the child receives only a minimal `PATH` plus the
     * listed names. Secrets must never be added here — the provider input
     * carries no secrets by construction (M8 boundary).
     */
    envAllowlist: z.array(z.string().min(1)).max(100).default([]),
  })
  .strict();

export type CommandWorkerConfig = z.infer<typeof CommandWorkerConfigSchema>;

const EXEC_MAX_BUFFER = 8 * 1024 * 1024;
const STDOUT_NOTES_CAP = 2000;
const STDERR_NOTES_CAP = 2000;

function truncate(text: string, cap: number): string {
  return text.length <= cap ? text : text.slice(0, cap);
}

function childEnv(allowlist: readonly string[]): Record<string, string> {
  // Minimal base: PATH only, so bare executable names (e.g. `node`) still
  // resolve. Everything else must be explicitly allowlisted — arbitrary host
  // environment (credentials, tokens, session state) is never forwarded.
  const env: Record<string, string> = { PATH: process.env["PATH"] ?? "/usr/bin:/bin" };
  for (const name of allowlist) {
    const value = process.env[name];
    if (value !== undefined) {
      env[name] = value;
    }
  }
  return env;
}

interface ObservedCommand {
  readonly stdout: string;
  readonly stderr: string;
}

function runCommand(executable: string, args: string[], cwd: string, timeoutMs: number, env: Record<string, string>): Promise<ObservedCommand> {
  return new Promise((resolve, reject) => {
    execFile(executable, args, { cwd, timeout: timeoutMs, maxBuffer: EXEC_MAX_BUFFER, env }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(error);
        return;
      }
      resolve({ stdout: typeof stdout === "string" ? stdout : "", stderr: typeof stderr === "string" ? stderr : "" });
    });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Real subprocess-based WorkerProvider (M11).
 *
 * Runs an explicitly configured command with `execFile` (argv array, no
 * shell) whose working directory is always the Atlas-assigned workspace.
 * The child may be a deterministic test script, a coding-agent CLI, or any
 * other executable — Atlas cannot tell and does not need to: whatever the
 * child does is observed afterwards from Git itself (M8 diff + claim
 * enforcement), never from the child's own output.
 *
 * Child stdout/stderr are captured into `notes` (bounded, informational
 * only) and never treated as authority for what changed. A non-zero exit,
 * timeout, or spawn failure throws, which the M8 runtime maps to a
 * structured `FAILED` result — the same semantics as a throwing provider.
 *
 * This is process/worktree isolation, NOT a security sandbox: a hostile
 * child process can still touch the wider filesystem. OS/container
 * sandboxing (Docker, microVMs) remains future work and must not be
 * claimed here.
 */
export class CommandWorkerProvider implements WorkerProvider {
  readonly config: CommandWorkerConfig;

  constructor(raw: unknown) {
    this.config = CommandWorkerConfigSchema.parse(raw);
  }

  async execute(input: WorkerExecutionInput): Promise<unknown> {
    const executable = this.config.command[0];
    if (executable === undefined) {
      throw new Error("command-worker: command must not be empty");
    }
    const args = this.config.command.slice(1);
    let observed: ObservedCommand;
    try {
      observed = await runCommand(executable, args, input.workspacePath, this.config.timeoutMs, childEnv(this.config.envAllowlist));
    } catch (error) {
      throw new Error(`command-worker: command failed: ${errorMessage(error)}`);
    }
    const stdout = truncate(observed.stdout, STDOUT_NOTES_CAP);
    const stderr = truncate(observed.stderr, STDERR_NOTES_CAP);
    const notes = [`stdout:\n${stdout}`, `stderr:\n${stderr}`].join("\n");
    // Single-line Atlas-built summary: child-controlled bytes (argument
    // values, let alone stdout) must never shape control-plane records.
    const argv = this.config.command.join(" ").replace(/\s+/g, " ");
    return {
      summary: `command-worker: ${argv} exit 0`,
      notes,
    };
  }
}
