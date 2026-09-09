import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { runGit } from "../src/git/index.js";

// Every test repository lives under a fresh temp dir (realpath'd to defeat
// macOS /tmp symlinks). Nothing ever touches the Atlas working tree.
const tempRoots: string[] = [];

/** Register an extra path (e.g. a sibling worktree dir) for post-test cleanup. */
export function trackTempPath(path: string): string {
  tempRoots.push(path);
  return path;
}

/** Sibling scratch dir next to a temp repo (the Atlas worktree pattern), auto-cleaned. */
export function siblingDir(repo: string, name: string): string {
  return trackTempPath(join(repo, "..", `${name}-${process.pid}`));
}

export async function initTempRepo(): Promise<string> {
  const base = await realpath(tmpdir());
  const dir = await mkdtemp(join(base, "atlas-git-test-"));
  tempRoots.push(dir);
  await runGit(["init", "-b", "main"], { cwd: dir });
  await runGit(["config", "user.email", "atlas-test@example.invalid"], { cwd: dir });
  await runGit(["config", "user.name", "Atlas Test"], { cwd: dir });
  await writeFile(join(dir, "README.md"), "# atlas test\n");
  await runGit(["add", "README.md"], { cwd: dir });
  await runGit(["-c", "commit.gpgsign=false", "commit", "-m", "initial commit"], { cwd: dir });
  return dir;
}

export async function makeTempDir(): Promise<string> {
  const base = await realpath(tmpdir());
  const dir = await mkdtemp(join(base, "atlas-git-empty-"));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});
