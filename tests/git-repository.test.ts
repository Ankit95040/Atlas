import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DomainError } from "../src/core/errors.js";
import {
  GitCommandError,
  NotGitRepositoryError,
  branchExists,
  createBranch,
  getCurrentBranch,
  getCurrentCommit,
  getRepositoryRoot,
  getStatus,
  isClean,
  runGit,
  validateRepository,
} from "../src/git/index.js";
import { initTempRepo, makeTempDir } from "./git-helpers.js";

describe("git repository inspection", () => {
  it("detects a valid git repository and resolves its root", async () => {
    const repo = await initTempRepo();
    const root = await validateRepository(repo);
    expect(root).toBe(repo);
  });

  it("resolves the root from a subdirectory", async () => {
    const repo = await initTempRepo();
    const sub = join(repo, "packages", "app");
    await mkdir(sub, { recursive: true });
    expect(await getRepositoryRoot(sub)).toBe(repo);
  });

  it("rejects a non-git directory", async () => {
    const dir = await makeTempDir();
    await expect(validateRepository(dir)).rejects.toThrow(NotGitRepositoryError);
    await expect(validateRepository(dir)).rejects.toThrow(DomainError);
  });

  it("memoizes root resolution per path without caching failures (M28.3)", async () => {
    const repo = await initTempRepo();
    const first = await getRepositoryRoot(repo);
    const second = await getRepositoryRoot(repo);
    expect(second).toBe(first);
    // A failed lookup must not poison a later success for the same path:
    // init the repo after the failure and resolution must succeed.
    const dir = await makeTempDir();
    await expect(validateRepository(dir)).rejects.toThrow(NotGitRepositoryError);
    await runGit(["init", "-b", "main"], { cwd: dir });
    expect(await getRepositoryRoot(dir)).toBe(dir);
  });

  it("reads the current branch and commit", async () => {
    const repo = await initTempRepo();
    expect(await getCurrentBranch(repo)).toBe("main");
    const commit = await getCurrentCommit(repo);
    expect(commit).toMatch(/^[0-9a-f]{40}$/);
    expect(await getCurrentCommit(repo)).toBe(commit);
  });

  it("reports null branch on a detached HEAD", async () => {
    const repo = await initTempRepo();
    const commit = await getCurrentCommit(repo);
    await runGit(["checkout", "--detach", commit], { cwd: repo });
    expect(await getCurrentBranch(repo)).toBeNull();
    expect(await getCurrentCommit(repo)).toBe(commit);
  });

  it("detects a clean repository", async () => {
    const repo = await initTempRepo();
    expect(await isClean(repo)).toBe(true);
    const status = await getStatus(repo);
    expect(status.clean).toBe(true);
    expect(status.staged).toEqual([]);
    expect(status.unstaged).toEqual([]);
    expect(status.untracked).toEqual([]);
  });

  it("detects modified files", async () => {
    const repo = await initTempRepo();
    await writeFile(join(repo, "README.md"), "# changed\n");
    expect(await isClean(repo)).toBe(false);
    const status = await getStatus(repo);
    expect(status.unstaged).toContain("README.md");
    expect(status.staged).toEqual([]);
  });

  it("detects untracked files", async () => {
    const repo = await initTempRepo();
    await writeFile(join(repo, "notes.txt"), "scratch\n");
    const status = await getStatus(repo);
    expect(status.clean).toBe(false);
    expect(status.untracked).toContain("notes.txt");
  });

  it("detects staged files", async () => {
    const repo = await initTempRepo();
    await writeFile(join(repo, "staged.txt"), "staged\n");
    await runGit(["add", "staged.txt"], { cwd: repo });
    const status = await getStatus(repo);
    expect(status.clean).toBe(false);
    expect(status.staged).toContain("staged.txt");
    expect(status.untracked).not.toContain("staged.txt");
  });

  it("creates branches and reports their existence", async () => {
    const repo = await initTempRepo();
    expect(await branchExists(repo, "feature/x")).toBe(false);
    await createBranch(repo, "feature/x");
    expect(await branchExists(repo, "feature/x")).toBe(true);
  });

  it("surfaces git failures as typed errors with command context", async () => {
    const repo = await initTempRepo();
    try {
      await runGit(["rev-parse", "--verify", "refs/heads/definitely-missing"], { cwd: repo });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(GitCommandError);
      const failure = error as GitCommandError;
      expect(failure.code).toBe("GIT_COMMAND_FAILED");
      expect(failure.exitCode).not.toBe(0);
      expect(failure.cwd).toBe(repo);
      expect(failure.args).toContain("rev-parse");
      expect(failure.stderr.length).toBeGreaterThan(0);
    }
  });
});
