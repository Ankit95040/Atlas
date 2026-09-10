import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GitCommandError, NotGitRepositoryError, getWorktreeChanges, runGit } from "../src/git/index.js";
import { initTempRepo, makeTempDir } from "./git-helpers.js";

async function commitFile(repo: string, rel: string, content: string): Promise<void> {
  const absolute = join(repo, rel);
  await mkdir(join(absolute, ".."), { recursive: true });
  await writeFile(absolute, content);
  await runGit(["add", "-A"], { cwd: repo });
  await runGit(["-c", "commit.gpgsign=false", "commit", "-m", `add ${rel}`], { cwd: repo });
}

async function baseOf(repo: string): Promise<string> {
  const result = await runGit(["rev-parse", "HEAD"], { cwd: repo });
  return result.stdout.trim();
}

describe("worktree change inspection", () => {
  it("detects modified, added, and deleted files", async () => {
    const repo = await initTempRepo();
    await commitFile(repo, "src/keep.ts", "v1\n");
    await commitFile(repo, "src/del.ts", "bye\n");
    const base = await baseOf(repo);

    await writeFile(join(repo, "src/keep.ts"), "v2\n");
    await rm(join(repo, "src/del.ts"));
    await writeFile(join(repo, "src/added.ts"), "new\n");
    await runGit(["add", "-A"], { cwd: repo });

    expect(await getWorktreeChanges(repo, base)).toEqual([
      { path: "src/added.ts", change: "ADDED" },
      { path: "src/del.ts", change: "DELETED" },
      { path: "src/keep.ts", change: "MODIFIED" },
    ]);
  });

  it("detects staged renames with old paths", async () => {
    const repo = await initTempRepo();
    await commitFile(repo, "src/old-name.ts", "same content here\n");
    const base = await baseOf(repo);

    await runGit(["mv", "src/old-name.ts", "src/new-name.ts"], { cwd: repo });
    expect(await getWorktreeChanges(repo, base)).toEqual([
      { path: "src/new-name.ts", change: "RENAMED", oldPath: "src/old-name.ts" },
    ]);
  });

  it("detects untracked files including nested new directories", async () => {
    const repo = await initTempRepo();
    const base = await baseOf(repo);

    await mkdir(join(repo, "brand-new", "deep"), { recursive: true });
    await writeFile(join(repo, "brand-new", "deep", "file.ts"), "x\n");
    await writeFile(join(repo, "top.ts"), "y\n");

    expect(await getWorktreeChanges(repo, base)).toEqual([
      { path: "brand-new/deep/file.ts", change: "ADDED" },
      { path: "top.ts", change: "ADDED" },
    ]);
  });

  it("returns an empty sorted list for a clean worktree", async () => {
    const repo = await initTempRepo();
    expect(await getWorktreeChanges(repo, await baseOf(repo))).toEqual([]);
  });

  it("fails clearly on unknown base commits and non-repositories", async () => {
    const repo = await initTempRepo();
    await expect(getWorktreeChanges(repo, "0123456789abcdef0123456789abcdef01234567")).rejects.toThrow(
      GitCommandError,
    );
    await expect(getWorktreeChanges(await makeTempDir(), "0123456789abcdef0123456789abcdef01234567")).rejects.toThrow(
      NotGitRepositoryError,
    );
  });
});
