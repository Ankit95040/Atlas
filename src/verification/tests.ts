import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { PrismaClient } from "@prisma/client";
import { getPrismaClient } from "../db/client.js";
import { recordTestRun, transitionTestRun } from "../core/service.js";
import { NoTestCommandError, TestExecutionError } from "./errors.js";
import { RunTestsInputSchema, type TestExecutionResult, type TestExecutionStatus } from "./types.js";

const DEFAULT_TIMEOUT_MS = 120000;
const EXEC_MAX_BUFFER = 8 * 1024 * 1024;
const DB_OUTPUT_CAP = 200000;

export interface RunTestsOptions {
  readonly signal?: AbortSignal;
}

interface ObservedProcess {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly aborted: boolean;
}

/**
 * Resolve the repository's configured test command from package.json
 * `scripts.test`. The script is split on whitespace (documented V0.1
 * limitation: no shell quoting support); repositories needing complex
 * invocations must pass an explicit argv command instead. Throws
 * NoTestCommandError when the repo defines none. Never invents a command.
 */
export async function resolveTestCommandFromPackageJson(repoRoot: string): Promise<string[]> {
  let raw: string;
  try {
    raw = await readFile(join(repoRoot, "package.json"), "utf8");
  } catch {
    throw new NoTestCommandError(`no package.json in ${repoRoot}: pass an explicit test command`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new NoTestCommandError(`package.json in ${repoRoot} is not valid JSON`);
  }
  const script =
    typeof parsed === "object" && parsed !== null
      ? (parsed as { scripts?: { test?: unknown } }).scripts?.test
      : undefined;
  if (typeof script !== "string" || script.trim().length === 0) {
    throw new NoTestCommandError(`package.json in ${repoRoot} defines no scripts.test: pass an explicit test command`);
  }
  const argv = script.split(/\s+/).filter((part) => part.length > 0);
  if (argv.length === 0) {
    throw new NoTestCommandError(`package.json scripts.test in ${repoRoot} is empty`);
  }
  return argv;
}

function toText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function truncateForDb(value: string): { text: string; truncated: boolean } {
  if (value.length <= DB_OUTPUT_CAP) {
    return { text: value, truncated: false };
  }
  return { text: value.slice(0, DB_OUTPUT_CAP), truncated: true };
}

function observe(command: string[], cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<ObservedProcess> {
  const executable = command[0];
  if (executable === undefined) {
    return Promise.reject(new TestExecutionError("test command must not be empty"));
  }
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      command.slice(1),
      { cwd, timeout: timeoutMs, maxBuffer: EXEC_MAX_BUFFER, ...(signal !== undefined ? { signal } : {}) },
      (error, stdout, stderr) => {
        const out = toText(stdout as unknown);
        const err = toText(stderr as unknown);
        if (error === null) {
          resolve({ exitCode: 0, stdout: out, stderr: err, timedOut: false, aborted: false });
          return;
        }
        const failure = error as NodeJS.ErrnoException & {
          code?: unknown;
          killed?: boolean;
          signal?: unknown;
        };
        if (failure.code === "ABORT_ERR") {
          resolve({ exitCode: null, stdout: out, stderr: err, timedOut: false, aborted: true });
          return;
        }
        if (failure.code === "ENOENT") {
          reject(new TestExecutionError(`test executable not found: ${executable}`));
          return;
        }
        if (typeof failure.code === "number") {
          resolve({ exitCode: failure.code, stdout: out, stderr: err, timedOut: false, aborted: false });
          return;
        }
        if (failure.killed === true) {
          resolve({ exitCode: null, stdout: out, stderr: err, timedOut: true, aborted: false });
          return;
        }
        if (typeof failure.code === "string" && failure.code === "ENOBUFS") {
          resolve({ exitCode: null, stdout: out, stderr: err, timedOut: false, aborted: false });
          return;
        }
        reject(new TestExecutionError(`could not observe test process: ${error.message}`));
      },
    );
  });
}

/**
 * Execute a repository's test command in a directory and persist a TestRun.
 * The process exit code is the sole source of truth: exit 0 → PASSED,
 * non-zero exit or timeout → FAILED, abort → CANCELLED. Provider
 * self-reports are never consulted. Stdout/stderr are captured (bounded in
 * the DB row, full in the returned result).
 */
export async function runTests(
  raw: unknown,
  db: PrismaClient = getPrismaClient(),
  options: RunTestsOptions = {},
): Promise<TestExecutionResult> {
  const input = RunTestsInputSchema.parse(raw);
  const cwdStat = await stat(input.workdir).catch(() => null);
  if (cwdStat === null || !cwdStat.isDirectory()) {
    throw new TestExecutionError(`test workdir does not exist: ${input.workdir}`);
  }
  const command = input.command ?? (await resolveTestCommandFromPackageJson(input.workdir));
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const testRun = await recordTestRun(
    {
      taskId: input.taskId,
      ...(input.name !== undefined ? { name: input.name } : {}),
      metadata: { command, timeoutMs },
    },
    db,
  );
  await transitionTestRun(testRun.id, "RUNNING", db);

  const startedAt = Date.now();
  let observed: ObservedProcess;
  try {
    observed = await observe(command, input.workdir, timeoutMs, options.signal);
  } catch (error) {
    // Spawn-level failure (e.g. missing binary): the run never started, so no
    // terminal status applies. Preserve the evidence on the row instead of
    // silently completing it or deleting it.
    if (error instanceof TestExecutionError) {
      await db.testRun.update({
        where: { id: testRun.id },
        data: { metadata: JSON.stringify({ command, timeoutMs, infraError: error.message }) },
      });
    }
    throw error;
  }
  const durationMs = Date.now() - startedAt;

  const status: TestExecutionStatus = observed.aborted ? "CANCELLED" : observed.exitCode === 0 ? "PASSED" : "FAILED";
  const stdoutDb = truncateForDb(observed.stdout);
  const stderrDb = truncateForDb(observed.stderr);
  await db.testRun.update({
    where: { id: testRun.id },
    data: {
      exitCode: observed.exitCode,
      metadata: JSON.stringify({
        command,
        timeoutMs,
        exitCode: observed.exitCode,
        durationMs,
        timedOut: observed.timedOut,
        stdoutTruncated: stdoutDb.truncated,
        stdout: stdoutDb.text,
        stderrTruncated: stderrDb.truncated,
        stderr: stderrDb.text,
      }),
    },
  });
  await transitionTestRun(testRun.id, status, db);

  return {
    testRunId: testRun.id,
    status,
    command,
    exitCode: observed.exitCode,
    durationMs,
    stdout: observed.stdout,
    stderr: observed.stderr,
    timedOut: observed.timedOut,
  };
}
