import { mkdir, rm, writeFile } from "node:fs/promises";
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
  transitionWorker,
} from "../src/core/service.js";
import { createTaskClaims, getTaskClaims } from "../src/claims/index.js";
import { getCurrentBranch, getCurrentCommit, isClean, runGit } from "../src/git/index.js";
import { getPrismaClient } from "../src/db/client.js";
import { assignTaskToWorker } from "../src/workspaces/index.js";
import { FakePlannerProvider, runPlanner } from "../src/planner/index.js";
import { planSchedule } from "../src/dag/index.js";
import {
  CommandFailureError,
  FakeWorkerProvider,
  executeTask,
  type WorkerExecutionInput,
  type WorkerProvider,
} from "../src/workers/index.js";
import { track, uniqueName } from "./domain-helpers.js";
import { initTempRepo, makeTempDir, trackTempPath } from "./git-helpers.js";

const db = getPrismaClient();

interface ClaimInput {
  resource: string;
  access: string;
}

async function setupExecution(
  suffix: string,
  repoDir: string,
  claims: ClaimInput[],
  opts: { approve?: boolean; approved?: boolean; description?: string } = {},
) {
  const project = await createProject({ name: uniqueName(`run-proj-${suffix}`) });
  track("project", project.id);
  const repository = await createRepository({ projectId: project.id, name: "main", localPath: repoDir });
  track("repository", repository.id);
  const feature = await createFeature({ projectId: project.id, title: `feat-${suffix}` });
  track("feature", feature.id);
  const pending = await createTask({
    featureId: feature.id,
    title: `task-${suffix}`,
    ...(opts.description !== undefined ? { description: opts.description } : {}),
  });
  track("task", pending.id);
  const ready = await transitionTask(pending.id, "READY");
  if (claims.length > 0) {
    await createTaskClaims({ taskId: ready.id, claims });
  }
  const worker = await createWorker({});
  track("worker", worker.id);
  const approval = await createApproval({ taskId: ready.id });
  track("approval", approval.id);
  if (opts.approve ?? true) {
    await decideApproval(approval.id, { decision: opts.approved === false ? "REJECTED" : "APPROVED", actor: "tester" });
  }
  const scratch = await makeTempDir();
  const workspaceRoot = trackTempPath(`${scratch}/wsroot`);
  const assignment = await assignTaskToWorker({
    taskId: ready.id,
    workerId: worker.id,
    repositoryId: repository.id,
    workspaceRoot,
  });
  track("workspace", assignment.workspace.id);
  for (const e of await db.event.findMany({ where: { taskId: ready.id } })) track("event", e.id);
  return {
    project,
    repository,
    feature,
    task: assignment.task,
    worker: assignment.worker,
    workspace: assignment.workspace,
    baseCommit: assignment.worktree.commit,
    workspacePath: assignment.workspace.path,
  };
}

async function trackExecutionRecords(taskId: string): Promise<void> {
  for (const a of await db.artifact.findMany({ where: { taskId } })) track("artifact", a.id);
  for (const e of await db.event.findMany({ where: { taskId } })) track("event", e.id);
}

async function freshIds(suffix: string, repoDir: string) {
  const project = await createProject({ name: uniqueName(`run-manual-${suffix}`) });
  track("project", project.id);
  const repository = await createRepository({ projectId: project.id, name: "main", localPath: repoDir });
  track("repository", repository.id);
  const feature = await createFeature({ projectId: project.id, title: `feat-${suffix}` });
  track("feature", feature.id);
  return { project, repository, feature };
}

describe("worker execution contract", () => {
  it("rejects malformed runtime input", async () => {
    const provider = new FakeWorkerProvider();
    await expect(executeTask({ taskId: "", workerId: "w", expectedBaseCommit: "abc1234" }, provider)).rejects.toThrow(
      ZodError,
    );
    await expect(
      executeTask({ taskId: "t", workerId: "w", expectedBaseCommit: "not-a-sha!!" }, provider),
    ).rejects.toThrow(ZodError);
  });

  it("rejects unknown task and worker identities", async () => {
    const provider = new FakeWorkerProvider();
    await expect(
      executeTask({ taskId: "missing", workerId: "missing", expectedBaseCommit: "abc1234" }, provider),
    ).rejects.toThrow(NotFoundError);
  });

  it("turns malformed provider output into a structured failure", async () => {
    const repoDir = await initTempRepo();
    const ctx = await setupExecution("badout", repoDir, [{ resource: "src/a.ts", access: "WRITE" }]);
    const bad: WorkerProvider = { execute: async () => ({ garbage: true }) };
    const result = await executeTask(
      { taskId: ctx.task.id, workerId: ctx.worker.id, expectedBaseCommit: ctx.baseCommit },
      bad,
    );
    await trackExecutionRecords(ctx.task.id);
    expect(result.status).toBe("FAILED");
    expect(result.error ?? "").toMatch(/malformed output/);
    expect((await db.worker.findUniqueOrThrow({ where: { id: ctx.worker.id } })).status).toBe("FAILED");
    expect((await db.task.findUniqueOrThrow({ where: { id: ctx.task.id } })).status).toBe("FAILED");
  });

  it("turns provider exceptions into structured failures with states preserved", async () => {
    const repoDir = await initTempRepo();
    const ctx = await setupExecution("boom", repoDir, [{ resource: "src/a.ts", access: "WRITE" }]);
    const result = await executeTask(
      { taskId: ctx.task.id, workerId: ctx.worker.id, expectedBaseCommit: ctx.baseCommit },
      new FakeWorkerProvider({ failWith: "model exploded" }),
    );
    await trackExecutionRecords(ctx.task.id);
    expect(result.status).toBe("FAILED");
    expect(result.error).toBe("model exploded");
    expect((await db.worker.findUniqueOrThrow({ where: { id: ctx.worker.id } })).status).toBe("FAILED");
    expect((await db.task.findUniqueOrThrow({ where: { id: ctx.task.id } })).status).toBe("FAILED");
  });

  it("requires explicit approval and never treats pending or rejected as authorized", async () => {
    const repoDir = await initTempRepo();
    const pending = await setupExecution("noauth", repoDir, [], { approve: false });
    const pendingResult = await executeTask(
      { taskId: pending.task.id, workerId: pending.worker.id, expectedBaseCommit: pending.baseCommit },
      new FakeWorkerProvider(),
    );
    expect(pendingResult.status).toBe("NOT_AUTHORIZED");

    const repoDir2 = await initTempRepo();
    const rejected = await setupExecution("rejauth", repoDir2, [], { approved: false });
    const rejectedResult = await executeTask(
      { taskId: rejected.task.id, workerId: rejected.worker.id, expectedBaseCommit: rejected.baseCommit },
      new FakeWorkerProvider(),
    );
    expect(rejectedResult.status).toBe("NOT_AUTHORIZED");
    // Nothing transitioned: assignment states intact.
    expect((await db.worker.findUniqueOrThrow({ where: { id: rejected.worker.id } })).status).toBe("ASSIGNED");
    expect((await db.task.findUniqueOrThrow({ where: { id: rejected.task.id } })).status).toBe("CLAIMED");
  });
});

describe("worker workspace enforcement", () => {
  it("rejects execution with no linked workspace", async () => {
    const repoDir = await initTempRepo();
    const { feature } = await freshIds("nows", repoDir);
    const pending = await createTask({ featureId: feature.id, title: "lonely" });
    track("task", pending.id);
    const claimed = await transitionTask(pending.id, "READY").then((t) => transitionTask(t.id, "CLAIMED"));
    const worker = await createWorker({ taskId: claimed.id });
    track("worker", worker.id);
    await transitionWorker(worker.id, "ASSIGNED");
    const approval = await createApproval({ taskId: claimed.id });
    track("approval", approval.id);
    await decideApproval(approval.id, { decision: "APPROVED", actor: "tester" });

    const result = await executeTask(
      { taskId: claimed.id, workerId: worker.id, expectedBaseCommit: await getCurrentCommit(repoDir) },
      new FakeWorkerProvider(),
    );
    expect(result.status).toBe("INVALID_WORKSPACE");
  });

  it("rejects missing, swapped, and main worktrees", async () => {
    const repoDir = await initTempRepo();
    const ctx = await setupExecution("wspaths", repoDir, [{ resource: "src/a.ts", access: "WRITE" }]);
    const input = { taskId: ctx.task.id, workerId: ctx.worker.id, expectedBaseCommit: ctx.baseCommit };

    await rm(ctx.workspacePath, { recursive: true, force: true });
    expect((await executeTask(input, new FakeWorkerProvider())).status).toBe("INVALID_WORKSPACE");

    const scratch = await makeTempDir();
    const other = trackTempPath(`${scratch}/other`);
    await mkdir(other, { recursive: true });
    await db.workspace.update({ where: { id: ctx.workspace.id }, data: { path: other } });
    expect((await executeTask(input, new FakeWorkerProvider())).status).toBe("INVALID_WORKSPACE");
  });

  it("rejects the main repository worktree as a worker workspace", async () => {
    const repoDir = await initTempRepo();
    const { feature } = await freshIds("mainws", repoDir);
    const pending = await createTask({ featureId: feature.id, title: "main" });
    track("task", pending.id);
    const claimed = await transitionTask(pending.id, "READY").then((t) => transitionTask(t.id, "CLAIMED"));
    const worker = await createWorker({ taskId: claimed.id });
    track("worker", worker.id);
    await transitionWorker(worker.id, "ASSIGNED");
    const workspace = await db.workspace.create({ data: { workerId: worker.id, path: repoDir, branch: "main" } });
    track("workspace", workspace.id);
    const approval = await createApproval({ taskId: claimed.id });
    track("approval", approval.id);
    await decideApproval(approval.id, { decision: "APPROVED", actor: "tester" });

    const result = await executeTask(
      { taskId: claimed.id, workerId: worker.id, expectedBaseCommit: await getCurrentCommit(repoDir) },
      new FakeWorkerProvider(),
    );
    expect(result.status).toBe("INVALID_WORKSPACE");
    expect(result.error ?? "").toMatch(/main repository worktree/);
  });

  it("rejects branch mismatches between record and worktree", async () => {
    const repoDir = await initTempRepo();
    const ctx = await setupExecution("branchmm", repoDir, [{ resource: "src/a.ts", access: "WRITE" }]);
    await db.workspace.update({ where: { id: ctx.workspace.id }, data: { branch: "some-other-branch" } });
    const result = await executeTask(
      { taskId: ctx.task.id, workerId: ctx.worker.id, expectedBaseCommit: ctx.baseCommit },
      new FakeWorkerProvider(),
    );
    expect(result.status).toBe("INVALID_WORKSPACE");
    expect(result.error ?? "").toMatch(/branch/);
  });

  it("rejects unexpected base commits without transitioning anything", async () => {
    const repoDir = await initTempRepo();
    const ctx = await setupExecution("basemm", repoDir, [{ resource: "src/a.ts", access: "WRITE" }]);
    const result = await executeTask(
      { taskId: ctx.task.id, workerId: ctx.worker.id, expectedBaseCommit: "ab".repeat(20) },
      new FakeWorkerProvider({ files: { "src/a.ts": "x\n" } }),
    );
    expect(result.status).toBe("BASE_COMMIT_MISMATCH");
    expect((await db.worker.findUniqueOrThrow({ where: { id: ctx.worker.id } })).status).toBe("ASSIGNED");
    expect((await db.task.findUniqueOrThrow({ where: { id: ctx.task.id } })).status).toBe("CLAIMED");
  });
});

describe("worker execution lifecycle", () => {
  it("completes declared work with lifecycle, artifact, and audit trail", async () => {
    const repoDir = await initTempRepo();
    const headBefore = await getCurrentCommit(repoDir);
    const ctx = await setupExecution(
      "happy",
      repoDir,
      [{ resource: "src/auth/login.ts", access: "WRITE" }],
      { description: "Add login form" },
    );
    const result = await executeTask(
      { taskId: ctx.task.id, workerId: ctx.worker.id, expectedBaseCommit: ctx.baseCommit },
      new FakeWorkerProvider({ files: { "src/auth/login.ts": "export const login = 1;\n" } }),
    );
    await trackExecutionRecords(ctx.task.id);

    expect(result.status).toBe("COMPLETED");
    expect(result.baseCommit).toBe(headBefore);
    expect(result.finalCommit).toBe(headBefore);
    expect(result.changedResources).toEqual([{ path: "src/auth/login.ts", change: "ADDED" }]);
    expect(result.undeclaredResources).toEqual([]);
    expect(result.providerSummary).toBe("fake work done");
    expect(result.artifacts?.summaryArtifactId).toMatch(/.+/);
    expect(await db.artifact.findUnique({ where: { id: result.artifacts?.summaryArtifactId ?? "missing" } })).not.toBeNull();

    expect((await db.worker.findUniqueOrThrow({ where: { id: ctx.worker.id } })).status).toBe("COMPLETED");
    expect((await db.task.findUniqueOrThrow({ where: { id: ctx.task.id } })).status).toBe("VERIFICATION");
    const started = await db.event.findMany({ where: { taskId: ctx.task.id, type: "TASK_STARTED" } });
    expect(started).toHaveLength(1);

    // Main repository untouched.
    expect(await getCurrentCommit(repoDir)).toBe(headBefore);
    expect(await getCurrentBranch(repoDir)).toBe("main");
    expect(await isClean(repoDir)).toBe(true);
  });

  it("records a new final commit when the provider commits", async () => {
    const repoDir = await initTempRepo();
    const ctx = await setupExecution("commit", repoDir, [{ resource: "src/a.ts", access: "WRITE" }]);
    const result = await executeTask(
      { taskId: ctx.task.id, workerId: ctx.worker.id, expectedBaseCommit: ctx.baseCommit },
      new FakeWorkerProvider({ files: { "src/a.ts": "x\n" }, commitMessage: "fake: add a" }),
    );
    await trackExecutionRecords(ctx.task.id);
    expect(result.status).toBe("COMPLETED");
    expect(result.finalCommit).not.toBe(ctx.baseCommit);
    expect(result.changedResources).toEqual([{ path: "src/a.ts", change: "ADDED" }]);
  });

  it("rejects tasks and workers in non-executable states", async () => {
    const repoDir = await initTempRepo();
    const { feature } = await freshIds("badstate", repoDir);
    const pending = await createTask({ featureId: feature.id, title: "idle" });
    track("task", pending.id);
    const worker = await createWorker({});
    track("worker", worker.id);
    const approval = await createApproval({ taskId: pending.id });
    track("approval", approval.id);
    await decideApproval(approval.id, { decision: "APPROVED", actor: "tester" });

    const idle = await executeTask(
      { taskId: pending.id, workerId: worker.id, expectedBaseCommit: await getCurrentCommit(repoDir) },
      new FakeWorkerProvider(),
    );
    expect(idle.status).toBe("FAILED");
    expect((await db.task.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe("PENDING");
  });

  it("allows exactly one concurrent execution per task", async () => {
    const repoDir = await initTempRepo();
    const ctx = await setupExecution("race", repoDir, [{ resource: "src/a.ts", access: "WRITE" }]);
    const input = { taskId: ctx.task.id, workerId: ctx.worker.id, expectedBaseCommit: ctx.baseCommit };
    const slow = new FakeWorkerProvider({ files: { "src/a.ts": "x\n" }, delayMs: 300 });
    const [first, second] = await Promise.all([executeTask(input, slow), executeTask(input, slow)]);
    await trackExecutionRecords(ctx.task.id);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual(["COMPLETED", "FAILED"]);
    expect(await db.event.count({ where: { taskId: ctx.task.id, type: "TASK_STARTED" } })).toBe(1);
  });

  it("rejects repeated execution after completion and after failure", async () => {
    const repoDir = await initTempRepo();
    const done = await setupExecution("repeat", repoDir, [{ resource: "src/a.ts", access: "WRITE" }]);
    const first = await executeTask(
      { taskId: done.task.id, workerId: done.worker.id, expectedBaseCommit: done.baseCommit },
      new FakeWorkerProvider({ files: { "src/a.ts": "x\n" } }),
    );
    await trackExecutionRecords(done.task.id);
    expect(first.status).toBe("COMPLETED");
    const again = await executeTask(
      { taskId: done.task.id, workerId: done.worker.id, expectedBaseCommit: done.baseCommit },
      new FakeWorkerProvider(),
    );
    expect(again.status).toBe("FAILED");

    const repoDir2 = await initTempRepo();
    const failed = await setupExecution("repeatfail", repoDir2, [{ resource: "src/a.ts", access: "WRITE" }]);
    const failure = await executeTask(
      { taskId: failed.task.id, workerId: failed.worker.id, expectedBaseCommit: failed.baseCommit },
      new FakeWorkerProvider({ failWith: "boom" }),
    );
    await trackExecutionRecords(failed.task.id);
    expect(failure.status).toBe("FAILED");
    const retry = await executeTask(
      { taskId: failed.task.id, workerId: failed.worker.id, expectedBaseCommit: failed.baseCommit },
      new FakeWorkerProvider(),
    );
    // A failed task is never silently resurrected into success.
    expect(retry.status).toBe("FAILED");
    expect(retry.status).not.toBe("COMPLETED");
  });

  it("rejects execution for a worker already running another task", async () => {
    const repoDir = await initTempRepo();
    const ctx = await setupExecution("running", repoDir, [{ resource: "src/a.ts", access: "WRITE" }]);
    // Simulate an execution already in flight started elsewhere.
    await transitionWorker(ctx.worker.id, "RUNNING");
    await transitionTask(ctx.task.id, "IN_PROGRESS");
    const result = await executeTask(
      { taskId: ctx.task.id, workerId: ctx.worker.id, expectedBaseCommit: ctx.baseCommit },
      new FakeWorkerProvider(),
    );
    expect(result.status).toBe("FAILED");
  });
});

async function commitFixtureFile(repoDir: string, rel: string, content: string): Promise<void> {
  const absolute = join(repoDir, rel);
  await mkdir(join(absolute, ".."), { recursive: true });
  await writeFile(absolute, content);
  await runGit(["add", "-A"], { cwd: repoDir });
  await runGit(["-c", "commit.gpgsign=false", "commit", "-m", `fixture ${rel}`], { cwd: repoDir });
}

describe("worker claim enforcement", () => {
  it("completes a no-op execution with no changes", async () => {
    const repoDir = await initTempRepo();
    const ctx = await setupExecution("noop", repoDir, []);
    const result = await executeTask(
      { taskId: ctx.task.id, workerId: ctx.worker.id, expectedBaseCommit: ctx.baseCommit },
      new FakeWorkerProvider(),
    );
    await trackExecutionRecords(ctx.task.id);
    // M19.4 Policy 3: valid hygiene with no effective diff is COMPLETED_EMPTY.
    expect(result.status).toBe("COMPLETED_EMPTY");
    expect(result.changedResources).toEqual([]);
    expect(result.undeclaredResources).toEqual([]);
  });

  it("allows a directory WRITE claim to cover child files", async () => {
    const repoDir = await initTempRepo();
    const ctx = await setupExecution("dircover", repoDir, [{ resource: "src/auth/", access: "WRITE" }]);
    const result = await executeTask(
      { taskId: ctx.task.id, workerId: ctx.worker.id, expectedBaseCommit: ctx.baseCommit },
      new FakeWorkerProvider({ files: { "src/auth/login.ts": "a\n", "src/auth/session.ts": "b\n" } }),
    );
    await trackExecutionRecords(ctx.task.id);
    expect(result.status).toBe("COMPLETED");
    expect(result.undeclaredResources).toEqual([]);
    expect(result.changedResources.map((c) => c.path).sort()).toEqual(["src/auth/login.ts", "src/auth/session.ts"]);
  });

  it("completes when multiple declared files change", async () => {
    const repoDir = await initTempRepo();
    const ctx = await setupExecution("multi", repoDir, [
      { resource: "src/a.ts", access: "WRITE" },
      { resource: "src/b.ts", access: "WRITE" },
    ]);
    const result = await executeTask(
      { taskId: ctx.task.id, workerId: ctx.worker.id, expectedBaseCommit: ctx.baseCommit },
      new FakeWorkerProvider({ files: { "src/a.ts": "a\n", "src/b.ts": "b\n" } }),
    );
    await trackExecutionRecords(ctx.task.id);
    expect(result.status).toBe("COMPLETED");
  });

  it("flags an undeclared file modification as a violation, never success", async () => {
    const repoDir = await initTempRepo();
    const ctx = await setupExecution("evil", repoDir, [{ resource: "src/a.ts", access: "WRITE" }]);
    const result = await executeTask(
      { taskId: ctx.task.id, workerId: ctx.worker.id, expectedBaseCommit: ctx.baseCommit },
      new FakeWorkerProvider({ files: { "src/a.ts": "ok\n", "src/evil.ts": "bad\n" }, summary: "all good" }),
    );
    await trackExecutionRecords(ctx.task.id);
    expect(result.status).toBe("CLAIM_VIOLATION");
    expect(result.undeclaredResources).toEqual(["src/evil.ts"]);
    expect((await db.worker.findUniqueOrThrow({ where: { id: ctx.worker.id } })).status).toBe("FAILED");
    expect((await db.task.findUniqueOrThrow({ where: { id: ctx.task.id } })).status).toBe("FAILED");
  });

  it("flags undeclared nested and unrelated modifications", async () => {
    const repoDir = await initTempRepo();
    const ctx = await setupExecution("nested", repoDir, [{ resource: "src/a.ts", access: "WRITE" }]);
    const result = await executeTask(
      { taskId: ctx.task.id, workerId: ctx.worker.id, expectedBaseCommit: ctx.baseCommit },
      new FakeWorkerProvider({ files: { "src/other/deep/file.ts": "x\n", "README.md": "# changed\n" } }),
    );
    await trackExecutionRecords(ctx.task.id);
    expect(result.status).toBe("CLAIM_VIOLATION");
    expect(result.undeclaredResources).toEqual(["README.md", "src/other/deep/file.ts"]);
  });

  it("allows declared added files and flags undeclared ones", async () => {
    const repoDir = await initTempRepo();
    const declared = await setupExecution("addok", repoDir, [{ resource: "src/new-feature.ts", access: "WRITE" }]);
    const ok = await executeTask(
      { taskId: declared.task.id, workerId: declared.worker.id, expectedBaseCommit: declared.baseCommit },
      new FakeWorkerProvider({ files: { "src/new-feature.ts": "new\n" } }),
    );
    await trackExecutionRecords(declared.task.id);
    expect(ok.status).toBe("COMPLETED");
    expect(ok.changedResources).toEqual([{ path: "src/new-feature.ts", change: "ADDED" }]);

    const repoDir2 = await initTempRepo();
    const sneaky = await setupExecution("addbad", repoDir2, [{ resource: "src/a.ts", access: "WRITE" }]);
    const bad = await executeTask(
      { taskId: sneaky.task.id, workerId: sneaky.worker.id, expectedBaseCommit: sneaky.baseCommit },
      new FakeWorkerProvider({ files: { "src/surprise.ts": "new\n" } }),
    );
    await trackExecutionRecords(sneaky.task.id);
    expect(bad.status).toBe("CLAIM_VIOLATION");
    expect(bad.undeclaredResources).toEqual(["src/surprise.ts"]);
  });

  it("allows declared deletions and flags undeclared deletions", async () => {
    const repoDir = await initTempRepo();
    await commitFixtureFile(repoDir, "src/gone.ts", "bye\n");
    const declared = await setupExecution("delok", repoDir, [{ resource: "src/gone.ts", access: "WRITE" }]);
    const ok = await executeTask(
      { taskId: declared.task.id, workerId: declared.worker.id, expectedBaseCommit: declared.baseCommit },
      new FakeWorkerProvider({ files: { "src/gone.ts": null } }),
    );
    await trackExecutionRecords(declared.task.id);
    expect(ok.status).toBe("COMPLETED");
    expect(ok.changedResources).toEqual([{ path: "src/gone.ts", change: "DELETED" }]);

    const repoDir2 = await initTempRepo();
    await commitFixtureFile(repoDir2, "src/keep.ts", "keep\n");
    const sneaky = await setupExecution("delbad", repoDir2, [{ resource: "src/a.ts", access: "WRITE" }]);
    const bad = await executeTask(
      { taskId: sneaky.task.id, workerId: sneaky.worker.id, expectedBaseCommit: sneaky.baseCommit },
      new FakeWorkerProvider({ files: { "src/keep.ts": null } }),
    );
    await trackExecutionRecords(sneaky.task.id);
    expect(bad.status).toBe("CLAIM_VIOLATION");
    expect(bad.undeclaredResources).toEqual(["src/keep.ts"]);
  });

  it("handles renames through both paths under directory coverage", async () => {
    const repoDir = await initTempRepo();
    await commitFixtureFile(repoDir, "src/old.ts", "same\n");
    const ctx = await setupExecution("rename", repoDir, [{ resource: "src/", access: "WRITE" }]);
    const result = await executeTask(
      { taskId: ctx.task.id, workerId: ctx.worker.id, expectedBaseCommit: ctx.baseCommit },
      new FakeWorkerProvider({ files: { "src/old.ts": { renameTo: "src/new.ts" } } }),
    );
    await trackExecutionRecords(ctx.task.id);
    expect(result.status).toBe("COMPLETED");
    expect(result.changedResources.map((c) => c.path).sort()).toEqual(["src/new.ts", "src/old.ts"]);
  });

  it("flags a rename whose new path is outside declared claims", async () => {
    const repoDir = await initTempRepo();
    await commitFixtureFile(repoDir, "src/old.ts", "same\n");
    const ctx = await setupExecution("renamebad", repoDir, [{ resource: "src/old.ts", access: "WRITE" }]);
    const result = await executeTask(
      { taskId: ctx.task.id, workerId: ctx.worker.id, expectedBaseCommit: ctx.baseCommit },
      new FakeWorkerProvider({ files: { "src/old.ts": { renameTo: "src/new.ts" } } }),
    );
    await trackExecutionRecords(ctx.task.id);
    expect(result.status).toBe("CLAIM_VIOLATION");
    expect(result.undeclaredResources).toEqual(["src/new.ts"]);
  });

  it("does not let READ claims authorize writes", async () => {
    const repoDir = await initTempRepo();
    await commitFixtureFile(repoDir, "src/a.ts", "orig\n");
    const ctx = await setupExecution("readonly", repoDir, [{ resource: "src/a.ts", access: "READ" }]);
    const result = await executeTask(
      { taskId: ctx.task.id, workerId: ctx.worker.id, expectedBaseCommit: ctx.baseCommit },
      new FakeWorkerProvider({ files: { "src/a.ts": "changed\n" } }),
    );
    await trackExecutionRecords(ctx.task.id);
    expect(result.status).toBe("CLAIM_VIOLATION");
    expect(result.undeclaredResources).toEqual(["src/a.ts"]);
  });
});

describe("worker provider boundary", () => {
  it("ignores provider-chosen paths and reports only the assigned workspace", async () => {
    const repoDir = await initTempRepo();
    const ctx = await setupExecution("decoy", repoDir, [{ resource: "src/a.ts", access: "WRITE" }]);
    const scratch = await makeTempDir();
    const decoy = trackTempPath(`${scratch}/decoy`);
    const sneaky: WorkerProvider = {
      execute: async (input) => {
        await mkdir(decoy, { recursive: true });
        await writeFile(join(decoy, "evil.ts"), "outside\n");
        expect(input.workspacePath).toBe(ctx.workspacePath);
        return { summary: "all good" };
      },
    };
    const result = await executeTask(
      { taskId: ctx.task.id, workerId: ctx.worker.id, expectedBaseCommit: ctx.baseCommit },
      sneaky,
    );
    await trackExecutionRecords(ctx.task.id);
    // M19.4 Policy 3: nothing changed in the worktree, so the valid run is
    // COMPLETED_EMPTY; isolation assertions below are unaffected.
    expect(result.status).toBe("COMPLETED_EMPTY");
    expect(result.changedResources).toEqual([]);
    expect(result.workspaceId).toBe(ctx.workspace.id);
    expect(await isClean(ctx.workspacePath)).toBe(true);
  });

  it("rejects smuggled identity and claim fields in provider output", async () => {
    const smuggledOutputs = [
      { summary: "x", taskId: "evil-task" },
      { summary: "x", workspacePath: "/evil" },
      { summary: "x", claims: [{ resource: "everything", access: "WRITE" }] },
    ];
    let index = 0;
    for (const smuggled of smuggledOutputs) {
      index += 1;
      const repoDir = await initTempRepo();
      const ctx = await setupExecution(`smuggle-${index}`, repoDir, [{ resource: "src/a.ts", access: "WRITE" }]);
      const provider: WorkerProvider = { execute: async () => smuggled };
      const result = await executeTask(
        { taskId: ctx.task.id, workerId: ctx.worker.id, expectedBaseCommit: ctx.baseCommit },
        provider,
      );
      expect(result.status).toBe("FAILED");
      expect(result.error ?? "").toMatch(/malformed output/);
      await trackExecutionRecords(ctx.task.id);
    }
  });

  it("never forwards secrets or host environment into provider input", async () => {
    const repoDir = await initTempRepo();
    const ctx = await setupExecution("secrets", repoDir, [{ resource: "src/a.ts", access: "WRITE" }], {
      description: "secret-free task",
    });
    let seen: unknown;
    const spy: WorkerProvider = {
      execute: async (input: WorkerExecutionInput) => {
        seen = input;
        return { summary: "ok" };
      },
    };
    const result = await executeTask(
      { taskId: ctx.task.id, workerId: ctx.worker.id, expectedBaseCommit: ctx.baseCommit },
      spy,
    );
    await trackExecutionRecords(ctx.task.id);
    // M19.4 Policy 3: the spy changes nothing, so the valid run is
    // COMPLETED_EMPTY; input-shape assertions below are unaffected.
    expect(result.status).toBe("COMPLETED_EMPTY");
    const record = seen as Record<string, unknown>;
    const allowed = new Set([
      "taskId",
      "workerId",
      "workspacePath",
      "taskTitle",
      "taskDescription",
      "resourceClaims",
      "repositoryCommit",
      "relevantContext",
    ]);
    for (const key of Object.keys(record)) {
      expect(allowed.has(key)).toBe(true);
    }
    const serialized = JSON.stringify(seen);
    for (const secret of ["DATABASE_URL", "PRIVATE_KEY", "SECRET", "TOKEN", "PASSWORD"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("never lets provider success override a claim violation, nor fabricates test evidence", async () => {
    const repoDir = await initTempRepo();
    const ctx = await setupExecution("boast", repoDir, [{ resource: "src/a.ts", access: "WRITE" }]);
    const boastful: WorkerProvider = {
      execute: async (input: WorkerExecutionInput) => {
        await mkdir(join(input.workspacePath, "src"), { recursive: true });
        await writeFile(join(input.workspacePath, "src", "undeclared.ts"), "x\n");
        return { summary: "perfect success", testsPassed: true };
      },
    };
    const result = await executeTask(
      { taskId: ctx.task.id, workerId: ctx.worker.id, expectedBaseCommit: ctx.baseCommit },
      boastful,
    );
    await trackExecutionRecords(ctx.task.id);
    expect(result.status).toBe("CLAIM_VIOLATION");
    expect(result.status).not.toBe("COMPLETED");
    // Provider test self-reports are never persisted as verification evidence.
    expect(await db.testRun.count({ where: { taskId: ctx.task.id } })).toBe(0);
  });
});

describe("planner to runtime integration", () => {
  it("flows from validated proposal through scheduling, approval, assignment, and execution", async () => {
    const repoDir = await initTempRepo();
    const headBefore = await getCurrentCommit(repoDir);
    const project = await createProject({ name: uniqueName("run-e2e-proj") });
    track("project", project.id);
    const repository = await createRepository({ projectId: project.id, name: "main", localPath: repoDir });
    track("repository", repository.id);
    const feature = await createFeature({ projectId: project.id, title: "widget feature" });
    track("feature", feature.id);

    const validated = await runPlanner(
      { featureId: feature.id, title: "Widget", description: "Build it" },
      new FakePlannerProvider({
        featureId: feature.id,
        tasks: [
          {
            id: "plan-t1",
            title: "Add widget",
            description: "Build the widget",
            claims: [{ resource: "src/widget.ts", access: "WRITE" }],
          },
        ],
        dependencies: [],
      }),
    );
    expect(validated.kind).toBe("ValidatedPlannerPlan");

    // Persist the validated plan as Atlas tasks (the future persist step, explicit here).
    const dbTasks = [];
    for (const planned of validated.tasks) {
      const created = await createTask({
        featureId: feature.id,
        title: planned.title,
        ...(planned.description !== undefined ? { description: planned.description } : {}),
      });
      track("task", created.id);
      await createTaskClaims({
        taskId: created.id,
        claims: planned.claims.map((claim) => ({ resource: claim.resourceId, access: claim.access })),
      });
      dbTasks.push(await transitionTask(created.id, "READY"));
    }

    // M6 remains the authority for scheduling.
    const workerRow = await createWorker({});
    track("worker", workerRow.id);
    const scheduledTasks = [];
    for (const t of dbTasks) {
      scheduledTasks.push({ id: t.id, status: t.status, claims: await getTaskClaims(t.id) });
    }
    const executionPlan = planSchedule({
      tasks: scheduledTasks,
      dependencies: [],
      workers: [{ id: workerRow.id, status: "IDLE" }],
      maxConcurrency: 2,
    });
    expect(executionPlan.groups).toHaveLength(1);

    // Human approval, then assignment, then execution.
    const target = dbTasks[0];
    if (target === undefined) {
      throw new Error("expected a planned task");
    }
    const approval = await createApproval({ taskId: target.id });
    track("approval", approval.id);
    await decideApproval(approval.id, { decision: "APPROVED", actor: "tester" });

    const scratch = await makeTempDir();
    const workspaceRoot = trackTempPath(`${scratch}/wsroot`);
    const assignment = await assignTaskToWorker({
      taskId: target.id,
      workerId: workerRow.id,
      repositoryId: repository.id,
      workspaceRoot,
    });
    track("workspace", assignment.workspace.id);

    const result = await executeTask(
      { taskId: target.id, workerId: workerRow.id, expectedBaseCommit: assignment.worktree.commit },
      new FakeWorkerProvider({ files: { "src/widget.ts": "export const widget = 1;\n" } }),
    );
    await trackExecutionRecords(target.id);
    expect(result.status).toBe("COMPLETED");
    expect(result.undeclaredResources).toEqual([]);
    expect(result.artifacts?.summaryArtifactId).toMatch(/.+/);
    expect(await getCurrentCommit(repoDir)).toBe(headBefore);
    expect(await getCurrentBranch(repoDir)).toBe("main");
  });
});

describe("empty-diff completion policy (M19.4 Policy 3)", () => {
  it("returns COMPLETED_EMPTY for valid execution with no effective diff", async () => {
    const repoDir = await initTempRepo();
    const ctx = await setupExecution("empty", repoDir, [{ resource: "src/a.txt", access: "WRITE" }]);
    const result = await executeTask(
      { taskId: ctx.task.id, workerId: ctx.worker.id, expectedBaseCommit: ctx.baseCommit },
      new FakeWorkerProvider({}),
    );
    await trackExecutionRecords(ctx.task.id);

    expect(result.status).toBe("COMPLETED_EMPTY");
    expect(result.changedResources).toEqual([]);
    expect(result.undeclaredResources).toEqual([]);
    expect(result.error).toBeUndefined();
    // Hygiene valid: the worker completed its assignment; the task carries
    // the distinct empty outcome instead of ordinary success.
    expect((await db.worker.findUniqueOrThrow({ where: { id: ctx.worker.id } })).status).toBe("COMPLETED");
    expect((await db.task.findUniqueOrThrow({ where: { id: ctx.task.id } })).status).toBe("COMPLETED_EMPTY");
    expect(await getCurrentCommit(repoDir)).toBe(ctx.baseCommit);
  });

  it("returns existing COMPLETED for valid execution with a non-empty diff", async () => {
    const repoDir = await initTempRepo();
    const ctx = await setupExecution("nonempty", repoDir, [{ resource: "src/a.txt", access: "WRITE" }]);
    const result = await executeTask(
      { taskId: ctx.task.id, workerId: ctx.worker.id, expectedBaseCommit: ctx.baseCommit },
      new FakeWorkerProvider({ files: { "src/a.txt": "x\n" } }),
    );
    await trackExecutionRecords(ctx.task.id);

    expect(result.status).toBe("COMPLETED");
    expect(result.changedResources).toEqual([{ path: "src/a.txt", change: "ADDED" }]);
    expect((await db.task.findUniqueOrThrow({ where: { id: ctx.task.id } })).status).toBe("VERIFICATION");
  });

  it("propagates structured provider failures and persists the evidence (M20.3)", async () => {
    const repoDir = await initTempRepo();
    const ctx = await setupExecution("proberror", repoDir, [{ resource: "src/a.txt", access: "WRITE" }]);
    const throwing = {
      execute: async (): Promise<unknown> => {
        throw new CommandFailureError("RATE_LIMIT", {
          executable: "opencode",
          message: "command-worker: command failed: command exited with code 1: Rate limit exceeded",
        });
      },
    };
    const result = await executeTask(
      { taskId: ctx.task.id, workerId: ctx.worker.id, expectedBaseCommit: ctx.baseCommit },
      throwing,
    );
    await trackExecutionRecords(ctx.task.id);

    expect(result.status).toBe("FAILED");
    expect(result.errorCode).toBe("RATE_LIMIT");
    // Persisted TASK_FAILED event carries code, summary, and phase for later reads.
    const rows = await db.event.findMany({ where: { taskId: ctx.task.id, type: "TASK_FAILED" } });
    expect(rows).toHaveLength(1);
    const payload = JSON.parse((rows[0]?.payload ?? "{}") as string) as Record<string, unknown>;
    expect(payload["errorCode"]).toBe("RATE_LIMIT");
    expect(payload["phase"]).toBe("worker-execution");
    expect(payload["error"]).toContain("Rate limit exceeded");
    expect(payload["workerId"]).toBe(ctx.worker.id);
    // Read back through a fresh query path, as diagnose does.
    const reread = await db.event.findMany({ where: { taskId: ctx.task.id, type: "TASK_FAILED" } });
    expect(reread).toHaveLength(1);
  });

  it("keeps invalid behavior unchanged (FAILED, never COMPLETED_EMPTY)", async () => {
    const repoDir = await initTempRepo();
    const ctx = await setupExecution("stillbad", repoDir, [{ resource: "src/a.txt", access: "WRITE" }]);
    const result = await executeTask(
      { taskId: ctx.task.id, workerId: ctx.worker.id, expectedBaseCommit: ctx.baseCommit },
      new FakeWorkerProvider({ failWith: "model exploded" }),
    );
    await trackExecutionRecords(ctx.task.id);

    expect(result.status).toBe("FAILED");
    expect((await db.task.findUniqueOrThrow({ where: { id: ctx.task.id } })).status).toBe("FAILED");
  });
});
