import { runGit } from "./client.js";
import { GitCommandError, InvalidBranchNameError, NotGitRepositoryError } from "./errors.js";
import type { RepositoryStatus } from "./types.js";

// ---------- Repository inspection (Git CLI is the source of truth) ----------

/**
 * Resolve the repository root for any path inside a working tree.
 * Throws NotGitRepositoryError when Git does not consider it a repository.
 */
export async function getRepositoryRoot(path: string): Promise<string> {
  try {
    const result = await runGit(["rev-parse", "--show-toplevel"], { cwd: path });
    return result.stdout.trim();
  } catch (error) {
    if (error instanceof GitCommandError && /not a git repository/i.test(error.stderr)) {
      throw new NotGitRepositoryError(path);
    }
    throw error;
  }
}

/** Alias with validation semantics: returns the root or throws NotGitRepositoryError. */
export async function validateRepository(path: string): Promise<string> {
  return getRepositoryRoot(path);
}

/** Current branch name, or null on a detached HEAD. */
export async function getCurrentBranch(path: string): Promise<string | null> {
  const result = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: path });
  const branch = result.stdout.trim();
  return branch === "HEAD" ? null : branch;
}

/** Full HEAD commit SHA. */
export async function getCurrentCommit(path: string): Promise<string> {
  const result = await runGit(["rev-parse", "HEAD"], { cwd: path });
  return result.stdout.trim();
}

export async function getStatus(path: string): Promise<RepositoryStatus> {
  const result = await runGit(["status", "--porcelain=v1", "--untracked-files=normal"], { cwd: path });
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];

  for (const line of result.stdout.split("\n")) {
    if (line.length < 4) {
      continue;
    }
    const x = line.charAt(0);
    const y = line.charAt(1);
    let file = line.slice(3);
    const arrow = file.indexOf(" -> ");
    if (arrow >= 0) {
      file = file.slice(arrow + 4);
    }
    if (file.startsWith('"') && file.endsWith('"') && file.length >= 2) {
      file = file.slice(1, -1);
    }
    if (x === "?" && y === "?") {
      untracked.push(file);
    } else {
      if (x !== " ") {
        staged.push(file);
      }
      if (y !== " ") {
        unstaged.push(file);
      }
    }
  }

  return {
    staged,
    unstaged,
    untracked,
    clean: staged.length === 0 && unstaged.length === 0 && untracked.length === 0,
  };
}

export async function isClean(path: string): Promise<boolean> {
  return (await getStatus(path)).clean;
}

// ---------- Branches (for future worker isolation) ----------

/**
 * Deterministic branch-name validation (subset of `git check-ref-format`
 * sufficient for Atlas-generated and accepted names). Rejects empty names,
 * path traversal (`..`), whitespace/control characters, git-special
 * characters, and leading-dash components (unsafe as CLI args).
 */
export function assertValidBranchName(name: string): void {
  const fail = (reason: string): never => {
    throw new InvalidBranchNameError(name, reason);
  };
  if (name.length === 0) {
    fail("must not be empty");
  }
  if (name.length > 255) {
    fail("must not exceed 255 characters");
  }
  if (name === "@") {
    fail('must not be "@"');
  }
  if (/[\x00-\x20\x7f~^:?*[\]\\]/.test(name)) {
    fail("contains whitespace, control, or git-special characters");
  }
  if (name.includes("..") || name.includes("//")) {
    fail('must not contain ".." or empty components');
  }
  if (name.startsWith("/") || name.endsWith("/") || name.endsWith(".")) {
    fail("must not start/end with a slash or end with a dot");
  }
  if (name.endsWith(".lock")) {
    fail('must not end with ".lock"');
  }
  if (name.includes("@{")) {
    fail('must not contain "@{"');
  }
  for (const component of name.split("/")) {
    if (component.length === 0 || component === "." || component === "..") {
      fail("contains an empty or dot component");
    }
    if (component.startsWith("-")) {
      fail("components must not start with a dash");
    }
  }
}

/** Ids embedded in generated branch names: cuid-style segments only (no traversal). */
export function assertSafeIdSegment(label: string, value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)) {
    throw new InvalidBranchNameError(value, `${label} must be alphanumeric with dashes/underscores`);
  }
}

export async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  assertValidBranchName(branch);
  try {
    await runGit(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repoPath });
    return true;
  } catch (error) {
    if (error instanceof GitCommandError && error.exitCode === 1) {
      return false;
    }
    throw error;
  }
}

/** Create a branch at `base` (default HEAD). The branch must not exist yet. */
export async function createBranch(repoPath: string, branch: string, base = "HEAD"): Promise<string> {
  assertValidBranchName(branch);
  await runGit(["branch", branch, base], { cwd: repoPath });
  return branch;
}
