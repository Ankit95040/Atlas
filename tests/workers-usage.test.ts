import { describe, expect, it } from "vitest";
import { getPrismaClient } from "../src/db/client.js";
import { createApproval, createFeature, createProject, createRepository, createTask, createWorker, decideApproval, transitionTask } from "../src/core/service.js";
import { createTaskClaims } from "../src/claims/index.js";
import { assignTaskToWorker } from "../src/workspaces/index.js";
import { CommandWorkerProvider, executeTask, recordProviderUsage } from "../src/workers/index.js";
import { aggregateUsage, extractProviderUsage } from "../src/workers/usage.js";
import { track, uniqueName } from "./domain-helpers.js";
import { initTempRepo, makeTempDir } from "./git-helpers.js";

const db = getPrismaClient();

const COMPLETE_EVENT = JSON.stringify({
  type: "step_finish",
  part: { type: "step-finish", tokens: { total: 7792, input: 7638, output: 14, reasoning: 27, cache: { read: 113, write: 0 } }, cost: 0 },
});
const PARTIAL_EVENT = JSON.stringify({
  type: "step_finish",
  part: { type: "step-finish", tokens: { input: 500 } },
});

// M28.9 §3: usage metering is observational — these tests prove the parser,
// persistence isolation, and aggregation without changing execution semantics.

describe("usage event parsing (M28.9)", () => {
  it("1. parses a complete usage event", () => {
    const usage = extractProviderUsage(`${COMPLETE_EVENT}\n`);
    expect(usage).not.toBeNull();
    expect(usage?.tokens).toMatchObject({ total: 7792, input: 7638, output: 14, reasoning: 27, cachedRead: 113, cachedWrite: 0 });
    expect(usage?.costUsd).toBe(0);
    expect(usage?.events).toBe(1);
    expect(usage?.malformed).toBe(0);
  });

  it("2. parses a partial usage event with unobserved dimensions null", () => {
    const usage = extractProviderUsage(`${PARTIAL_EVENT}\n`);
    expect(usage?.tokens).toMatchObject({ total: null, input: 500, output: null });
    expect(usage?.costUsd).toBeNull();
  });

  it("3. returns null when no usage is present", () => {
    expect(extractProviderUsage("plain log output\n{\"type\":\"text\"}\n")).toBeNull();
    expect(extractProviderUsage("")).toBeNull();
    expect(extractProviderUsage("not json\n")).toBeNull();
  });

  it("4. preserves a legitimate zero cost instead of nulling it", () => {
    const usage = extractProviderUsage(`${COMPLETE_EVENT}\n`);
    expect(usage?.costUsd).toBe(0);
  });

  it("5. sums multiple step_finish events instead of overwriting", () => {
    const usage = extractProviderUsage(`${COMPLETE_EVENT}\n${PARTIAL_EVENT}\n`);
    expect(usage?.events).toBe(2);
    expect(usage?.tokens?.total).toBe(7792);
    expect(usage?.tokens?.input).toBe(7638 + 500);
    expect(usage?.costUsd).toBe(0);
  });

  it("6. handles identical duplicate events deterministically", () => {
    const once = extractProviderUsage(`${COMPLETE_EVENT}\n`);
    const twice = extractProviderUsage(`${COMPLETE_EVENT}\n${COMPLETE_EVENT}\n`);
    expect(twice?.tokens?.total).toBe((once?.tokens?.total ?? 0) * 2);
    expect(twice?.events).toBe(2);
  });

  it("7. treats malformed numerics as unknown, never as fabricated zeros", () => {
    const bad = JSON.stringify({ type: "step_finish", part: { type: "step-finish", tokens: { total: -5, input: "many", output: 1.5 }, cost: "free" } });
    const usage = extractProviderUsage(`${bad}\n`);
    expect(usage).not.toBeNull();
    expect(usage?.tokens).toBeNull();
    expect(usage?.costUsd).toBeNull();
    expect(usage?.events).toBe(1);
    expect(usage?.malformed).toBe(1);
  });
});

describe("usage persistence isolation (M28.9)", () => {
  async function setupTask(): Promise<{ taskId: string; featureId: string }> {
    const repoDir = await initTempRepo();
    const project = await createProject({ name: uniqueName("usage-proj") }, db);
    track("project", project.id);
    const repository = await createRepository({ projectId: project.id, name: "main", localPath: repoDir }, db);
    track("repository", repository.id);
    const feature = await createFeature({ projectId: project.id, title: "usage-feat" }, db);
    track("feature", feature.id);
    const pending = await createTask({ featureId: feature.id, title: "usage-task" }, db);
    track("task", pending.id);
    const ready = await transitionTask(pending.id, "READY", db);
    await createTaskClaims({ taskId: ready.id, claims: [{ resource: "note.txt", access: "WRITE" }] });
    const approval = await createApproval({ taskId: ready.id }, db);
    track("approval", approval.id);
    await decideApproval(approval.id, { decision: "APPROVED", actor: "usage-test" }, db);
    return { taskId: ready.id, featureId: feature.id };
  }

  it("8. records nothing on provider invocation failure (absent, not fabricated)", async () => {
    const { taskId } = await setupTask();
    const worker = await createWorker({});
    track("worker", worker.id);
    const failing = new CommandWorkerProvider({ command: [process.execPath, "-e", "process.exit(3)"] });
    const scratch = await makeTempDir();
    const task = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    const feature = await db.feature.findUniqueOrThrow({ where: { id: task.featureId } });
    const repository = await db.repository.findFirstOrThrow({ where: { projectId: feature.projectId } });
    const assignment = await assignTaskToWorker({
      taskId,
      workerId: worker.id,
      repositoryId: repository.id,
      workspaceRoot: `${scratch}/wsroot`,
    });
    track("workspace", assignment.workspace.id);
    const result = await executeTask({ taskId, workerId: worker.id, expectedBaseCommit: assignment.worktree.commit }, failing, db);
    expect(result.status).toBe("FAILED");
    const rows = await db.event.findMany({ where: { taskId, type: "PROVIDER_USAGE_OBSERVED" } });
    expect(rows).toHaveLength(0);
    for (const a of await db.artifact.findMany({ where: { taskId } })) track("artifact", a.id);
    for (const e of await db.event.findMany({ where: { taskId } })) track("event", e.id);
  });

  it("10. associates usage rows with the exact task and run", async () => {
    const { taskId, featureId } = await setupTask();
    const task = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    await recordProviderUsage(db, task, extractProviderUsage(`${COMPLETE_EVENT}\n`) ?? undefined);
    const rows = await db.event.findMany({ where: { taskId, type: "PROVIDER_USAGE_OBSERVED" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ featureId, taskId, actor: "atlas-metering" });
    const payload = JSON.parse(rows[0]?.payload ?? "") as { usage?: { tokens?: { total?: unknown } } };
    expect(payload.usage?.tokens?.total).toBe(7792);
    for (const e of rows) track("event", e.id);
    for (const e of await db.event.findMany({ where: { taskId } })) track("event", e.id);
  });

  it("9. survives persistence failure without changing execution", async () => {
    const { taskId } = await setupTask();
    const task = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    const broken = { event: { create: async (): Promise<never> => { throw new Error("db down"); } } };
    await expect(
      recordProviderUsage(broken as never, task, extractProviderUsage(`${COMPLETE_EVENT}\n`) ?? undefined),
    ).resolves.toBeUndefined();
    for (const e of await db.event.findMany({ where: { taskId } })) track("event", e.id);
  });
});

describe("usage aggregation (M28.9)", () => {
  it("11. never double-counts: identical inputs aggregate identically", () => {
    const a = extractProviderUsage(`${COMPLETE_EVENT}\n`);
    const b = extractProviderUsage(`${COMPLETE_EVENT}\n`);
    const first = aggregateUsage([a, b]);
    const second = aggregateUsage([a, b]);
    expect(first).toEqual(second);
    expect(first.tokens?.total).toBe(7792 * 2);
    expect(first.coverage).toContain("complete: 2/2");
  });

  it("12. existing provider outputs without usage still validate", async () => {
    const { taskId } = await (async () => {
      const repoDir = await initTempRepo();
      const project = await createProject({ name: uniqueName("usage-compat") }, db);
      track("project", project.id);
      const repository = await createRepository({ projectId: project.id, name: "main", localPath: repoDir }, db);
      track("repository", repository.id);
      const feature = await createFeature({ projectId: project.id, title: "usage-compat-feat" }, db);
      track("feature", feature.id);
      const pending = await createTask({ featureId: feature.id, title: "usage-compat-task" }, db);
      track("task", pending.id);
      const ready = await transitionTask(pending.id, "READY", db);
      await createTaskClaims({ taskId: ready.id, claims: [{ resource: "note.txt", access: "WRITE" }] });
      const approval = await createApproval({ taskId: ready.id }, db);
      track("approval", approval.id);
      await decideApproval(approval.id, { decision: "APPROVED", actor: "usage-test" }, db);
      return { taskId: ready.id };
    })();
    // FakeWorkerProvider returns no usage: execution semantics unchanged,
    // and no usage row appears (absent, not zero-filled).
    const { FakeWorkerProvider } = await import("../src/workers/index.js");
    const worker = await createWorker({});
    track("worker", worker.id);
    const scratch = await makeTempDir();
    const task = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    const feature = await db.feature.findUniqueOrThrow({ where: { id: task.featureId } });
    const repository = await db.repository.findFirstOrThrow({ where: { projectId: feature.projectId } });
    const assignment = await assignTaskToWorker({ taskId, workerId: worker.id, repositoryId: repository.id, workspaceRoot: `${scratch}/wsroot` });
    track("workspace", assignment.workspace.id);
    const result = await executeTask(
      { taskId, workerId: worker.id, expectedBaseCommit: assignment.worktree.commit },
      new FakeWorkerProvider(),
      db,
    );
    expect(result.status).toBe("COMPLETED_EMPTY");
    expect(await db.event.findMany({ where: { taskId, type: "PROVIDER_USAGE_OBSERVED" } })).toHaveLength(0);
    for (const a of await db.artifact.findMany({ where: { taskId } })) track("artifact", a.id);
    for (const e of await db.event.findMany({ where: { taskId } })) track("event", e.id);
  });
});
