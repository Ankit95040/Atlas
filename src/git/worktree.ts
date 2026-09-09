import { readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { runGit } from "./client.js";
import {
  GitCommandError,
  InvalidWorktreePathError,
  UnsafeWorktreeOperationError,
  WorktreeAlreadyExistsError,
  WorktreeNotFoundError,
} from "./errors.js";
import { assertSafeIdSegment, assertValidBranchName, validateRepository } from "./repository.js";
import type { CreateWorktreeInput, WorktreeInfo, WorktreeOperationOptions } from "./types.js";

// ---------- Branch naming ----------

/**
 * Canonical Atlas worker branch format: atlas/worker/<worker-id>/task/<task-id>.
 *
 * Worker-scoped (not task-scoped) so that a retried task executed by a
 * different worker never collides with an existing branch. Ids are restricted
 * to cuid-style segments, which rules out path traversal at the source.
 */
export function buildWorkerBranchName(workerId: string, taskId: string): string {
  assertSafeIdSegment("workerId", workerId);
  assertSafeIdSegment("taskId", taskId);
  const branch = `atlas/worker/${workerId}/task/${taskId}`;
  assertValidBranchName(branch);
  return branch;
}

// ---------- Porcelain parsing (pure, unit-testable) ----------

/**
 * Parse `git worktree list --porcelain`. The first record is the main
 * worktree. Throws GitCommandError on unparseable output (Git version skew).
 */
export function parseWorktreeListPorcelain(output: string): WorktreeInfo[] {
  const worktrees: WorktreeInfo[] = [];
  for (const block of output.split("\n\n")) {
    if (block.trim().length === 0) {
      continue;
    }
    let path: string | null = null;
    let commit: string | null = null;
    let branch: string | null = null;
    let locked = false;
    let prunable = false;
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) {
        path = line.slice("worktree ".length);
      } else if (line.startsWith("HEAD ")) {
        commit = line.slice("HEAD ".length).trim();
      } else if (line.startsWith("branch ")) {
        const ref = line.slice("branch ".length).trim();
        branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
      } else if (line === "detached" || line === "bare") {
        branch = null;
      } else if (line === "locked" || line.startsWith("locked ")) {
        locked = true;
      } else if (line === "prunable" || line.startsWith("prunable ")) {
        prunable = true;
      }
    }
    if (path === null || commit === null) {
      throw new GitCommandError(["worktree", "list", "--porcelain"], "", 0, output, "unparseable worktree entry");
    }
    worktrees.push({ path, branch, commit, isMain: worktrees.length === 0, locked, prunable });
  }
  return worktrees;
}

// ---------- Path helpers ----------

async function resolveReal(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

function isInsidePath(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function findRegistered(root: string, query: string, list: readonly WorktreeInfo[]): Promise<WorktreeInfo> {
  const realQuery = await resolveReal(resolve(query));
  for (const entry of list) {
    if ((await resolveReal(entry.path)) === realQuery) {
      return entry;
    }
  }
  throw new WorktreeNotFoundError(query);
}

async function assertDestinationVacant(dest: string): Promise<void> {
  const existing = await stat(dest).catch(() => null);
  if (existing === null) {
    return;
  }
  if (!existing.isDirectory()) {
    throw new InvalidWorktreePathError(`destination exists and is not a directory: ${dest}`);
  }
  if ((await readdir(dest)).length > 0) {
    throw new InvalidWorktreePathError(`destination directory is not empty: ${dest}`);
  }
}

// ---------- Worktree lifecycle (Git CLI is the source of truth) ----------

export async function getWorktrees(repoPath: string): Promise<WorktreeInfo[]> {
  const root = await validateRepository(repoPath);
  const result = await runGit(["worktree", "list", "--porcelain"], { cwd: root });
  try {
    return parseWorktreeListPorcelain(result.stdout);
  } catch (error) {
    if (error instanceof GitCommandError) {
      throw error;
    }
    throw new GitCommandError(
      ["worktree", "list", "--porcelain"],
      root,
      0,
      result.stdout,
      `failed to parse worktree list: ${(error as Error).message}`,
    );
  }
}

export async function getWorktree(repoPath: string, worktreePath: string): Promise<WorktreeInfo> {
  const root = await validateRepository(repoPath);
  return findRegistered(root, worktreePath, await getWorktrees(root));
}

export async function worktreeExists(repoPath: string, worktreePath: string): Promise<boolean> {
  try {
    await getWorktree(repoPath, worktreePath);
    return true;
  } catch (error) {
    if (error instanceof WorktreeNotFoundError) {
      return false;
    }
    throw error;
  }
}

/**
 * Create an isolated worktree on a new branch. Never touches the main working
 * tree: the destination must be outside the repository root, vacant, and not
 * already registered. Uses `git worktree add` (no repository copying).
 */
export async function createWorktree(
  input: CreateWorktreeInput,
  options: WorktreeOperationOptions = {},
): Promise<WorktreeInfo> {
  if (input.path.trim().length === 0) {
    throw new InvalidWorktreePathError("worktree path must not be empty");
  }
  assertValidBranchName(input.branch);
  const base = input.base ?? "HEAD";

  const root = await validateRepository(input.repoPath);
  const realRoot = await resolveReal(root);
  const dest = resolve(input.path);
  const realDest = await resolveReal(dest);

  const existing = await getWorktrees(root);
  const main = existing.find((entry) => entry.isMain);
  const mainReal = main !== undefined ? await resolveReal(main.path) : realRoot;
  if (realDest === realRoot || realDest === mainReal) {
    throw new UnsafeWorktreeOperationError(`refusing to treat the main working tree as a worktree: ${dest}`);
  }
  if (isInsidePath(realDest, realRoot)) {
    throw new InvalidWorktreePathError(`worktree must not live inside the repository root: ${dest}`);
  }
  try {
    await findRegistered(root, dest, existing);
    throw new WorktreeAlreadyExistsError(dest);
  } catch (error) {
    if (!(error instanceof WorktreeNotFoundError)) {
      throw error;
    }
  }
  await assertDestinationVacant(dest);

  try {
    await runGit(["worktree", "add", "-b", input.branch, dest, base], {
      cwd: root,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
  } catch (error) {
    if (error instanceof GitCommandError && /already (used|registered)|already exists/i.test(error.stderr)) {
      throw new WorktreeAlreadyExistsError(dest);
    }
    throw error;
  }
  // Re-read from Git: Git determines what the worktree points to, not Atlas.
  return getWorktree(root, dest);
}

/**
 * Remove a registered worktree. Refuses the main worktree and unknown paths;
 * a dirty worktree fails unless `force` is set (Git enforces this, Atlas
 * only forwards the flag explicitly).
 */
export async function removeWorktree(
  repoPath: string,
  worktreePath: string,
  options: WorktreeOperationOptions = {},
): Promise<void> {
  if (worktreePath.trim().length === 0) {
    throw new InvalidWorktreePathError("worktree path must not be empty");
  }
  const root = await validateRepository(repoPath);
  const target = await findRegistered(root, worktreePath, await getWorktrees(root));
  if (target.isMain) {
    throw new UnsafeWorktreeOperationError(`refusing to remove the main worktree: ${target.path}`);
  }
  if ((await resolveReal(target.path)) === (await resolveReal(root))) {
    throw new UnsafeWorktreeOperationError(`refusing to remove the repository root: ${target.path}`);
  }
  const args =
    options.force === true
      ? ["worktree", "remove", "--force", target.path]
      : ["worktree", "remove", target.path];
  await runGit(args, {
    cwd: root,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
}

/**
 * Prune stale worktree metadata (e.g. directories deleted out-of-band).
 * Returns the post-prune worktree list, re-read from Git.
 */
export async function pruneWorktrees(
  repoPath: string,
  options: WorktreeOperationOptions = {},
): Promise<WorktreeInfo[]> {
  const root = await validateRepository(repoPath);
  await runGit(["worktree", "prune"], {
    cwd: root,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
  return getWorktrees(root);
}
