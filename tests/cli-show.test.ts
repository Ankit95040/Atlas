import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getPrismaClient } from "../src/db/client.js";
import {
  createFeature,
  createProject,
  createRepository,
  createTask,
  transitionTask,
} from "../src/core/service.js";
import { createTaskClaims } from "../src/claims/index.js";
import { runFeatureWaveLoop } from "../src/orchestrator/index.js";
import { FakeWorkerProvider } from "../src/workers/index.js";
import { createProgram } from "../src/cli/index.js";
import {
  runClaimsCommand,
  runDiagnoseCommand,
  runHistoryCommand,
  runShowRunCommand,
  runShowTaskCommand,
  runShowWorkerCommand,
  runStatusCommand,
} from "../src/cli/show.js";
import { track, uniqueName } from "./domain-helpers.js";
import { initTempRepo, makeTempDir } from "./git-helpers.js";

const db = getPrismaClient();

async function setupShowcase(suffix: string) {
  const repoDir = await initTempRepo();
  const { getCurrentCommit } = await import("../src/git/index.js");
  const baseCommit = await getCurrentCommit(repoDir);
  const project = await createProject({ name: uniqueName(`show-proj-${suffix}`) });
  track("project", project.id);
  const repository = await createRepository({ projectId: project.id, name: "main", localPath: repoDir });
  track("repository", repository.id);
  const feature = await createFeature({ projectId: project.id, title: `show-feat-${suffix}` });
  track("feature", feature.id);
  const defs = [
    { key: "ok", claims: [{ resource: "src/ok.txt", access: "WRITE" }] },
    { key: "bad", claims: [{ resource: "src/bad.txt", access: "WRITE" }] },
    { key: "empty", claims: [{ resource: "src/empty.txt", access: "WRITE" }] },
  ] as const;
  const taskIds: string[] = [];
  for (const def of defs) {
    const task = await createTask({ featureId: feature.id, title: def.key });
    track("task", task.id);
    await transitionTask(task.id, "READY", db);
    await createTaskClaims({ taskId: task.id, claims: def.claims.map((c) => ({ ...c })) });
    taskIds.push(task.id);
  }
  const scratchRoot = await makeTempDir();
  const byKey = new Map(["ok", "bad", "empty"].map((k, i) => [taskIds[i] as string, k]));
  const result = await runFeatureWaveLoop(
    {
      featureId: feature.id,
      repositoryId: repository.id,
      baseCommit,
      workspaceRoot: scratchRoot,
      trainBranch: `atlas/show/${uniqueName("train")}`,
      trainPath: join(scratchRoot, "train"),
      approvalActor: "show-test",
      testCommand: [process.execPath, "--eval", "process.exit(0);"],
      maxConcurrency: 4,
    },
    {
      createProvider: (taskId: string) => {
        const key = byKey.get(taskId);
        if (key === "bad") {
          return new FakeWorkerProvider({ failWith: "boom" });
        }
        if (key === "empty") {
          return new FakeWorkerProvider({});
        }
        return new FakeWorkerProvider({ files: { "src/ok.txt": "ok\n" }, commitMessage: "fake ok" });
      },
      track,
    },
    db,
  );
  for (const row of await db.event.findMany({ where: { featureId: feature.id }, select: { id: true } })) {
    track("event", row.id);
  }
  return { feature, taskIds, byKey, result, repositoryId: repository.id };
}

function stableJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

describe("read-only CLI (M19.5)", () => {
  it("registers status/show/history/claims/diagnose commands", () => {
    const program = createProgram();
    const names = program.commands.map((c) => c.name());
    for (const name of ["status", "show", "history", "claims", "diagnose", "run", "plan", "doctor"]) {
      expect(names).toContain(name);
    }
    const show = program.commands.find((c) => c.name() === "show");
    expect(show?.commands.map((c) => c.name()).sort()).toEqual(["run", "task", "worker"]);
  });

  it("status summarizes states and recent failures", async () => {
    await setupShowcase("status");
    const output = await runStatusCommand({}, db);
    expect(output.exitCode).toBe(0);
    expect(output.human).toContain("atlas status");
    expect(output.human).toContain("FAILED");
    expect(stableJson(output.data)).toEqual(output.data);
  });

  it("show run/task/worker expose the recorded evidence", async () => {
    const setup = await setupShowcase("show");
    const run = await runShowRunCommand({ runId: setup.feature.id }, db);
    expect(run.human).toContain("atlas show run");
    expect(run.human).toContain("failed tasks");
    expect(stableJson(run.data)).toEqual(run.data);

    for (const taskId of setup.taskIds) {
      const shown = await runShowTaskCommand({ taskId }, db);
      expect(shown.human).toContain(taskId);
      expect(stableJson(shown.data)).toEqual(shown.data);
    }
    // M23.1: links are released at INTEGRATED, so resolve the worker through
    // event history (same historical rule the CLI itself uses).
    const assigned = await db.event.findFirstOrThrow({ where: { taskId: setup.taskIds[0], type: "WORKER_ASSIGNED" } });
    const workerId = (JSON.parse(assigned.payload ?? "{}") as { workerId: string }).workerId;
    const worker = await db.worker.findUniqueOrThrow({ where: { id: workerId } });
    const shownWorker = await runShowWorkerCommand({ workerId: worker.id }, db);
    expect(shownWorker.human).toContain(worker.id);
    expect(stableJson(shownWorker.data)).toEqual(shownWorker.data);

    await expect(runShowTaskCommand({ taskId: "no-such-task" }, db)).rejects.toThrow(/unknown task/);
    await expect(runShowRunCommand({ runId: "no-such-feature" }, db)).rejects.toThrow(/unknown run scope/);
  });

  it("history returns chronological lifecycle events", async () => {
    const setup = await setupShowcase("history");
    const output = await runHistoryCommand({ runId: setup.feature.id }, db);
    const types = (output.data as { events: Array<{ type: string }> }).events.map((e) => e.type);
    // Setup-created tasks come first; the workflow opens before any wave work.
    expect(types.indexOf("WORKFLOW_STARTED")).toBeLessThan(types.indexOf("TASK_SCHEDULED"));
    expect(types).toContain("TASK_FAILED");
    expect(types[types.length - 1]).toBe("RUN_COMPLETED");
    expect(stableJson(output.data)).toEqual(output.data);
  });

  it("claims lists overlaps without recomputing repository analysis", async () => {
    const setup = await setupShowcase("claims");
    const output = await runClaimsCommand({ runId: setup.feature.id }, db);
    expect(output.human).toContain("atlas claims");
    const data = output.data as { claims: unknown[]; overlaps: unknown[] };
    expect(data.claims).toHaveLength(3);
    expect(stableJson(output.data)).toEqual(output.data);
  });

  it("diagnose reports persisted rate-limit evidence (M20.3)", async () => {
    const { createWorker, createApproval, decideApproval } = await import("../src/core/service.js");
    const { assignTaskToWorker } = await import("../src/workspaces/index.js");
    const { executeTask, CommandFailureError } = await import("../src/workers/index.js");
    const repoDir = await initTempRepo();
    const { getCurrentCommit } = await import("../src/git/index.js");
    const project = await createProject({ name: uniqueName("show-ratelimit-proj") });
    track("project", project.id);
    const repository = await createRepository({ projectId: project.id, name: "main", localPath: repoDir });
    track("repository", repository.id);
    const feature = await createFeature({ projectId: project.id, title: "show-ratelimit-feat" });
    track("feature", feature.id);
    const pending = await createTask({ featureId: feature.id, title: "limited" });
    track("task", pending.id);
    await transitionTask(pending.id, "READY", db);
    await createTaskClaims({ taskId: pending.id, claims: [{ resource: "src/a.txt", access: "WRITE" }] });
    const worker = await createWorker({});
    track("worker", worker.id);
    const approval = await createApproval({ taskId: pending.id });
    track("approval", approval.id);
    await decideApproval(approval.id, { decision: "APPROVED", actor: "tester" });
    const scratch = await makeTempDir();
    const assignment = await assignTaskToWorker({
      taskId: pending.id,
      workerId: worker.id,
      repositoryId: repository.id,
      workspaceRoot: `${scratch}/wsroot`,
    });
    track("workspace", assignment.workspace.id);
    const throwing = {
      execute: async (): Promise<unknown> => {
        throw new CommandFailureError("RATE_LIMIT", {
          executable: "opencode",
          message: "command-worker: command failed: command exited with code 1: Rate limit exceeded",
        });
      },
    };
    const execution = await executeTask(
      { taskId: pending.id, workerId: worker.id, expectedBaseCommit: assignment.worktree.commit },
      throwing,
    );
    expect(execution.status).toBe("FAILED");
    for (const row of await db.event.findMany({ where: { taskId: pending.id }, select: { id: true } })) {
      track("event", row.id);
    }
    for (const row of await db.artifact.findMany({ where: { taskId: pending.id }, select: { id: true } })) {
      track("artifact", row.id);
    }

    const output = await runDiagnoseCommand({ runId: feature.id }, db);
    const data = output.data as { findings: Array<{ title: string; phase: string; assessment: string; errorCode?: string }> };
    expect(data.findings).toHaveLength(1);
    expect(data.findings[0]?.phase).toBe("worker execution");
    expect(data.findings[0]?.assessment).toContain("rate limit");
    expect(data.findings[0]?.assessment).toContain("no tests executed");
    expect(data.findings[0]?.errorCode).toBe("RATE_LIMIT");
    expect(output.human).toContain("rate limit");
    expect(stableJson(output.data)).toEqual(output.data);
  });

  it("diagnose distinguishes failed, empty, and completed tasks", async () => {
    const setup = await setupShowcase("diagnose");
    const output = await runDiagnoseCommand({ runId: setup.feature.id }, db);
    const data = output.data as { findings: Array<{ title: string; phase: string }> };
    const byTitle = new Map(data.findings.map((f) => [f.title, f.phase]));
    expect(byTitle.get("bad")).toBe("worker execution");
    expect(byTitle.get("empty")).toContain("empty-outcome");
    expect(byTitle.get("ok")).toBe("completed");
    expect(output.human).toContain("summary:");
    expect(stableJson(output.data)).toEqual(output.data);
  });

  it("show task displays recovery eligibility with the recovery command", async () => {
    const { createWorker } = await import("../src/core/service.js");
    const { assignTaskToWorker } = await import("../src/workspaces/index.js");
    const repoDir = await initTempRepo();
    const project = await createProject({ name: uniqueName("show-elig-proj") });
    track("project", project.id);
    const repository = await createRepository({ projectId: project.id, name: "main", localPath: repoDir });
    track("repository", repository.id);
    const feature = await createFeature({ projectId: project.id, title: "show-elig-feat" });
    track("feature", feature.id);
    const pending = await createTask({ featureId: feature.id, title: "stranded" });
    track("task", pending.id);
    await transitionTask(pending.id, "READY", db);
    await createTaskClaims({ taskId: pending.id, claims: [{ resource: "src/a.txt", access: "WRITE" }] });
    const worker = await createWorker({});
    track("worker", worker.id);
    const scratch = await makeTempDir();
    const assignment = await assignTaskToWorker({
      taskId: pending.id,
      workerId: worker.id,
      repositoryId: repository.id,
      workspaceRoot: `${scratch}/wsroot`,
    });
    track("workspace", assignment.workspace.id);

    const output = await runShowTaskCommand({ taskId: pending.id }, db);
    expect(output.human).toContain("SAFE_TO_RECOVER");
    expect(output.human).toContain(`atlas recover task ${pending.id} --actor <actor>`);
    const data = output.data as { recovery: { class: string; reason: string; nextCommand?: string } };
    expect(data.recovery.class).toBe("SAFE_TO_RECOVER");
    expect(data.recovery.nextCommand).toBe(`atlas recover task ${pending.id} --actor <actor>`);
    expect(stableJson(output.data)).toEqual(output.data);
  });

  it("diagnose exposes eligibility and never shows recovery commands for unsafe states", async () => {
    const setup = await setupShowcase("eligibility");
    // Stranded pair alongside completed/failed work.
    const { createWorker } = await import("../src/core/service.js");
    const { assignTaskToWorker } = await import("../src/workspaces/index.js");
    const stranded = await createTask({ featureId: setup.feature.id, title: "stranded" });
    track("task", stranded.id);
    await transitionTask(stranded.id, "READY", db);
    await createTaskClaims({ taskId: stranded.id, claims: [{ resource: "src/s.txt", access: "WRITE" }] });
    const strandedWorker = await createWorker({});
    track("worker", strandedWorker.id);
    const scratch = await makeTempDir();
    const strandedAssignment = await assignTaskToWorker({
      taskId: stranded.id,
      workerId: strandedWorker.id,
      repositoryId: setup.repositoryId,
      workspaceRoot: `${scratch}/wsroot`,
    });
    track("workspace", strandedAssignment.workspace.id);

    const beforeTasks = await db.task.findMany({ where: { featureId: setup.feature.id }, orderBy: { id: "asc" } });
    const beforeEvents = await db.event.count({ where: { featureId: setup.feature.id } });
    const output = await runDiagnoseCommand({ runId: setup.feature.id }, db);
    // Diagnose is read-only: no state moved.
    expect(await db.task.findMany({ where: { featureId: setup.feature.id }, orderBy: { id: "asc" } })).toEqual(
      beforeTasks,
    );
    expect(await db.event.count({ where: { featureId: setup.feature.id } })).toBe(beforeEvents);

    const data = output.data as {
      findings: Array<{ title: string; recovery: { class: string; reason: string; nextCommand?: string } }>;
    };
    const byTitle = new Map(data.findings.map((f) => [f.title, f.recovery]));
    expect(byTitle.get("stranded")?.class).toBe("SAFE_TO_RECOVER");
    expect(byTitle.get("stranded")?.nextCommand).toBe(`atlas recover task ${stranded.id} --actor <actor>`);
    expect(output.human).toContain("SAFE_TO_RECOVER");
    // Terminal tasks expose no recovery command.
    for (const title of ["ok", "bad", "empty"]) {
      expect(byTitle.get(title)?.nextCommand).toBeUndefined();
    }
    expect(stableJson(output.data)).toEqual(output.data);
  });
});
