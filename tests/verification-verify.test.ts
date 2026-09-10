import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
import { getPrismaClient } from "../src/db/client.js";
import { assignTaskToWorker } from "../src/workspaces/index.js";
import { FakeWorkerProvider, executeTask } from "../src/workers/index.js";
import { runTests, verifyExecution } from "../src/verification/index.js";
import { track, uniqueName } from "./domain-helpers.js";
import { initTempRepo, makeTempDir, trackTempPath } from "./git-helpers.js";

const db = getPrismaClient();
const NODE = process.execPath;

interface ClaimInput {
  resource: string;
  access: string;
}

async function setupVerifiedWork(
  suffix: string,
  repoDir: string,
  claims: ClaimInput[],
  files: Record<string, string>,
) {
  const project = await createProject({ name: uniqueName(`verify-proj-${suffix}`) });
  track("project", project.id);
  const repository = await createRepository({ projectId: project.id, name: "main", localPath: repoDir });
  track("repository", repository.id);
  const feature = await createFeature({ projectId: project.id, title: `feat-${suffix}` });
  track("feature", feature.id);
  const pending = await createTask({ featureId: feature.id, title: `task-${suffix}` });
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
    repositoryId: repository.id,
    workspaceRoot: trackTempPath(`${scratch}/wsroot`),
  });
  track("workspace", assignment.workspace.id);
  for (const e of await db.event.findMany({ where: { taskId: ready.id } })) track("event", e.id);

  const execution = await executeTask(
    { taskId: ready.id, workerId: worker.id, expectedBaseCommit: assignment.worktree.commit },
    new FakeWorkerProvider({ files, commitMessage: "fake: implement" }),
  );
  if (execution.status !== "COMPLETED") {
    throw new Error(`fixture execution failed: ${execution.status} ${execution.error ?? ""}`);
  }
  for (const a of await db.artifact.findMany({ where: { taskId: ready.id } })) track("artifact", a.id);
  for (const e of await db.event.findMany({ where: { taskId: ready.id } })) track("event", e.id);
  return {
    project,
    repository,
    feature,
    taskId: ready.id,
    workerId: worker.id,
    workspacePath: assignment.workspace.path,
    baseCommit: assignment.worktree.commit,
  };
}

async function trackVerificationRecords(taskId: string): Promise<void> {
  for (const a of await db.artifact.findMany({ where: { taskId } })) track("artifact", a.id);
  for (const e of await db.event.findMany({ where: { taskId } })) track("event", e.id);
  for (const t of await db.testRun.findMany({ where: { taskId } })) track("testRun", t.id);
}

describe("execution verification", () => {
  it("verifies clean completed work with all checks passing", async () => {
    const repoDir = await initTempRepo();
    const ctx = await setupVerifiedWork("happy", repoDir, [{ resource: "src/a.ts", access: "WRITE" }], {
      "src/a.ts": "export const a = 1;\n",
    });
    const run = await runTests(
      { taskId: ctx.taskId, workdir: ctx.workspacePath, command: [NODE, "--eval", "process.exit(0);"] },
      db,
    );
    track("testRun", run.testRunId);

    const result = await verifyExecution(
      { taskId: ctx.taskId, workerId: ctx.workerId, expectedBaseCommit: ctx.baseCommit, testRunId: run.testRunId },
      db,
    );
    await trackVerificationRecords(ctx.taskId);
    expect(result.verdict).toBe("VERIFIED");
    expect(result.reasons).toEqual([]);
    expect(result.checks.map((check) => [check.name, check.passed])).toEqual([
      ["links-valid", true],
      ["workspace-registered", true],
      ["base-ancestor", true],
      ["claims-hold", true],
      ["tests-passed", true],
    ]);
    expect(result.changedResources).toEqual(["src/a.ts"]);
    expect(result.testRunId).toBe(run.testRunId);
    const artifact = await db.artifact.findUnique({ where: { id: result.artifactId } });
    expect(artifact?.label).toContain("VERIFIED");
  });

  it("catches post-execution tampering outside declared claims", async () => {
    const repoDir = await initTempRepo();
    const ctx = await setupVerifiedWork("tamper", repoDir, [{ resource: "src/a.ts", access: "WRITE" }], {
      "src/a.ts": "export const a = 1;\n",
    });
    const run = await runTests(
      { taskId: ctx.taskId, workdir: ctx.workspacePath, command: [NODE, "--eval", "process.exit(0);"] },
      db,
    );
    track("testRun", run.testRunId);
    // Tamper after execution and testing: an undeclared file appears.
    await writeFile(join(ctx.workspacePath, "src", "evil.ts"), "malicious\n");

    const result = await verifyExecution(
      { taskId: ctx.taskId, workerId: ctx.workerId, expectedBaseCommit: ctx.baseCommit, testRunId: run.testRunId },
      db,
    );
    await trackVerificationRecords(ctx.taskId);
    expect(result.verdict).toBe("REJECTED");
    expect(result.reasons).toEqual(["CLAIM_VIOLATION"]);
    expect(result.changedResources).toContain("src/evil.ts");
    const artifact = await db.artifact.findUnique({ where: { id: result.artifactId } });
    expect(artifact?.label).toContain("REJECTED");
  });

  it("rejects failed test evidence", async () => {
    const repoDir = await initTempRepo();
    const ctx = await setupVerifiedWork("badtests", repoDir, [{ resource: "src/a.ts", access: "WRITE" }], {
      "src/a.ts": "export const a = 1;\n",
    });
    const run = await runTests(
      { taskId: ctx.taskId, workdir: ctx.workspacePath, command: [NODE, "--eval", "process.exit(2);"] },
      db,
    );
    track("testRun", run.testRunId);
    expect(run.status).toBe("FAILED");

    const result = await verifyExecution(
      { taskId: ctx.taskId, workerId: ctx.workerId, expectedBaseCommit: ctx.baseCommit, testRunId: run.testRunId },
      db,
    );
    await trackVerificationRecords(ctx.taskId);
    expect(result.verdict).toBe("REJECTED");
    expect(result.reasons).toEqual(["TESTS_NOT_PASSED"]);
  });

  it("rejects unknown and foreign test runs", async () => {
    const repoDir = await initTempRepo();
    const ctx = await setupVerifiedWork("foreign", repoDir, [{ resource: "src/a.ts", access: "WRITE" }], {
      "src/a.ts": "export const a = 1;\n",
    });
    await expect(
      verifyExecution({ taskId: ctx.taskId, workerId: ctx.workerId, expectedBaseCommit: ctx.baseCommit, testRunId: "missing" }, db),
    ).rejects.toThrow(NotFoundError);

    const other = await setupVerifiedWork("foreign2", repoDir, [{ resource: "src/b.ts", access: "WRITE" }], {
      "src/b.ts": "export const b = 1;\n",
    });
    const foreign = await runTests(
      { taskId: other.taskId, workdir: other.workspacePath, command: [NODE, "--eval", "process.exit(0);"] },
      db,
    );
    track("testRun", foreign.testRunId);
    const result = await verifyExecution(
      { taskId: ctx.taskId, workerId: ctx.workerId, expectedBaseCommit: ctx.baseCommit, testRunId: foreign.testRunId },
      db,
    );
    await trackVerificationRecords(ctx.taskId);
    await trackVerificationRecords(other.taskId);
    expect(result.verdict).toBe("REJECTED");
    expect(result.reasons).toEqual(["TESTS_NOT_PASSED"]);
  });

  it("rejects work built on the wrong base", async () => {
    const repoDir = await initTempRepo();
    const ctx = await setupVerifiedWork("wrongbase", repoDir, [{ resource: "src/a.ts", access: "WRITE" }], {
      "src/a.ts": "export const a = 1;\n",
    });
    const run = await runTests(
      { taskId: ctx.taskId, workdir: ctx.workspacePath, command: [NODE, "--eval", "process.exit(0);"] },
      db,
    );
    track("testRun", run.testRunId);
    const result = await verifyExecution(
      {
        taskId: ctx.taskId,
        workerId: ctx.workerId,
        expectedBaseCommit: "0".repeat(40),
        testRunId: run.testRunId,
      },
      db,
    );
    await trackVerificationRecords(ctx.taskId);
    expect(result.verdict).toBe("REJECTED");
    expect(result.reasons).toEqual(["BASE_MISMATCH"]);
  });

  it("rejects broken worker links and missing tasks", async () => {
    await expect(
      verifyExecution({ taskId: "missing", workerId: "missing", expectedBaseCommit: "abc1234", testRunId: "missing" }, db),
    ).rejects.toThrow(NotFoundError);

    const repoDir = await initTempRepo();
    const project = await createProject({ name: uniqueName("verify-link") });
    track("project", project.id);
    const feature = await createFeature({ projectId: project.id, title: "feat-link" });
    track("feature", feature.id);
    const task = await createTask({ featureId: feature.id, title: "lonely" });
    track("task", task.id);
    const worker = await createWorker({});
    track("worker", worker.id);
    const run = await runTests({ taskId: task.id, workdir: repoDir, command: [NODE, "--eval", "process.exit(0);"] }, db);
    track("testRun", run.testRunId);
    const result = await verifyExecution(
      { taskId: task.id, workerId: worker.id, expectedBaseCommit: "abc1234", testRunId: run.testRunId },
      db,
    );
    await trackVerificationRecords(task.id);
    expect(result.verdict).toBe("REJECTED");
    expect(result.reasons).toEqual(["LINK_INVALID"]);
  });

  it("rejects a main worktree masquerading as a workspace", async () => {
    const repoDir = await initTempRepo();
    const ctx = await setupVerifiedWork("mainws", repoDir, [{ resource: "src/a.ts", access: "WRITE" }], {
      "src/a.ts": "export const a = 1;\n",
    });
    const run = await runTests(
      { taskId: ctx.taskId, workdir: ctx.workspacePath, command: [NODE, "--eval", "process.exit(0);"] },
      db,
    );
    track("testRun", run.testRunId);
    const linked = await db.worker.findUniqueOrThrow({ where: { id: ctx.workerId }, include: { workspace: true } });
    if (linked.workspace === null) {
      throw new Error("fixture workspace missing");
    }
    await db.workspace.update({ where: { id: linked.workspace.id }, data: { path: repoDir } });
    const result = await verifyExecution(
      { taskId: ctx.taskId, workerId: linked.id, expectedBaseCommit: ctx.baseCommit, testRunId: run.testRunId },
      db,
    );
    await trackVerificationRecords(ctx.taskId);
    expect(result.verdict).toBe("REJECTED");
    expect(result.reasons).toEqual(["WORKSPACE_INVALID"]);
  });

  it("is deterministic across repeated evaluations", async () => {
    const repoDir = await initTempRepo();
    const ctx = await setupVerifiedWork("stable", repoDir, [{ resource: "src/a.ts", access: "WRITE" }], {
      "src/a.ts": "export const a = 1;\n",
    });
    const run = await runTests(
      { taskId: ctx.taskId, workdir: ctx.workspacePath, command: [NODE, "--eval", "process.exit(0);"] },
      db,
    );
    track("testRun", run.testRunId);
    const input = { taskId: ctx.taskId, workerId: ctx.workerId, expectedBaseCommit: ctx.baseCommit, testRunId: run.testRunId };
    const first = await verifyExecution(input, db);
    const second = await verifyExecution(input, db);
    await trackVerificationRecords(ctx.taskId);
    const { artifactId: _a, ...restFirst } = first;
    const { artifactId: _b, ...restSecond } = second;
    expect(restFirst).toEqual(restSecond);
  });
});
