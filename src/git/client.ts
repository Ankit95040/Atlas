import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";
import { GitCommandError, GitNotInstalledError } from "./errors.js";
import type { GitCommandResult, RunGitOptions } from "./types.js";

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 30_000;

interface ExecFileFailure {
  readonly code?: unknown;
  readonly stdout?: unknown;
  readonly stderr?: unknown;
}

/**
 * Execute Git without a shell: argument arrays only, explicit cwd, captured
 * stdout/stderr/exit code. Non-zero exits become GitCommandError; a missing
 * git binary becomes GitNotInstalledError.
 */
export async function runGit(args: readonly string[], options: RunGitOptions): Promise<GitCommandResult> {
  const cwdStat = await stat(options.cwd).catch(() => null);
  if (cwdStat === null || !cwdStat.isDirectory()) {
    throw new GitCommandError([...args], options.cwd, null, "", `working directory does not exist: ${options.cwd}`);
  }

  try {
    const { stdout, stderr } = await execFileAsync("git", [...args], {
      cwd: options.cwd,
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    throw toGitError([...args], options.cwd, error);
  }
}

/** True when the git binary can be spawned (used by diagnostics, not by engine ops). */
export async function isGitAvailable(): Promise<boolean> {
  try {
    await runGit(["--version"], { cwd: process.cwd() });
    return true;
  } catch (error) {
    if (error instanceof GitNotInstalledError) {
      return false;
    }
    // Git exists but the probe failed (e.g. odd cwd) — still "installed".
    return true;
  }
}

function toGitError(args: string[], cwd: string, error: unknown): Error {
  const failure = (error ?? {}) as ExecFileFailure;
  // cwd was verified above, so ENOENT here means the git binary is missing.
  if (failure.code === "ENOENT") {
    return new GitNotInstalledError();
  }
  return new GitCommandError(
    args,
    cwd,
    typeof failure.code === "number" ? failure.code : null,
    typeof failure.stdout === "string" ? failure.stdout : "",
    typeof failure.stderr === "string" ? failure.stderr : "",
  );
}
