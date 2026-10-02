import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { PrismaClient } from "@prisma/client";
import {
  createWorktree,
  pruneWorktrees,
  removeWorktree,
  runGit,
} from "../git/index.js";
import { findHistoricalWorkerId } from "../workspaces/index.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Branch holding a task's work, resolved through worker → workspace records. Never guessed. */
export async function resolveTaskBranch(
  db: PrismaClient,
  repoRoot: string,
  taskId: string,
): Promise<{ branch: string } | { unknown: string }> {
  const live = await db.worker.findUnique({ where: { taskId }, include: { workspace: true } });
  // M23.1: integrated tasks no longer hold a live worker link (released at
  // INTEGRATED), so fall back to the historically linked worker from event
  // payloads. Halted items keep live links; this only widens resolution.
  let worker = live;
  if (worker === null) {
    const historicalId = await findHistoricalWorkerId(db, taskId);
    worker = historicalId === null ? null : await db.worker.findUnique({ where: { id: historicalId }, include: { workspace: true } });
  }
  const stored = worker?.workspace?.branch ?? null;
  if (stored === null) {
    return { unknown: `task ${taskId} has no recorded worker branch` };
  }
  // Confirm the ref still exists; a deleted branch is unknown, not an error.
  try {
    await runGit(["rev-parse", "--verify", stored], { cwd: repoRoot });
  } catch {
    return { unknown: `branch ${stored} for task ${taskId} no longer exists` };
  }
  return { branch: stored };
}

/** Repo-relative files changed on a branch vs base. Throws when the ref is gone. */
export async function diffBranchFiles(repoRoot: string, base: string, branch: string): Promise<string[]> {
  const result = await runGit(["diff", "--name-only", base, branch, "--"], { cwd: repoRoot });
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .sort();
}

export interface ReplayEvidence {
  /** Git-confirmed unmerged paths from the replayed merge. */
  readonly conflictFiles: string[];
  /** Honest notes (e.g. replay merge was clean, or replay failed and why). */
  readonly notes: string[];
}

/**
 * Reproduce the halted merge in a throwaway worktree and read Git's answer.
 *
 * Lifecycle: create temp worktree at `finalCommit` → `merge --no-commit`
 * the halted branch → collect `diff --name-only --diff-filter=U` → abort →
 * force-remove the worktree, delete the temp branch, prune — all in
 * `finally`. NEVER touches main, the train worktree, or any worker
 * workspace: the replay destination is vacant, outside the repo root, on a
 * unique branch. A replay failure degrades (empty files + note), never throws.
 */
export async function collectReplayEvidence(args: {
  repoRoot: string;
  finalCommit: string;
  haltedBranch: string;
  haltedTaskId: string;
  scratchParent: string;
}): Promise<ReplayEvidence> {
  const notes: string[] = [];
  let replayPath = "";
  let replayBranch = "";
  try {
    await mkdir(args.scratchParent, { recursive: true });
    replayBranch = `atlas/triage/replay-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    replayPath = join(args.scratchParent, `replay-${args.haltedTaskId}-${Date.now()}`);
    const worktree = await createWorktree({
      repoPath: args.repoRoot,
      path: replayPath,
      branch: replayBranch,
      base: args.finalCommit,
    });
    try {
      await runGit(["merge", "--no-ff", "--no-commit", args.haltedBranch], { cwd: worktree.path });
      // Clean merge in replay: the original conflict is not reproducible
      // from current refs — report honestly instead of inventing files.
      notes.push("replay merge applied cleanly; no unmerged paths reproduced");
      return { conflictFiles: [], notes };
    } catch {
      const unmerged = await runGit(["diff", "--name-only", "--diff-filter=U"], { cwd: worktree.path });
      const conflictFiles = unmerged.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .sort();
      return { conflictFiles, notes };
    } finally {
      try {
        await runGit(["merge", "--abort"], { cwd: worktree.path });
      } catch {
        // Best effort: may not be in a merging state.
      }
    }
  } catch (error) {
    notes.push(`replay evidence unavailable: ${errorMessage(error)}`);
    return { conflictFiles: [], notes };
  } finally {
    if (replayPath !== "") {
      try {
        await removeWorktree(args.repoRoot, replayPath, { force: true });
      } catch (error) {
        notes.push(`replay worktree removal failed: ${errorMessage(error)}`);
      }
    }
    if (replayBranch !== "") {
      try {
        await runGit(["branch", "-D", replayBranch], { cwd: args.repoRoot });
      } catch {
        // Best effort: branch cleanup for our own temp ref.
      }
    }
    try {
      await pruneWorktrees(args.repoRoot);
    } catch {
      // Best effort.
    }
  }
}
