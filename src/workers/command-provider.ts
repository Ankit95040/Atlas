import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import type { WorkerExecutionInput } from "./types.js";
import type { WorkerProvider } from "./provider.js";
import { extractProviderUsage } from "./usage.js";

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

import type { CommandFailureKind } from "./types.js";

/**
 * Structured command failure (M19.2): the spawn boundary classifies what IT
 * observed (kill, exit, spawn) instead of leaving later stages to infer it
 * from stderr text. The message text is unchanged from the previous plain
 * errors; the kind travels alongside it for machine classification.
 */
export class CommandFailureError extends Error {
  readonly kind: CommandFailureKind;
  readonly executable: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;

  constructor(
    kind: CommandFailureKind,
    details: { executable: string; message: string; exitCode?: number | null; signal?: NodeJS.Signals | null; timedOut?: boolean },
  ) {
    super(details.message);
    this.name = "CommandFailureError";
    this.kind = kind;
    this.executable = details.executable;
    this.exitCode = details.exitCode ?? null;
    this.signal = details.signal ?? null;
    this.timedOut = details.timedOut ?? false;
  }
}

const EXEC_MAX_BUFFER = 8 * 1024 * 1024;
const STDOUT_NOTES_CAP = 2000;
const STDERR_NOTES_CAP = 2000;
// Grace period between SIGTERM and SIGKILL escalation. Fixed so timeout
// behavior stays deterministic: every timeout resolves within
// timeoutMs + SIGKILL_GRACE_MS.
const SIGKILL_GRACE_MS = 5000;
const STDERR_HEAD_CAP = 2000;

function truncate(text: string, cap: number): string {
  return text.length <= cap ? text : text.slice(0, cap);
}

/**
 * Provider rate-limit signature (M20.3): the distinctive phrase the provider
 * CLI prints when the API refuses the call. Matched against observed stderr
 * only — never stdout (agent task output lives there) and never bare numbers
 * or generic words. Observed corpus: "AI_APICallError: Rate limit exceeded.
 * Please try again later." / "... Please retry after a brief wait."
 */
const RATE_LIMIT_PATTERN = /rate limit exceeded/i;

function detectRateLimit(stderr: string): boolean {
  return RATE_LIMIT_PATTERN.test(stderr);
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

/**
 * M18 Amendment (opencode per-worker state isolation): give each worker child
 * a private XDG data home so concurrent OpenCode CLI processes never share
 * the provider's session database (`~/.local/share/opencode/opencode.db`,
 * the observed source of SQLITE "database is locked" failures under parallel
 * waves). Verified: opencode resolves its data root from XDG_DATA_HOME,
 * falling back to `$HOME/.local/share`.
 *
 * Narrow by construction:
 * - Executable, argv, prompts, HOME, and worker behavior are untouched; only
 *   XDG_DATA_HOME is added to the child environment.
 * - The directory is a hidden sibling of the Atlas-assigned workspace: outside
 *   every git worktree (invisible to claim enforcement and pristine asserts)
 *   and inside the run's scratch tree, so existing per-run cleanup removes it.
 *   Uniqueness follows workspace uniqueness (one workspace per worker task).
 * - Only activates when the host actually carries opencode auth state; the
 *   auth files are copied read-only (mode 0600, as stored) so the isolated
 *   CLI authenticates exactly as the shared one did. Otherwise the child
 *   environment is identical to before.
 * - Best-effort: any failure falls back to the previous environment rather
 *   than failing an otherwise healthy execution.
 */
async function withIsolatedOpencodeDataHome(
  env: Record<string, string>,
  workspacePath: string,
): Promise<Record<string, string>> {
  try {
    const home = process.env["HOME"];
    if (home === undefined || home === "") {
      return env;
    }
    const sourceDir = join(home, ".local", "share", "opencode");
    const [auth, mcpAuth] = await Promise.all([
      readFile(join(sourceDir, "auth.json")).catch(() => null),
      readFile(join(sourceDir, "mcp-auth.json")).catch(() => null),
    ]);
    if (auth === null && mcpAuth === null) {
      return env;
    }
    const root = resolve(workspacePath);
    const scopeDir = join(dirname(root), `.${basename(root)}.opencode-data`);
    const opencodeDir = join(scopeDir, "opencode");
    await mkdir(opencodeDir, { recursive: true });
    if (auth !== null) {
      await writeFile(join(opencodeDir, "auth.json"), auth, { mode: 0o600 });
    }
    if (mcpAuth !== null) {
      await writeFile(join(opencodeDir, "mcp-auth.json"), mcpAuth, { mode: 0o600 });
    }
    return { ...env, XDG_DATA_HOME: scopeDir };
  } catch {
    return env;
  }
}

interface ObservedCommand {
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Kill the child and everything it spawned. The child runs as a process-group
 * leader (detached), so a negative-pid signal reaches orphaned grandchildren
 * too — a rate-limited agent stuck in a retry loop cannot leave strays
 * behind to hold worktrees or locks. Falls back to a direct kill where
 * process groups are unavailable.
 */
function killTree(child: { pid?: number | undefined; kill: (signal: NodeJS.Signals) => boolean }, signal: NodeJS.Signals): void {
  try {
    if (child.pid !== undefined && process.platform !== "win32") {
      process.kill(-child.pid, signal);
      return;
    }
  } catch {
    // Fall through: the group may already be gone.
  }
  try {
    child.kill(signal);
  } catch {
    // Best effort: the process may already be gone.
  }
}

function runCommand(executable: string, args: string[], cwd: string, timeoutMs: number, env: Record<string, string>): Promise<ObservedCommand> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      // stdin is /dev/null here (not an open unwritten pipe): a child that
      // reads stdin observes EOF immediately instead of waiting for it.
      // stdout/stderr stay piped for bounded capture below.
      stdio: ["ignore", "pipe", "pipe"],
      // New process group so timeout escalation reaches the whole tree.
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    // Set when THIS boundary initiates the timeout kill sequence, so a later
    // signal death is classified as our timeout rather than inferred noise.
    let timeoutInitiated = false;

    const cleanupTimers = (): void => {
      if (killTimer !== undefined) {
        clearTimeout(killTimer);
        killTimer = undefined;
      }
      if (graceTimer !== undefined) {
        clearTimeout(graceTimer);
        graceTimer = undefined;
      }
    };
    const fail = (
      kind: CommandFailureKind,
      message: string,
      details?: { exitCode?: number | null; signal?: NodeJS.Signals | null; timedOut?: boolean },
    ): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanupTimers();
      killTree(child, "SIGKILL");
      reject(new CommandFailureError(kind, { executable, message, ...details }));
    };

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
      if (stdout.length + stderr.length > EXEC_MAX_BUFFER) {
        fail("OUTPUT_OVERFLOW", `command output exceeded ${EXEC_MAX_BUFFER} bytes`);
      }
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
      if (stdout.length + stderr.length > EXEC_MAX_BUFFER) {
        fail("OUTPUT_OVERFLOW", `command output exceeded ${EXEC_MAX_BUFFER} bytes`);
      }
    });
    child.on("error", (error) => {
      fail("SPAWN_FAILED", `command failed to start: ${errorMessage(error)}`);
    });
    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanupTimers();
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const tail = stderr.slice(-STDERR_HEAD_CAP);
      // M20.3: a detected provider rate limit names the cause; the timeout
      // flag still records the kill mechanism when we initiated it.
      const rateLimited = detectRateLimit(stderr);
      if (signal !== null && signal !== undefined) {
        reject(
          new CommandFailureError(rateLimited ? "RATE_LIMIT" : timeoutInitiated ? "TIMEOUT" : "EXIT_NONZERO", {
            executable,
            message: `command terminated by ${signal}${tail.length > 0 ? `: ${tail}` : ""}`,
            signal,
            timedOut: timeoutInitiated,
          }),
        );
        return;
      }
      reject(
        new CommandFailureError(rateLimited ? "RATE_LIMIT" : "EXIT_NONZERO", {
          executable,
          message: `command exited with code ${code ?? "unknown"}${tail.length > 0 ? `: ${tail}` : ""}`,
          exitCode: code,
        }),
      );
    });

    // Timeout with escalation: SIGTERM first so well-behaved agents flush
    // and exit, then SIGKILL so a SIGTERM-ignoring process (e.g. stuck in a
    // provider retry loop after a rate-limit error) cannot hang the worker
    // indefinitely. execFile's single-SIGTERM timeout is insufficient here.
    killTimer = setTimeout(() => {
      timeoutInitiated = true;
      killTree(child, "SIGTERM");
      graceTimer = setTimeout(() => {
        // Include stderr so provider-side diagnostics (e.g. a rate-limit
        // error printed before stalling) survive into the recorded failure.
        const tail = stderr.slice(-STDERR_HEAD_CAP);
        fail(
          detectRateLimit(stderr) ? "RATE_LIMIT" : "TIMEOUT",
          `command timed out after ${timeoutMs}ms${tail.length > 0 ? `: ${tail}` : ""}`,
          { timedOut: true },
        );
      }, SIGKILL_GRACE_MS);
    }, timeoutMs);
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
      const env = await withIsolatedOpencodeDataHome(childEnv(this.config.envAllowlist), input.workspacePath);
      observed = await runCommand(executable, args, input.workspacePath, this.config.timeoutMs, env);
    } catch (error) {
      if (error instanceof CommandFailureError) {
        throw new CommandFailureError(error.kind, {
          executable,
          message: `command-worker: command failed: ${error.message}`,
          exitCode: error.exitCode,
          signal: error.signal,
          timedOut: error.timedOut,
        });
      }
      throw new Error(`command-worker: command failed: ${errorMessage(error)}`);
    }
    const stdout = truncate(observed.stdout, STDOUT_NOTES_CAP);
    const stderr = truncate(observed.stderr, STDERR_NOTES_CAP);
    const notes = [`stdout:\n${stdout}`, `stderr:\n${stderr}`].join("\n");
    // Single-line Atlas-built summary: child-controlled bytes (argument
    // values, let alone stdout) must never shape control-plane records.
    // Usage is parsed from the same observed bytes by Atlas itself (M28.9):
    // informational telemetry, validated by schema, never evidence.
    const argv = this.config.command.join(" ").replace(/\s+/g, " ");
    const usage = extractProviderUsage(observed.stdout);
    return {
      summary: `command-worker: ${argv} exit 0`,
      notes,
      ...(usage === null ? {} : { usage }),
    };
  }
}
