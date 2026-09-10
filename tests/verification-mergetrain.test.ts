import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { NotFoundError } from "../src/core/errors.js";
import {
  createApproval,
  createFeature,
  createProject,
  createRepository,
  createTask,
  createWorker,
  decideApproval,
  transitionTask,
} from "../src/core/service.js";
import { createTaskClaims } from "../src/claims/index.js";
import {
  getCurrentBranch,
  getCurrentCommit,
  isClean,
  runGit,
  InvalidBranchNameError,
} from "../src/git/index.js";
import { getPrismaClient } from "../src/db/client.js";
import { assignTaskToWorker } from "../src/workspaces/index.js";
import { FakeWorkerProvider, executeTask } from "../src/workers/index.js";
import { MergeTrainNotApprovedError, runMergeTrain } from "../src/verification/index.js";
import { track, uniqueName } from "./domain-helpers.js";
import { initTempRepo, makeTempDir, trackTempPath } from "./git-helpers.js";

const db = getPrismaClient();
const NODE = process.execPath;

const PASS_CHECK = "process.exit(0);\n";
const COUNT_CHECK = [
  "import { readdirSync, readFileSync, statSync } from 'node:fs';",
  "import { join } from 'node:path';",
  "function walk(dir, out = []) {",
  "  for (const entry of readdirSync(dir)) {",
  "    const full = join(dir, entry);",
  "    if (statSync(full).isDirectory()) walk(full, out);",
  "    else if (full.endsWith('.ts')) out.push(full);",
  "  }",
  "  return out;",
  "}",
  "const total = walk('src').reduce((n, f) => n + readFileSync(f, 'utf8').split('\\n').length, 0);",
  "if (total > 10) { console.error(`too many lines: ${total}`); process.exit(1); }",
].join("\n");

async function initTrainRepo(checkBody: string, extraFiles: Record<string, string> = {}): Promise<string> {
  const dir = await initTempRepo();
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "train-fixture", scripts: { test: "node check.mjs" } }));
  await writeFile(join(dir, "check.mjs"), checkBody);
  for (const [rel, content] of Object.entries(extraFiles)) {
    await writeFile(join(dir, rel), content);
  }
  await runGit(["add", "-A"], { cwd: dir });
  await runGit(["-c", "commit.gpgsign=false", "commit", "-m", "train fixture"], { cwd: dir });
  return dir;
}

interface TrainItem {
  taskId: string;
  workerId: string;
  workspacePath: string;
  baseCommit: string;
  testRunId: string;
  head: string;
}

async function setupTrainItem(
  suffix: string,
  repoDir: string,
  repositoryId: string,
  featureId: string,
  claims: Array<{ resource: string; access: string }>,
  files: Record<string, string>,
  commit: boolean,
): Promise<TrainItem> {
  const pending = await createTask({ featureId, title: `task-${suffix}` });
  track("task", pending.id);
  const ready = await transitionTask(pending.id, "READY");
  await createTaskClaims({ taskId: ready.id, claims });
  const worker = await createWorker({});
  track("worker", worker.id);
  const approval = await createApproval({ taskId: ready.id });
  track("approval", approval.id);
  await decideApproval(approval.id, { decision: "APPROVED", actor: "tester" });
  const scratch = await makeTempDir();
  const assignment = await assignTaskToWorker({
    taskId: ready.id,
    workerId: worker.id,
    repositoryId,
    workspaceRoot: trackTempPath(`${scratch}/wsroot`),
  });
  track("workspace", assignment.workspace.id);
  for (const e of await db.event.findMany({ where: { taskId: ready.id } })) track("event", e.id);

  const execution = await executeTask(
    { taskId: ready.id, workerId: worker.id, expectedBaseCommit: assignment.worktree.commit },
    new FakeWorkerProvider(commit ? { files, commitMessage: `fake: ${suffix}` } : { files }),
  );
  if (execution.status !== "COMPLETED") {
    throw new Error(`fixture execution failed: ${execution.status} ${execution.error ?? ""}`);
  }
  const { runTests } = await import("../src/verification/index.js");
  const run = await runTests(
    { taskId: ready.id, workdir: assignment.workspace.path, command: [NODE, "--eval", "process.exit(0);"] },
    db,
  );
  track("testRun", run.testRunId);
  for (const a of await db.artifact.findMany({ where: { taskId: ready.id } })) track("artifact", a.id);
  for (const e of await db.event.findMany({ where: { taskId: ready.id } })) track("event", e.id);
  return {
    taskId: ready.id,
    workerId: worker.id,
    workspacePath: assignment.workspace.path,
    baseCommit: assignment.worktree.commit,
    testRunId: run.testRunId,
    head: await getCurrentCommit(assignment.workspace.path),
  };
}

async function setupTrainProject(suffix: string, repoDir: string) {
  const project = await createProject({ name: uniqueName(`train-proj-${suffix}`) });
  track("project", project.id);
  const repository = await createRepository({ projectId: project.id, name: "main", localPath: repoDir });
  track("repository", repository.id);
  const feature = await createFeature({ projectId: project.id, title: `feat-${suffix}` });
  track("feature", feature.id);
  return { project, repository, feature };
}

async function approveTrain(featureId: string): Promise<string> {
  const approval = await createApproval({ featureId });
  track("approval", approval.id);
  await decideApproval(approval.id, { decision: "APPROVED", actor: "human" });
  return approval.id;
}

async function trackTrainRecords(taskId: string): Promise<void> {
  for (const c of await db.commit.findMany({ where: { taskId } })) track("commit", c.id);
  for (const a of await db.artifact.findMany({ where: { taskId } })) track("artifact", a.id);
  for (const t of await db.testRun.findMany({ where: { taskId } })) track("testRun", t.id);
  for (const e of await db.event.findMany({ where: { taskId } })) track("event", e.id);
}

async function trainInput(
  suffix: string,
  repositoryId: string,
  baseCommit: string,
  approvalId: string,
  items: TrainItem[],
  extra: Record<string, unknown> = {},
) {
  const scratch = await makeTempDir();
  return {
    repositoryId,
    trainBranch: `atlas/train/${uniqueName(`t-${suffix}`).replace(/[^A-Za-z0-9_-]/g, "")}`,
    trainPath: trackTempPath(`${scratch}/train`),
    baseCommit,
    approvalId,
    items: items.map((item) => ({
      taskId: item.taskId,
      workerId: item.workerId,
      expectedBaseCommit: item.baseCommit,
      testRunId: item.testRunId,
    })),
    ...extra,
  };
}

describe("merge train", () => {
  it("integrates two disjoint workers in order with full audit trail", async () => {
    const repoDir = await initTrainRepo(PASS_CHECK);
    const base = await getCurrentCommit(repoDir);
    const { repository, feature } = await setupTrainProject("happy", repoDir);
    const itemA = await setupTrainItem("happy-a", repoDir, repository.id, feature.id, [{ resource: "src/a.txt", access: "WRITE" }], { "src/a.txt": "aaa\n" }, true);
    const itemB = await setupTrainItem("happy-b", repoDir, repository.id, feature.id, [{ resource: "src/b.txt", access: "WRITE" }], { "src/b.txt": "bbb\n" }, true);
    const approvalId = await approveTrain(feature.id);

    const result = await runMergeTrain(await trainInput("happy", repository.id, base, approvalId, [itemA, itemB]), db);
    for (const item of [itemA, itemB]) await trackTrainRecords(item.taskId);

    expect(result.status).toBe("COMPLETED");
    expect(result.trainBranch.startsWith("atlas/train/")).toBe(true);
    expect(result.baseCommit).toBe(base);
    expect(result.finalCommit).not.toBe(base);
    expect(result.items.map((item) => [item.taskId, item.status])).toEqual([
      [itemA.taskId, "INTEGRATED"],
      [itemB.taskId, "INTEGRATED"],
    ].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
    for (const item of result.items) {
      expect(item.mergeCommit).toMatch(/^[0-9a-f]{40}$/);
      expect(item.testRunId).toBeDefined();
    }
    expect(await readFileSafe(result.trainPath, "src/a.txt")).toBe("aaa\n");
    expect(await readFileSafe(result.trainPath, "src/b.txt")).toBe("bbb\n");
    expect(await db.commit.count({ where: { branch: result.trainBranch } })).toBe(2);

    // Main line untouched; worker workspaces untouched.
    expect(await getCurrentCommit(repoDir)).toBe(base);
    expect(await getCurrentBranch(repoDir)).toBe("main");
    expect(await isClean(repoDir)).toBe(true);
    expect(await getCurrentCommit(itemA.workspacePath)).toBe(itemA.head);
    expect(await getCurrentCommit(itemB.workspacePath)).toBe(itemB.head);

    // Approval recorded on the result.
    expect(result.approval.id).toBe(approvalId);
    expect(result.approval.actor).toBe("human");
  });

  it("halts on merge conflicts without touching main or worker workspaces", async () => {
    const repoDir = await initTrainRepo(PASS_CHECK, { "shared.txt": "base\n" });
    const base = await getCurrentCommit(repoDir);
    const { repository, feature } = await setupTrainProject("conflict", repoDir);
    const itemA = await setupTrainItem("conflict-a", repoDir, repository.id, feature.id, [{ resource: "shared.txt", access: "WRITE" }], { "shared.txt": "aaa\n" }, true);
    const itemB = await setupTrainItem("conflict-b", repoDir, repository.id, feature.id, [{ resource: "shared.txt", access: "WRITE" }], { "shared.txt": "bbb\n" }, true);
    const approvalId = await approveTrain(feature.id);

    const result = await runMergeTrain(await trainInput("conflict", repository.id, base, approvalId, [itemA, itemB]), db);
    for (const item of [itemA, itemB]) await trackTrainRecords(item.taskId);

    expect(result.status).toBe("HALTED");
    const byStatus = new Map(result.items.map((item) => [item.taskId, item]));
    const integrated = [...byStatus.values()].filter((item) => item.status === "INTEGRATED");
    const conflicted = [...byStatus.values()].filter((item) => item.status === "CONFLICT");
    expect(integrated).toHaveLength(1);
    expect(conflicted).toHaveLength(1);
    expect(conflicted[0]?.reason ?? "").toContain("shared.txt");
    expect(result.haltReason ?? "").toContain("shared.txt");

    expect(await getCurrentCommit(repoDir)).toBe(base);
    expect(await isClean(repoDir)).toBe(true);
    expect(await getCurrentCommit(itemA.workspacePath)).toBe(itemA.head);
    expect(await getCurrentCommit(itemB.workspacePath)).toBe(itemB.head);
    expect(await db.commit.count({ where: { branch: result.trainBranch } })).toBe(1);
  });

  it("halts when cumulative tests fail after a clean merge", async () => {
    const repoDir = await initTrainRepo(COUNT_CHECK);
    const base = await getCurrentCommit(repoDir);
    const { repository, feature } = await setupTrainProject("cumul", repoDir);
    const itemA = await setupTrainItem("cumul-a", repoDir, repository.id, feature.id, [{ resource: "src/a.ts", access: "WRITE" }], { "src/a.ts": "1\n2\n3\n4\n5\n" }, true);
    const itemB = await setupTrainItem("cumul-b", repoDir, repository.id, feature.id, [{ resource: "src/b.ts", access: "WRITE" }], { "src/b.ts": "1\n2\n3\n4\n5\n6\n" }, true);
    const approvalId = await approveTrain(feature.id);

    const result = await runMergeTrain(await trainInput("cumul", repository.id, base, approvalId, [itemA, itemB]), db);
    for (const item of [itemA, itemB]) await trackTrainRecords(item.taskId);

    expect(result.status).toBe("HALTED");
    const failed = result.items.find((item) => item.status === "TESTS_FAILED");
    expect(failed).toBeDefined();
    expect(failed?.testRunId).toBeDefined();
    expect(failed?.reason ?? "").toMatch(/failed/i);
    expect(result.items.filter((item) => item.status === "INTEGRATED")).toHaveLength(1);
    expect(result.finalCommit).not.toBe(base);
    expect(await getCurrentCommit(repoDir)).toBe(base);
  });

  it("requires an explicit approved decision", async () => {
    const repoDir = await initTrainRepo(PASS_CHECK);
    const base = await getCurrentCommit(repoDir);
    const { repository, feature } = await setupTrainProject("auth", repoDir);
    const item = await setupTrainItem("auth-a", repoDir, repository.id, feature.id, [{ resource: "src/a.txt", access: "WRITE" }], { "src/a.txt": "a\n" }, true);

    await expect(
      runMergeTrain(await trainInput("auth", repository.id, base, "missing", [item]), db),
    ).rejects.toThrow(NotFoundError);

    const pending = await createApproval({ featureId: feature.id });
    track("approval", pending.id);
    await expect(
      runMergeTrain(await trainInput("auth", repository.id, base, pending.id, [item]), db),
    ).rejects.toThrow(/explicit APPROVED/);

    const rejected = await createApproval({ featureId: feature.id });
    track("approval", rejected.id);
    await decideApproval(rejected.id, { decision: "REJECTED", actor: "human" });
    await expect(
      runMergeTrain(await trainInput("auth", repository.id, base, rejected.id, [item]), db),
    ).rejects.toThrow(/explicit APPROVED/);
  });

  it("halts on uncommitted worker changes without merging anything", async () => {
    const repoDir = await initTempRepo();
    const { repository, feature } = await setupTrainProject("dirty", repoDir);
    const item = await setupTrainItem("dirty-a", repoDir, repository.id, feature.id, [{ resource: "src/a.txt", access: "WRITE" }], { "src/a.txt": "dirty\n" }, false);
    const approvalId = await approveTrain(feature.id);
    const base = await getCurrentCommit(repoDir);

    const result = await runMergeTrain(await trainInput("dirty", repository.id, base, approvalId, [item]), db);
    await trackTrainRecords(item.taskId);
    expect(result.status).toBe("HALTED");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.status).toBe("VERIFICATION_FAILED");
    expect(result.finalCommit).toBe(base);
    expect(await db.commit.count({ where: { branch: result.trainBranch } })).toBe(0);
  });

  it("orders items deterministically regardless of input order", async () => {
    const repoDir = await initTrainRepo(PASS_CHECK);
    const base = await getCurrentCommit(repoDir);
    const { repository, feature } = await setupTrainProject("order", repoDir);
    const itemA = await setupTrainItem("order-a", repoDir, repository.id, feature.id, [{ resource: "src/a.txt", access: "WRITE" }], { "src/a.txt": "a\n" }, true);
    const itemB = await setupTrainItem("order-b", repoDir, repository.id, feature.id, [{ resource: "src/b.txt", access: "WRITE" }], { "src/b.txt": "b\n" }, true);
    const approvalId = await approveTrain(feature.id);

    const first = await runMergeTrain(await trainInput("order1", repository.id, base, approvalId, [itemA, itemB]), db);
    const second = await runMergeTrain(await trainInput("order2", repository.id, base, approvalId, [itemB, itemA]), db);
    for (const item of [itemA, itemB]) await trackTrainRecords(item.taskId);
    expect(first.items.map((item) => item.taskId)).toEqual(second.items.map((item) => item.taskId));
    expect(first.items.map((item) => item.status)).toEqual(["INTEGRATED", "INTEGRATED"]);
    expect(await db.commit.count({ where: { branch: first.trainBranch } })).toBe(2);
    expect(await db.commit.count({ where: { branch: second.trainBranch } })).toBe(2);
    for (const branch of [first.trainBranch, second.trainBranch]) {
      for (const c of await db.commit.findMany({ where: { branch } })) track("commit", c.id);
    }
  });

  it("uses explicit test commands in repos without configured tests", async () => {
    const repoDir = await initTempRepo();
    const base = await getCurrentCommit(repoDir);
    const { repository, feature } = await setupTrainProject("explicit", repoDir);
    const item = await setupTrainItem("explicit-a", repoDir, repository.id, feature.id, [{ resource: "src/a.txt", access: "WRITE" }], { "src/a.txt": "a\n" }, true);
    const approvalId = await approveTrain(feature.id);

    const explicit = [process.execPath, "--eval", "process.exit(0);"];
    const ok = await runMergeTrain(
      await trainInput("explicit", repository.id, base, approvalId, [item], { testCommand: explicit }),
      db,
    );
    await trackTrainRecords(item.taskId);
    expect(ok.status).toBe("COMPLETED");

    const missing = await runMergeTrain(await trainInput("explicit2", repository.id, base, approvalId, [item]), db);
    await trackTrainRecords(item.taskId);
    expect(missing.status).toBe("HALTED");
    expect(missing.items[0]?.status).toBe("TESTS_FAILED");
    expect(missing.items[0]?.reason ?? "").toMatch(/test command/i);
  });

  it("rejects malformed train input", async () => {
    const repoDir = await initTempRepo();
    const base = await getCurrentCommit(repoDir);
    const { repository, feature } = await setupTrainProject("malformed", repoDir);
    const item = await setupTrainItem("malformed-a", repoDir, repository.id, feature.id, [{ resource: "src/a.txt", access: "WRITE" }], { "src/a.txt": "a\n" }, true);
    const approvalId = await approveTrain(feature.id);
    const valid = await trainInput("malformed", repository.id, base, approvalId, [item]);

    await expect(runMergeTrain({ ...valid, items: [] }, db)).rejects.toThrow(ZodError);
    await expect(
      runMergeTrain(
        { ...valid, items: [valid.items[0], valid.items[0]].filter(Boolean) },
        db,
      ),
    ).rejects.toThrow(/duplicate train task/);
    await expect(runMergeTrain({ ...valid, trainBranch: "bad branch!" }, db)).rejects.toThrow(InvalidBranchNameError);
    await expect(runMergeTrain({ ...valid, repositoryId: "missing" }, db)).rejects.toThrow(NotFoundError);
  });
});

async function readFileSafe(dir: string, rel: string): Promise<string> {
  return readFile(join(dir, rel), "utf8");
}
