import { mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { runGit } from "../git/index.js";
import type { WorkerExecutionInput } from "./types.js";

/**
 * Worker provider abstraction: the seam between Atlas control and coding
 * work. The return type is deliberately `unknown` — provider output is
 * untrusted and always schema-validated by the runtime. A provider receives
 * the minimum execution context and can never return authority (no task
 * reassignment, approval, or merge power exists in this channel).
 */
export interface WorkerProvider {
  execute(input: WorkerExecutionInput): Promise<unknown>;
}

export interface FakeWorkerBehavior {
  /**
   * Controlled file operations, keyed by workspace-relative POSIX path.
   * String content writes (creating parents as needed); `null` deletes;
   * `{ renameTo }` moves within the workspace. Anything resolving outside
   * the workspace is refused.
   */
  readonly files?: Readonly<Record<string, string | null | { readonly renameTo: string }>>;
  /** When set, execute() throws Error(failWith) instead of doing work. */
  readonly failWith?: string;
  /** When set, stage everything and commit with inline test identity. */
  readonly commitMessage?: string;
  readonly summary?: string;
  /** Artificial delay in ms (lets tests force execution-slot interleavings). */
  readonly delayMs?: number;
}

function assertInsideWorkspace(root: string, candidate: string): string {
  const absolute = resolve(root, candidate);
  const rel = relative(root, absolute);
  const first = rel.split("/")[0] ?? "";
  if (rel === "" || first === "..") {
    throw new Error(`fake provider: path escapes workspace: ${candidate}`);
  }
  return absolute;
}

/**
 * Deterministic stand-in used by tests: performs only the configured file
 * operations inside the Atlas-assigned workspace directory, optionally
 * commits, and returns a fixed-shape summary. No network, no shell, no
 * credentials — file writes via node:fs and commits via the Git engine.
 */
export class FakeWorkerProvider implements WorkerProvider {
  constructor(private readonly behavior: FakeWorkerBehavior = {}) {}

  async execute(input: WorkerExecutionInput): Promise<unknown> {
    if (this.behavior.failWith !== undefined) {
      throw new Error(this.behavior.failWith);
    }
    const root = await realpath(input.workspacePath);
    const touched: string[] = [];
    for (const [rel, content] of Object.entries(this.behavior.files ?? {})) {
      if (content === null) {
        await rm(assertInsideWorkspace(root, rel), { force: true, recursive: true });
      } else if (typeof content === "object") {
        const from = assertInsideWorkspace(root, rel);
        const to = assertInsideWorkspace(root, content.renameTo);
        await mkdir(dirname(to), { recursive: true });
        await rename(from, to);
      } else {
        const absolute = assertInsideWorkspace(root, rel);
        await mkdir(dirname(absolute), { recursive: true });
        await writeFile(absolute, content);
      }
      touched.push(rel);
    }
    if (this.behavior.commitMessage !== undefined) {
      await runGit(["add", "-A"], { cwd: root });
      await runGit(
        [
          "-c",
          "user.email=fake-worker@atlas.test",
          "-c",
          "user.name=Atlas Fake Worker",
          "-c",
          "commit.gpgsign=false",
          "commit",
          "-m",
          this.behavior.commitMessage,
        ],
        { cwd: root },
      );
    }
    if (this.behavior.delayMs !== undefined && this.behavior.delayMs > 0) {
      await new Promise((resolveSleep) => setTimeout(resolveSleep, this.behavior.delayMs));
    }
    return { summary: this.behavior.summary ?? "fake work done", filesChanged: [...touched].sort() };
  }
}
