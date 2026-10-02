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
  // M19.4: an empty valid execution (COMPLETED_EMPTY) is legitimate fixture
  // input for merge-train tests, alongside ordinary COMPLETED work.
  if (execution.status !== "COMPLETED" && execution.status !== "COMPLETED_EMPTY") {
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
  sequences: Record<string, number> = {},
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
      ...(item.taskId in sequences ? { sequence: sequences[item.taskId] as number } : {}),
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

  it("preserves merge evidence on items and result (M19.3)", async () => {
    const repoDir = await initTrainRepo(PASS_CHECK);
    const base = await getCurrentCommit(repoDir);
    const { repository, feature } = await setupTrainProject("evidence", repoDir);
    const itemA = await setupTrainItem("evidence-a", repoDir, repository.id, feature.id, [{ resource: "src/a.txt", access: "WRITE" }], { "src/a.txt": "aaa\n" }, true);
    const approvalId = await approveTrain(feature.id);

    const result = await runMergeTrain(
      await trainInput("evidence", repository.id, base, approvalId, [itemA], { testCommand: [NODE, "--eval", "process.exit(0);"] }),
      db,
    );
    await trackTrainRecords(itemA.taskId);

    expect(result.status).toBe("COMPLETED");
    const [item] = result.items;
    expect(item?.status).toBe("INTEGRATED");
    expect(item?.mergeCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(item?.testRunId).toBeDefined();
    expect(item?.sourceCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(item?.reason).toBeUndefined();
    expect(item?.emptyMerge).toBeUndefined();
    expect(item?.conflictFiles).toBeUndefined();
    expect(result.testCommand).toEqual([NODE, "--eval", "process.exit(0);"]);
    expect(result.finalCommit).not.toBe(base);
  });

  it("records per-item and cumulative merge-train timing (M19.1)", async () => {
    const repoDir = await initTrainRepo(PASS_CHECK);
    const base = await getCurrentCommit(repoDir);
    const { repository, feature } = await setupTrainProject("timing", repoDir);
    const itemA = await setupTrainItem("timing-a", repoDir, repository.id, feature.id, [{ resource: "src/a.txt", access: "WRITE" }], { "src/a.txt": "aaa\n" }, true);
    const itemB = await setupTrainItem("timing-b", repoDir, repository.id, feature.id, [{ resource: "src/b.txt", access: "WRITE" }], { "src/b.txt": "bbb\n" }, true);
    const approvalId = await approveTrain(feature.id);

    const result = await runMergeTrain(await trainInput("timing", repository.id, base, approvalId, [itemA, itemB]), db);
    for (const item of [itemA, itemB]) await trackTrainRecords(item.taskId);

    expect(result.status).toBe("COMPLETED");
    // E. every processed item carries a finite, non-negative duration.
    expect(result.items).toHaveLength(2);
    const durations: number[] = [];
    for (const item of result.items) {
      expect(Number.isFinite(item.durationMs)).toBe(true);
      expect(item.durationMs as number).toBeGreaterThanOrEqual(0);
      durations.push(item.durationMs as number);
    }
    // F. cumulative train timing covers every item span.
    expect(Number.isFinite(result.durationMs)).toBe(true);
    expect(result.durationMs as number).toBeGreaterThanOrEqual(0);
    expect(result.durationMs as number).toBeGreaterThanOrEqual(Math.max(...durations));
  });

  it("continues past skipped empty items and still integrates later work (M19.4)", async () => {
    const repoDir = await initTrainRepo(PASS_CHECK);
    const base = await getCurrentCommit(repoDir);
    const { repository, feature } = await setupTrainProject("skip", repoDir);
    const emptyItem = await setupTrainItem("skip-empty", repoDir, repository.id, feature.id, [{ resource: "src/e.txt", access: "WRITE" }], {}, false);
    const validItem = await setupTrainItem("skip-valid", repoDir, repository.id, feature.id, [{ resource: "src/a.txt", access: "WRITE" }], { "src/a.txt": "aaa\n" }, true);
    const approvalId = await approveTrain(feature.id);

    const result = await runMergeTrain(
      await trainInput("skip", repository.id, base, approvalId, [emptyItem, validItem], {}, {
        [emptyItem.taskId]: 0,
        [validItem.taskId]: 1,
      }),
      db,
    );
    for (const item of [emptyItem, validItem]) await trackTrainRecords(item.taskId);

    expect(result.status).toBe("COMPLETED");
    const byId = new Map(result.items.map((entry) => [entry.taskId, entry]));
    expect(byId.get(emptyItem.taskId)?.status).toBe("SKIPPED_EMPTY");
    expect(byId.get(emptyItem.taskId)?.emptyMerge).toBe(true);
    expect(byId.get(validItem.taskId)?.status).toBe("INTEGRATED");
    expect(byId.get(validItem.taskId)?.mergeCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(result.finalCommit).not.toBe(base);
    expect(await db.commit.count({ where: { branch: result.trainBranch } })).toBe(1);
    expect(await readFileSafe(result.trainPath, "src/a.txt")).toBe("aaa\n");
  });

  it("keeps EMPTY_MERGE diagnosable when a halted train contains a skip (M19.4)", async () => {
    const repoDir = await initTrainRepo(PASS_CHECK, { "shared.txt": "base\n" });
    const base = await getCurrentCommit(repoDir);
    const { repository, feature } = await setupTrainProject("skiphalt", repoDir);
    const emptyItem = await setupTrainItem("skiphalt-empty", repoDir, repository.id, feature.id, [{ resource: "src/e.txt", access: "WRITE" }], {}, false);
    const itemA = await setupTrainItem("skiphalt-a", repoDir, repository.id, feature.id, [{ resource: "shared.txt", access: "WRITE" }], { "shared.txt": "aaa\n" }, true);
    const itemB = await setupTrainItem("skiphalt-b", repoDir, repository.id, feature.id, [{ resource: "shared.txt", access: "WRITE" }], { "shared.txt": "bbb\n" }, true);
    const approvalId = await approveTrain(feature.id);

    const result = await runMergeTrain(
      await trainInput("skiphalt", repository.id, base, approvalId, [emptyItem, itemA, itemB], {}, {
        [emptyItem.taskId]: 0,
        [itemA.taskId]: 1,
        [itemB.taskId]: 2,
      }),
      db,
    );
    for (const item of [emptyItem, itemA, itemB]) await trackTrainRecords(item.taskId);

    expect(result.status).toBe("HALTED");
    const byId = new Map(result.items.map((entry) => [entry.taskId, entry]));
    expect(byId.get(emptyItem.taskId)?.status).toBe("SKIPPED_EMPTY");
    expect([...byId.values()].filter((entry) => entry.status === "CONFLICT")).toHaveLength(1);

    const { triageIntegrationHalt } = await import("../src/triage/index.js");
    const scratch = await makeTempDir();
    const report = await triageIntegrationHalt(
      {
        repositoryId: repository.id,
        baseCommit: base,
        finalCommit: result.finalCommit,
        items: result.items.map((entry) => ({
          taskId: entry.taskId,
          workerId: entry.workerId,
          status: entry.status,
          ...(entry.testRunId !== undefined ? { testRunId: entry.testRunId } : {}),
          ...(entry.mergeCommit !== undefined ? { mergeCommit: entry.mergeCommit } : {}),
          ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
          ...(entry.emptyMerge !== undefined ? { emptyMerge: entry.emptyMerge } : {}),
        })),
        scratchParent: trackTempPath(`${scratch}/triage`),
      },
      db,
    );
    expect(report.classifications).toContain("EMPTY_MERGE");
    expect(report.classifications).toContain("GIT_CONFLICT");
    track("artifact", report.evidenceRefs.artifactId);
  });

  it("preserves git exit/stderr evidence on merge command failure (M19.3)", async () => {
    const repoDir = await initTrainRepo(PASS_CHECK);
    // Repo-local signature enforcement makes the merge itself fail without
    // any textual conflict: deterministic git-error path.
    await runGit(["config", "merge.verifySignatures", "true"], { cwd: repoDir });
    const base = await getCurrentCommit(repoDir);
    const { repository, feature } = await setupTrainProject("giterror", repoDir);
    const item = await setupTrainItem("giterror-a", repoDir, repository.id, feature.id, [{ resource: "src/a.txt", access: "WRITE" }], { "src/a.txt": "aaa\n" }, true);
    const approvalId = await approveTrain(feature.id);

    const result = await runMergeTrain(await trainInput("giterror", repository.id, base, approvalId, [item]), db);
    await trackTrainRecords(item.taskId);

    expect(result.status).toBe("HALTED");
    const [entry] = result.items;
    expect(entry?.status).toBe("MERGE_FAILED");
    expect(entry?.emptyMerge).toBeUndefined();
    expect(entry?.gitExitCode).toBe(128);
    expect(entry?.gitStderr ?? "").toContain("GPG signature");
    expect(entry?.reason ?? "").toContain("merge failed");
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
    // Conflict paths preserved structurally, not just in the reason text.
    expect(conflicted[0]?.conflictFiles ?? []).toContain("shared.txt");
    expect(conflicted[0]?.emptyMerge).toBeUndefined();
    // Halted-path items also carry timing (M19.1).
    for (const item of result.items) {
      expect(Number.isFinite(item.durationMs)).toBe(true);
    }
    expect(Number.isFinite(result.durationMs)).toBe(true);
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

  it("skips an empty worker branch instead of crashing on commit (M19.4 policy)", async () => {
    // A worker can finish successfully while its registered branch contains
    // no commit over the train base (e.g. a real agent that exited 0 without
    // committing). The merge is then a silent no-op ("Already up to date")
    // and a bare `git commit` would explode with "nothing to commit".
    // M19.4: the item is skipped with evidence instead of halting the train.
    const repoDir = await initTrainRepo(PASS_CHECK);
    const base = await getCurrentCommit(repoDir);
    const { repository, feature } = await setupTrainProject("empty", repoDir);
    const item = await setupTrainItem("empty-a", repoDir, repository.id, feature.id, [{ resource: "src/a.txt", access: "WRITE" }], {}, false);
    const approvalId = await approveTrain(feature.id);
    expect(item.head).toBe(base);

    const result = await runMergeTrain(await trainInput("empty", repository.id, base, approvalId, [item]), db);
    await trackTrainRecords(item.taskId);

    expect(result.status).toBe("COMPLETED");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.status).toBe("SKIPPED_EMPTY");
    expect(result.items[0]?.reason ?? "").toMatch(/no changes over .*base|nothing to integrate/i);
    expect(result.items[0]?.sourceCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(Number.isFinite(result.items[0]?.durationMs)).toBe(true);
    expect(result.finalCommit).toBe(base);
    expect(await db.commit.count({ where: { branch: result.trainBranch } })).toBe(0);
    expect(await getCurrentCommit(repoDir)).toBe(base);
    expect(await getCurrentBranch(repoDir)).toBe("main");
    expect(await isClean(repoDir)).toBe(true);
    expect(await getCurrentCommit(item.workspacePath)).toBe(item.head);
  });

  it("orders items deterministically regardless of input order", async () => {
    const repoDir = await initTrainRepo(PASS_CHECK);
    const base = await getCurrentCommit(repoDir);
    const { repository, feature } = await setupTrainProject("order", repoDir);
    const itemA = await setupTrainItem("order-a", repoDir, repository.id, feature.id, [{ resource: "src/a.txt", access: "WRITE" }], { "src/a.txt": "a\n" }, true);
    const itemB = await setupTrainItem("order-b", repoDir, repository.id, feature.id, [{ resource: "src/b.txt", access: "WRITE" }], { "src/b.txt": "b\n" }, true);
    const approvalId = await approveTrain(feature.id);

    const first = await runMergeTrain(await trainInput("order1", repository.id, base, approvalId, [itemA, itemB]), db);
    for (const item of [itemA, itemB]) await trackTrainRecords(item.taskId);
    expect(first.items.map((item) => item.status)).toEqual(["INTEGRATED", "INTEGRATED"]);
    expect(await db.commit.count({ where: { branch: first.trainBranch } })).toBe(2);
    // M23.1: INTEGRATED consumes the worker association, so re-training the
    // same items cannot re-verify through a live link — the second train
    // halts truthfully with LINK_INVALID instead of duplicating merges.
    const second = await runMergeTrain(await trainInput("order2", repository.id, base, approvalId, [itemB, itemA]), db);
    for (const item of [itemA, itemB]) await trackTrainRecords(item.taskId);
    expect(first.items.map((item) => item.taskId)).toEqual(second.items.map((item) => item.taskId));
    expect(second.status).toBe("HALTED");
    expect(second.items.map((item) => item.status)).toEqual(["VERIFICATION_FAILED", "NOT_ATTEMPTED"]);
    expect(second.items[0]?.reason ?? "").toMatch(/LINK_INVALID/);
    expect(await db.commit.count({ where: { branch: second.trainBranch } })).toBe(0);
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

    const missingItem = await setupTrainItem("explicit-b", repoDir, repository.id, feature.id, [{ resource: "src/a.txt", access: "WRITE" }], { "src/a.txt": "a\n" }, true);
    const missing = await runMergeTrain(await trainInput("explicit2", repository.id, base, approvalId, [missingItem]), db);
    await trackTrainRecords(missingItem.taskId);
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

async function mergeParents(repoDir: string, sha: string): Promise<string[]> {
  const result = await runGit(["log", "--format=%P", "-n", "1", sha], { cwd: repoDir });
  return result.stdout.trim().split(/\s+/).filter((parent) => parent.length > 0);
}

describe("merge train sequencing", () => {
  it("integrates in explicit sequence order instead of taskId order", async () => {
    const repoDir = await initTrainRepo(PASS_CHECK);
    const base = await getCurrentCommit(repoDir);
    const { repository, feature } = await setupTrainProject("seq", repoDir);
    const itemA = await setupTrainItem("seq-a", repoDir, repository.id, feature.id, [{ resource: "src/a.txt", access: "WRITE" }], { "src/a.txt": "aaa\n" }, true);
    const itemB = await setupTrainItem("seq-b", repoDir, repository.id, feature.id, [{ resource: "src/b.txt", access: "WRITE" }], { "src/b.txt": "bbb\n" }, true);
    const approvalId = await approveTrain(feature.id);

    // Force the opposite of taskId order: whichever sorts first gets sequence 1.
    const [firstId, secondId] = [itemA.taskId, itemB.taskId].sort();
    const first = firstId === itemA.taskId ? itemA : itemB;
    const second = secondId === itemA.taskId ? itemA : itemB;
    const input = await trainInput("seq", repository.id, base, approvalId, [first, second]);
    const sequenced = {
      ...input,
      items: (input.items as Array<Record<string, unknown>>).map((item) => ({
        ...item,
        sequence: item.taskId === second.taskId ? 0 : 1,
      })),
    };
    const result = await runMergeTrain(sequenced, db);
    for (const item of [itemA, itemB]) await trackTrainRecords(item.taskId);

    expect(result.status).toBe("COMPLETED");
    const byTask = new Map(result.items.map((item) => [item.taskId, item]));
    const firstMerge = byTask.get(second.taskId)?.mergeCommit;
    const secondMerge = byTask.get(first.taskId)?.mergeCommit;
    expect(firstMerge).toMatch(/^[0-9a-f]{40}$/);
    expect(secondMerge).toMatch(/^[0-9a-f]{40}$/);
    // Processing order follows sequence: second's merge is the parent of first's.
    expect(await mergeParents(repoDir, secondMerge ?? "")).toContain(firstMerge ?? "");
  });

  it("preserves legacy taskId order when sequence is absent", async () => {
    const repoDir = await initTrainRepo(PASS_CHECK);
    const base = await getCurrentCommit(repoDir);
    const { repository, feature } = await setupTrainProject("legacy", repoDir);
    const itemA = await setupTrainItem("legacy-a", repoDir, repository.id, feature.id, [{ resource: "src/a.txt", access: "WRITE" }], { "src/a.txt": "aaa\n" }, true);
    const itemB = await setupTrainItem("legacy-b", repoDir, repository.id, feature.id, [{ resource: "src/b.txt", access: "WRITE" }], { "src/b.txt": "bbb\n" }, true);
    const approvalId = await approveTrain(feature.id);

    // Pass items in reverse taskId order with no sequence fields at all.
    const input = await trainInput("legacy", repository.id, base, approvalId, [itemA, itemB]);
    const [sortedFirst, sortedSecond] = [itemA.taskId, itemB.taskId].sort();
    const reversed = {
      ...input,
      items: [...input.items].reverse(),
    };
    for (const item of reversed.items) {
      expect("sequence" in item).toBe(false);
    }
    const result = await runMergeTrain(reversed, db);
    for (const item of [itemA, itemB]) await trackTrainRecords(item.taskId);

    expect(result.status).toBe("COMPLETED");
    const byTask = new Map(result.items.map((item) => [item.taskId, item]));
    const firstMerge = sortedFirst === undefined ? undefined : byTask.get(sortedFirst)?.mergeCommit;
    const secondMerge = sortedSecond === undefined ? undefined : byTask.get(sortedSecond)?.mergeCommit;
    expect(firstMerge).toMatch(/^[0-9a-f]{40}$/);
    expect(secondMerge).toMatch(/^[0-9a-f]{40}$/);
    expect(await mergeParents(repoDir, secondMerge ?? "")).toContain(firstMerge ?? "");
  });
});

async function readFileSafe(dir: string, rel: string): Promise<string> {
  return readFile(join(dir, rel), "utf8");
}
