import { describe, expect, it } from "vitest";
import { getPrismaClient } from "../src/db/client.js";
import {
  createFeature,
  createProject,
  createRepository,
  createTask,
  transitionTask,
} from "../src/core/service.js";
import { createProgram } from "../src/cli/index.js";
import { runInitCommand } from "../src/cli/init.js";
import { runTaskTransitionCommand } from "../src/cli/transition.js";
import { runDiagnoseCommand } from "../src/cli/show.js";
import { track, uniqueName } from "./domain-helpers.js";
import { initTempRepo, makeTempDir } from "./git-helpers.js";

const db = getPrismaClient();

describe("atlas init (M22 blocker 1)", () => {
  it("creates project, repository, and feature rows for a Git checkout", async () => {
    const repoDir = await initTempRepo();
    const output = await runInitCommand(
      {
        name: uniqueName("init-proj"),
        repoPath: repoDir,
        featureTitle: "first feature",
      },
      db,
    );
    const data = output.data as { projectId: string; repositoryId: string; featureId: string; nextCommand: string };
    track("project", data.projectId);
    track("repository", data.repositoryId);
    track("feature", data.featureId);
    expect(output.exitCode).toBe(0);
    expect(output.human).toContain(`atlas plan --feature ${data.featureId}`);
    const repository = await db.repository.findUnique({ where: { id: data.repositoryId } });
    expect(repository?.projectId).toBe(data.projectId);
    expect(repository?.localPath).toBe(repoDir);
    const feature = await db.feature.findUnique({ where: { id: data.featureId } });
    expect(feature?.projectId).toBe(data.projectId);
  });

  it("refuses missing required options before touching the database", async () => {
    await expect(runInitCommand({ repoPath: "/tmp", featureTitle: "t" }, db)).rejects.toThrow(/--name/);
    await expect(runInitCommand({ name: "n", featureTitle: "t" }, db)).rejects.toThrow(/--repo-path/);
    await expect(runInitCommand({ name: "n", repoPath: "/tmp" }, db)).rejects.toThrow(/--feature-title/);
  });

  it("refuses non-Git paths without creating rows", async () => {
    const plain = await makeTempDir();
    const name = uniqueName("init-nogit");
    await expect(
      runInitCommand({ name, repoPath: plain, featureTitle: "t" }, db),
    ).rejects.toThrow();
    expect(await db.project.findFirst({ where: { name } })).toBeNull();
  });

  it("wires init and task commands into the CLI program", () => {
    const program = createProgram();
    const names = program.commands.map((c) => c.name());
    expect(names).toContain("init");
    const taskGroup = program.commands.find((c) => c.name() === "task");
    expect(taskGroup?.commands.map((c) => c.name())).toContain("transition");
  });
});

describe("atlas task transition (M22 blocker 2)", () => {
  async function setupTaskIn(status: "VERIFICATION" | "IN_PROGRESS", suffix: string) {
    const repoDir = await initTempRepo();
    const project = await createProject({ name: uniqueName(`trans-proj-${suffix}`) });
    track("project", project.id);
    const repository = await createRepository({ projectId: project.id, name: "main", localPath: repoDir });
    track("repository", repository.id);
    const feature = await createFeature({ projectId: project.id, title: `trans-feat-${suffix}` });
    track("feature", feature.id);
    const pending = await createTask({ featureId: feature.id, title: `trans-task-${suffix}` });
    track("task", pending.id);
    let current = await transitionTask(pending.id, "READY", db);
    current = await transitionTask(current.id, "CLAIMED", db);
    current = await transitionTask(current.id, "IN_PROGRESS", db);
    if (status === "VERIFICATION") {
      current = await transitionTask(current.id, "VERIFICATION", db);
    }
    return { feature, task: current };
  }

  it("moves VERIFICATION back to IN_PROGRESS and records actor + reason", async () => {
    const { task } = await setupTaskIn("VERIFICATION", "rework");
    const output = await runTaskTransitionCommand(
      { taskId: task.id, to: "IN_PROGRESS", actor: "op", reason: "rejected verdict needs rework" },
      db,
    );
    expect(output.exitCode).toBe(0);
    expect(output.human).toContain("VERIFICATION -> IN_PROGRESS");
    const data = output.data as { previousStatus: string; resultingStatus: string };
    expect(data.previousStatus).toBe("VERIFICATION");
    expect(data.resultingStatus).toBe("IN_PROGRESS");
    const events = await db.event.findMany({ where: { taskId: task.id, type: "TASK_TRANSITIONED" } });
    expect(events).toHaveLength(1);
    track("event", events[0]!.id);
    expect(events[0]?.actor).toBe("op");
  });

  it("supports the orphaned IN_PROGRESS two-hop path to READY", async () => {
    const { task } = await setupTaskIn("IN_PROGRESS", "orphan");
    const failed = await runTaskTransitionCommand(
      { taskId: task.id, to: "FAILED", actor: "op", reason: "launcher died; no live worker" },
      db,
    );
    expect((failed.data as { resultingStatus: string }).resultingStatus).toBe("FAILED");
    const ready = await runTaskTransitionCommand(
      { taskId: task.id, to: "READY", actor: "op", reason: "false failure; reschedule" },
      db,
    );
    expect((ready.data as { resultingStatus: string }).resultingStatus).toBe("READY");
    const events = await db.event.findMany({ where: { taskId: task.id, type: "TASK_TRANSITIONED" } });
    expect(events).toHaveLength(2);
    for (const e of events) {
      track("event", e.id);
    }
  });

  it("requires actor, reason, and a valid edge; refuses terminal states and unknown tasks", async () => {
    const { task } = await setupTaskIn("VERIFICATION", "guards");
    await expect(
      runTaskTransitionCommand({ taskId: task.id, to: "IN_PROGRESS", reason: "r" }, db),
    ).rejects.toThrow(/--actor/);
    await expect(
      runTaskTransitionCommand({ taskId: task.id, to: "IN_PROGRESS", actor: "op" }, db),
    ).rejects.toThrow(/--reason/);
    await expect(
      runTaskTransitionCommand({ taskId: task.id, to: "READY", actor: "op", reason: "r" }, db),
    ).rejects.toThrow();
    await expect(
      runTaskTransitionCommand({ taskId: task.id, to: "BOGUS", actor: "op", reason: "r" }, db),
    ).rejects.toThrow(/--to/);
    await expect(
      runTaskTransitionCommand({ taskId: "nope", to: "READY", actor: "op", reason: "r" }, db),
    ).rejects.toThrow(/not found/);
    const done = await transitionTask(task.id, "COMPLETED", db);
    expect(done.status).toBe("COMPLETED");
    await expect(
      runTaskTransitionCommand({ taskId: task.id, to: "READY", actor: "op", reason: "r" }, db),
    ).rejects.toThrow();
  });

  it("diagnose suggests the operator transition for stuck states only", async () => {
    const stuck = await setupTaskIn("VERIFICATION", "hint-v");
    const orphan = await setupTaskIn("IN_PROGRESS", "hint-p");
    const output = await runDiagnoseCommand({ runId: stuck.feature.id });
    type Finding = { taskId: string; operatorTransition?: string };
    const data = output.data as { findings: Finding[] };
    const byId = new Map(data.findings.map((f) => [f.taskId, f]));
    expect(byId.get(stuck.task.id)?.operatorTransition).toContain(`atlas task transition ${stuck.task.id} --to IN_PROGRESS`);
    expect(output.human).toContain("operator:");
    const orphanOut = await runDiagnoseCommand({ runId: orphan.feature.id });
    const orphanData = orphanOut.data as { findings: Finding[] };
    expect(orphanData.findings[0]?.operatorTransition).toContain(`atlas task transition ${orphan.task.id} --to FAILED`);
  });
});
