import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DomainError } from "../src/core/errors.js";
import {
  GitCommandError,
  InvalidBranchNameError,
  InvalidWorktreePathError,
  NotGitRepositoryError,
  UnsafeWorktreeOperationError,
  WorktreeAlreadyExistsError,
  WorktreeNotFoundError,
  assertValidBranchName,
  buildWorkerBranchName,
  createWorktree,
  getCurrentCommit,
  getWorktree,
  getWorktrees,
  pruneWorktrees,
  removeWorktree,
  runGit,
  worktreeExists,
} from "../src/git/index.js";
import { initTempRepo, makeTempDir, siblingDir } from "./git-helpers.js";

describe("git worktree engine", () => {
  it("creates a worktree on the expected branch starting from HEAD", async () => {
    const repo = await initTempRepo();
    const head = await getCurrentCommit(repo);
    const dest = siblingDir(repo, "wt-cart");

    const info = await createWorktree({ repoPath: repo, path: dest, branch: "atlas/worker/w1/task/t1" });
    expect(info.branch).toBe("atlas/worker/w1/task/t1");
    expect(info.commit).toBe(head);
    expect(info.isMain).toBe(false);
    expect((await stat(info.path)).isDirectory()).toBe(true);
    expect(await worktreeExists(repo, dest)).toBe(true);
  });

  it("starts the worktree from an explicit base commit", async () => {
    const repo = await initTempRepo();
    const first = await getCurrentCommit(repo);
    await writeFile(join(repo, "second.txt"), "second\n");
    await runGit(["add", "second.txt"], { cwd: repo });
    await runGit(["-c", "commit.gpgsign=false", "commit", "-m", "second"], { cwd: repo });

    const dest = siblingDir(repo, "wt-base");
    const info = await createWorktree({ repoPath: repo, path: dest, branch: "atlas/worker/w9/task/t9", base: first });
    expect(info.commit).toBe(first);
    await expect(stat(join(dest, "second.txt"))).rejects.toThrow();
    expect(await readFile(join(dest, "README.md"), "utf8")).toContain("atlas test");
  });

  it("supports multiple coexisting worktrees", async () => {
    const repo = await initTempRepo();
    const first = siblingDir(repo, "wt-one");
    const second = siblingDir(repo, "wt-two");
    await createWorktree({ repoPath: repo, path: first, branch: "atlas/worker/w1/task/t1" });
    await createWorktree({ repoPath: repo, path: second, branch: "atlas/worker/w2/task/t2" });

    const list = await getWorktrees(repo);
    expect(list).toHaveLength(3);
    expect(list[0]?.isMain).toBe(true);
    const branches = list.map((entry) => entry.branch).sort();
    expect(branches).toEqual(["atlas/worker/w1/task/t1", "atlas/worker/w2/task/t2", "main"]);
  });

  it("rejects creation into an existing non-empty directory", async () => {
    const repo = await initTempRepo();
    const dest = siblingDir(repo, "wt-blocked");
    await mkdir(dest, { recursive: true });
    await writeFile(join(dest, "existing.txt"), "do not overwrite\n");
    await expect(
      createWorktree({ repoPath: repo, path: dest, branch: "atlas/worker/w1/task/t1" }),
    ).rejects.toThrow(InvalidWorktreePathError);
  });

  it("rejects creation when the destination is already registered", async () => {
    const repo = await initTempRepo();
    const dest = siblingDir(repo, "wt-dup");
    await createWorktree({ repoPath: repo, path: dest, branch: "atlas/worker/w1/task/t1" });
    await expect(
      createWorktree({ repoPath: repo, path: dest, branch: "atlas/worker/w2/task/t2" }),
    ).rejects.toThrow(WorktreeAlreadyExistsError);
  });

  it("rejects destinations inside the repository root and the root itself", async () => {
    const repo = await initTempRepo();
    await expect(
      createWorktree({ repoPath: repo, path: join(repo, "nested"), branch: "atlas/worker/w1/task/t1" }),
    ).rejects.toThrow(InvalidWorktreePathError);
    await expect(
      createWorktree({ repoPath: repo, path: repo, branch: "atlas/worker/w1/task/t1" }),
    ).rejects.toThrow(UnsafeWorktreeOperationError);
  });

  it("removes a worktree from disk and from git metadata", async () => {
    const repo = await initTempRepo();
    const dest = siblingDir(repo, "wt-gone");
    await createWorktree({ repoPath: repo, path: dest, branch: "atlas/worker/w1/task/t1" });
    await removeWorktree(repo, dest);
    expect(await worktreeExists(repo, dest)).toBe(false);
    await expect(stat(dest)).rejects.toThrow();
    expect(await getWorktrees(repo)).toHaveLength(1);
  });

  it("refuses to remove the main worktree", async () => {
    const repo = await initTempRepo();
    await expect(removeWorktree(repo, repo)).rejects.toThrow(UnsafeWorktreeOperationError);
    expect(await getWorktrees(repo)).toHaveLength(1);
  });

  it("reports unknown worktrees as not found", async () => {
    const repo = await initTempRepo();
    const missing = siblingDir(repo, "wt-missing");
    expect(await worktreeExists(repo, missing)).toBe(false);
    await expect(getWorktree(repo, missing)).rejects.toThrow(WorktreeNotFoundError);
    await expect(removeWorktree(repo, missing)).rejects.toThrow(WorktreeNotFoundError);
  });

  it("requires force to remove a dirty worktree", async () => {
    const repo = await initTempRepo();
    const dest = siblingDir(repo, "wt-dirty");
    await createWorktree({ repoPath: repo, path: dest, branch: "atlas/worker/w1/task/t1" });
    await writeFile(join(dest, "README.md"), "# dirty\n");

    await expect(removeWorktree(repo, dest)).rejects.toThrow(GitCommandError);
    expect(await worktreeExists(repo, dest)).toBe(true);

    await removeWorktree(repo, dest, { force: true });
    expect(await worktreeExists(repo, dest)).toBe(false);
  });

  it("prunes stale metadata after out-of-band directory deletion", async () => {
    const repo = await initTempRepo();
    const dest = siblingDir(repo, "wt-stale");
    await createWorktree({ repoPath: repo, path: dest, branch: "atlas/worker/w1/task/t1" });
    await rm(dest, { recursive: true, force: true });

    const before = await getWorktrees(repo);
    expect(before.some((entry) => entry.prunable)).toBe(true);

    const after = await pruneWorktrees(repo);
    expect(after.some((entry) => entry.path === before[1]?.path)).toBe(false);
    expect(after).toHaveLength(1);
  });

  it("rejects worktree operations outside git repositories", async () => {
    const dir = await makeTempDir();
    await expect(getWorktrees(dir)).rejects.toThrow(NotGitRepositoryError);
  });

  it("builds deterministic worker branch names and rejects traversal ids", async () => {
    expect(buildWorkerBranchName("w1", "t2")).toBe("atlas/worker/w1/task/t2");
    for (const bad of ["../evil", "..", "", "a/b", "has space", "semi;colon", "-lead"]) {
      expect(() => buildWorkerBranchName(bad, "t1")).toThrow(InvalidBranchNameError);
      expect(() => buildWorkerBranchName("w1", bad)).toThrow(InvalidBranchNameError);
    }
  });

  it("validates branch names against git rules", async () => {
    expect(() => assertValidBranchName("atlas/worker/w1/task/t1")).not.toThrow();
    for (const bad of [
      "",
      "..",
      "a//b",
      "/leading",
      "trailing/",
      "trailing.",
      "has space",
      "a~b",
      "a^b",
      "a:b",
      "a?b",
      "a*b",
      "a[b",
      "a\\b",
      "a.lock",
      "@",
      "a@{b",
      "-leading-dash",
    ]) {
      expect(() => assertValidBranchName(bad)).toThrow(InvalidBranchNameError);
    }
    const repo = await initTempRepo();
    await expect(
      createWorktree({ repoPath: repo, path: siblingDir(repo, "wt-evil"), branch: "../evil" }),
    ).rejects.toThrow(InvalidBranchNameError);
  });

  it("exposes all git failures as domain errors", async () => {
    const repo = await initTempRepo();
    const dest = siblingDir(repo, "wt-typed");
    await createWorktree({ repoPath: repo, path: dest, branch: "atlas/worker/w1/task/t1" });
    try {
      await createWorktree({ repoPath: repo, path: dest, branch: "atlas/worker/w1/task/t1" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect(error).toBeInstanceOf(WorktreeAlreadyExistsError);
    }
  });
});
