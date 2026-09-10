import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
import { createTaskClaims, getTaskClaims } from "../src/claims/index.js";
import { getCurrentBranch, getCurrentCommit, isClean, runGit } from "../src/git/index.js";
import { planSchedule } from "../src/dag/index.js";
import { FakePlannerProvider, runPlanner } from "../src/planner/index.js";
import { getPrismaClient } from "../src/db/client.js";
import { assignTaskToWorker } from "../src/workspaces/index.js";
import { FakeWorkerProvider, executeTask } from "../src/workers/index.js";
import { runMergeTrain, runTests, verifyExecution } from "../src/verification/index.js";
import { track, uniqueName } from "./domain-helpers.js";
import { initTempRepo, makeTempDir, trackTempPath } from "./git-helpers.js";

const db = getPrismaClient();
const NODE = process.execPath;

describe("planner to merge-train integration", () => {
  it("flows from validated proposal through scheduling, approval, assignment, execution, verification, and train", async () => {
    const repoDir = await initTempRepo();
    await writeFile(join(repoDir, "package.json"), JSON.stringify({ name: "pipe", scripts: { test: "node check.mjs" } }));
    await writeFile(join(repoDir, "check.mjs"), "process.exit(0);\n");
    await runGit(["add", "-A"], { cwd: repoDir });
    await runGit(["-c", "commit.gpgsign=false", "commit", "-m", "add test harness"], { cwd: repoDir });
    const base = await getCurrentCommit(repoDir);

    const project = await createProject({ name: uniqueName("pipe-proj") });
    track("project", project.id);
    const repository = await createRepository({ projectId: project.id, name: "main", localPath: repoDir });
    track("repository", repository.id);
    const feature = await createFeature({ projectId: project.id, title: "widget feature" });
    track("feature", feature.id);

    // Planner proposes; Atlas validates. The AI authorizes nothing.
    const validated = await runPlanner(
      { featureId: feature.id, title: "Widget", description: "Build the widget" },
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

    // Persist the validated plan as Atlas tasks with claims.
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
    const target = dbTasks[0];
    if (target === undefined) {
      throw new Error("expected a planned task");
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
    const approval = await createApproval({ taskId: target.id });
    track("approval", approval.id);
    await decideApproval(approval.id, { decision: "APPROVED", actor: "tester" });

    const scratch = await makeTempDir();
    const assignment = await assignTaskToWorker({
      taskId: target.id,
      workerId: workerRow.id,
      repositoryId: repository.id,
      workspaceRoot: trackTempPath(`${scratch}/wsroot`),
    });
    track("workspace", assignment.workspace.id);
    for (const e of await db.event.findMany({ where: { taskId: target.id } })) track("event", e.id);

    const execution = await executeTask(
      { taskId: target.id, workerId: workerRow.id, expectedBaseCommit: assignment.worktree.commit },
      new FakeWorkerProvider({ files: { "src/widget.ts": "export const widget = 1;\n" }, commitMessage: "fake: widget" }),
    );
    expect(execution.status).toBe("COMPLETED");
    for (const a of await db.artifact.findMany({ where: { taskId: target.id } })) track("artifact", a.id);
    for (const e of await db.event.findMany({ where: { taskId: target.id } })) track("event", e.id);

    // Atlas-executed tests, independent verification, approval-gated train.
    const run = await runTests({ taskId: target.id, workdir: assignment.workspace.path }, db);
    track("testRun", run.testRunId);
    expect(run.status).toBe("PASSED");

    const verdict = await verifyExecution(
      { taskId: target.id, workerId: workerRow.id, expectedBaseCommit: assignment.worktree.commit, testRunId: run.testRunId },
      db,
    );
    for (const a of await db.artifact.findMany({ where: { taskId: target.id } })) track("artifact", a.id);
    expect(verdict.verdict).toBe("VERIFIED");

    const trainApproval = await createApproval({ featureId: feature.id });
    track("approval", trainApproval.id);
    await decideApproval(trainApproval.id, { decision: "APPROVED", actor: "human" });
    const trainScratch = await makeTempDir();
    const train = await runMergeTrain(
      {
        repositoryId: repository.id,
        trainBranch: `atlas/train/${uniqueName("pipe").replace(/[^A-Za-z0-9_-]/g, "")}`,
        trainPath: trackTempPath(`${trainScratch}/train`),
        baseCommit: base,
        approvalId: trainApproval.id,
        items: [
          {
            taskId: target.id,
            workerId: workerRow.id,
            expectedBaseCommit: assignment.worktree.commit,
            testRunId: run.testRunId,
          },
        ],
      },
      db,
    );
    for (const c of await db.commit.findMany({ where: { taskId: target.id } })) track("commit", c.id);
    for (const a of await db.artifact.findMany({ where: { taskId: target.id } })) track("artifact", a.id);
    for (const t of await db.testRun.findMany({ where: { taskId: target.id } })) track("testRun", t.id);
    for (const e of await db.event.findMany({ where: { taskId: target.id } })) track("event", e.id);

    expect(train.status).toBe("COMPLETED");
    expect(train.items).toHaveLength(1);
    expect(train.items[0]?.status).toBe("INTEGRATED");

    // Main line untouched throughout the whole pipeline.
    expect(await getCurrentCommit(repoDir)).toBe(base);
    expect(await getCurrentBranch(repoDir)).toBe("main");
    expect(await isClean(repoDir)).toBe(true);
  });
});
