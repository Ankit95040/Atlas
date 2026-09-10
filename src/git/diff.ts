import { runGit } from "./client.js";
import { getRepositoryRoot } from "./repository.js";

export type WorktreeChangeKind = "ADDED" | "MODIFIED" | "DELETED" | "RENAMED";

export interface WorktreeChange {
  /** Repository-root-relative POSIX path. */
  readonly path: string;
  readonly change: WorktreeChangeKind;
  /** Previous path for renames. */
  readonly oldPath?: string;
}

function parseNameStatus(output: string): WorktreeChange[] {
  const tokens = output.split("\0").filter((token) => token.length > 0);
  const changes: WorktreeChange[] = [];
  let index = 0;
  while (index < tokens.length) {
    const status = tokens[index];
    index += 1;
    if (status === undefined || status.length === 0) {
      break;
    }
    const code = status.charAt(0);
    if (code === "R" || code === "C") {
      const oldPath = tokens[index];
      const newPath = tokens[index + 1];
      index += 2;
      if (oldPath !== undefined && newPath !== undefined) {
        changes.push({
          path: newPath,
          change: code === "R" ? "RENAMED" : "MODIFIED",
          ...(code === "R" ? { oldPath } : {}),
        });
      }
      continue;
    }
    const path = tokens[index];
    index += 1;
    if (path === undefined) {
      break;
    }
    if (code === "A") {
      changes.push({ path, change: "ADDED" });
    } else if (code === "D") {
      changes.push({ path, change: "DELETED" });
    } else {
      // T (typechange), U (unmerged), and anything unrecognized: still a
      // modification of that path. Conservative — never silently dropped.
      changes.push({ path, change: "MODIFIED" });
    }
  }
  return changes;
}

function compareByPath(a: WorktreeChange, b: WorktreeChange): number {
  if (a.path < b.path) {
    return -1;
  }
  if (a.path > b.path) {
    return 1;
  }
  return 0;
}

/**
 * Path-level changes in a worktree relative to a base commit: tracked
 * modifications (staged or not) via `git diff`, plus untracked files via
 * `git ls-files`. Commands run with cwd at the repository root so every path
 * is repository-root-relative; output is sorted (never traversal order).
 * Read-only against both the worktree and the main checkout.
 */
export async function getWorktreeChanges(worktreePath: string, baseCommit: string): Promise<WorktreeChange[]> {
  const root = await getRepositoryRoot(worktreePath);
  const diff = await runGit(
    ["-c", "core.quotepath=off", "diff", "--name-status", "-z", "-M", "--no-color", baseCommit, "--"],
    { cwd: root },
  );
  const changes = parseNameStatus(diff.stdout);
  const untracked = await runGit(["ls-files", "--others", "--exclude-standard", "-z"], { cwd: root });
  for (const entry of untracked.stdout.split("\0")) {
    const path = entry.trim();
    if (path.length > 0) {
      changes.push({ path, change: "ADDED" });
    }
  }
  return changes.sort(compareByPath);
}
