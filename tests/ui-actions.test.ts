import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { disconnectDatabase, getPrismaClient } from "../src/db/client.js";
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
import { createTaskClaims } from "../src/claims/index.js";
import { assignTaskToWorker } from "../src/workspaces/index.js";
import { track, uniqueName } from "./domain-helpers.js";
import { initTempRepo, trackTempPath } from "./git-helpers.js";

const db = getPrismaClient();
let base = "";
let closer: (() => Promise<void>) | null = null;

async function setupActionFeature(suffix: string) {
  const repoDir = await initTempRepo();
  const project = await createProject({ name: uniqueName(`act-proj-${suffix}`) }, db);
  track("project", project.id);
  const repository = await createRepository({ projectId: project.id, name: "main", localPath: repoDir }, db);
  track("repository", repository.id);
  const feature = await createFeature({ projectId: project.id, title: `act-feat-${suffix}` }, db);
  track("feature", feature.id);
  const scratch = trackTempPath(`/tmp/atlas-ui-act-${uniqueName(suffix)}`);
  return { project, repository, feature, scratch };
}

async function setupActionTask(featureId: string, title: string) {
  const pending = await createTask({ featureId, title }, db);
  track("task", pending.id);
  const ready = await transitionTask(pending.id, "READY", db);
  await createTaskClaims({ taskId: ready.id, claims: [{ resource: "src/a.txt", access: "WRITE" }] });
  return ready;
}

async function trackTaskScope(taskId: string): Promise<void> {
  for (const row of await db.commit.findMany({ where: { taskId }, select: { id: true } })) track("commit", row.id);
  for (const row of await db.artifact.findMany({ where: { taskId }, select: { id: true } })) track("artifact", row.id);
  for (const row of await db.testRun.findMany({ where: { taskId }, select: { id: true } })) track("testRun", row.id);
  for (const row of await db.event.findMany({ where: { taskId }, select: { id: true } })) track("event", row.id);
}

async function post(path: string, params: Record<string, string>): Promise<{ status: number; location: string | null; body: string }> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
    redirect: "manual",
  });
  const body = await res.text();
  return { status: res.status, location: res.headers.get("location"), body };
}

async function follow(location: string | null): Promise<string> {
  expect(location).not.toBeNull();
  const res = await fetch(`${base}${location as string}`);
  expect(res.status).toBe(200);
  return res.text();
}

beforeAll(async () => {
  const { createUiServer } = await import("../src/ui/serve.js");
  const server = createUiServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  expect(port).toBeGreaterThan(0);
  base = `http://127.0.0.1:${port}`;
  closer = () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

afterAll(async () => {
  if (closer !== null) {
    await closer();
  }
  await disconnectDatabase();
});

describe("plan approval action (same service as atlas plan --approve)", () => {
  it("approves a PENDING plan and reflects it in the UI", async () => {
    const { feature } = await setupActionFeature("approve-ok");
    const task = await setupActionTask(feature.id, "approve me");
    const approval = await createApproval({ featureId: feature.id, context: "m12-plan", note: "plan" }, db);
    track("approval", approval.id);

    const confirm = await fetch(`${base}/actions/plan/approve?feature=${feature.id}&approval=${approval.id}`);
    expect(confirm.status).toBe(200);
    expect(await confirm.text()).toContain("Approve plan?");

    const acted = await post("/actions/plan/approve", { feature: feature.id, approval: approval.id, actor: "op" });
    expect(acted.status).toBe(303);
    const page = await follow(acted.location);
    expect(page).toContain("Plan approved");
    expect(page).toContain("PENDING → APPROVED");
    expect((await db.approval.findUniqueOrThrow({ where: { id: approval.id } })).status).toBe("APPROVED");
    await trackTaskScope(task.id);
  });

  it("refuses double approval, wrong feature, missing actor, and unknown ids", async () => {
    const { feature } = await setupActionFeature("approve-bad");
    await setupActionTask(feature.id, "nope");
    const approval = await createApproval({ featureId: feature.id, context: "m12-plan", note: "plan" }, db);
    track("approval", approval.id);
    await decideApproval(approval.id, { decision: "APPROVED", actor: "op" }, db);

    const again = await post("/actions/plan/approve", { feature: feature.id, approval: approval.id, actor: "op" });
    expect(again.status).toBe(303);
    expect(await follow(again.location)).toContain("only PENDING plans");

    const other = await setupActionFeature("approve-other");
    const cross = await post("/actions/plan/approve", { feature: other.feature.id, approval: approval.id, actor: "op" });
    expect(cross.status).toBe(303);
    expect(await follow(cross.location)).toContain("targets feature");

    const pending = await createApproval({ featureId: feature.id, context: "m12-plan", note: "plan2" }, db);
    track("approval", pending.id);
    const noActor = await post("/actions/plan/approve", { feature: feature.id, approval: pending.id, actor: "  " });
    expect(noActor.status).toBe(303);
    expect(await follow(noActor.location)).toContain("requires an actor");
    expect((await db.approval.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe("PENDING");

    const ghost = await post("/actions/plan/approve", { feature: feature.id, approval: "nope", actor: "op" });
    expect(ghost.status).toBe(303);
    expect(await follow(ghost.location)).toContain("not found");
  });
});

describe("recovery action (same service as atlas recover task)", () => {
  it("recovers a stranded assignment and shows the new state", async () => {
    const { feature, repository, scratch } = await setupActionFeature("recover-ok");
    const task = await setupActionTask(feature.id, "stranded");
    const worker = await createWorker({}, db);
    track("worker", worker.id);
    const assignment = await assignTaskToWorker(
      { taskId: task.id, workerId: worker.id, repositoryId: repository.id, workspaceRoot: `${scratch}/ws` },
      db,
    );
    track("workspace", assignment.workspace.id);

    const confirm = await fetch(`${base}/actions/recover?task=${task.id}`);
    expect(confirm.status).toBe(200);
    const confirmHtml = await confirm.text();
    expect(confirmHtml).toContain("SAFE_TO_RECOVER");
    // GET confirms only: nothing moved.
    expect((await db.task.findUniqueOrThrow({ where: { id: task.id } })).status).toBe("CLAIMED");

    const acted = await post("/actions/recover", { task: task.id, feature: feature.id, actor: "op" });
    expect(acted.status).toBe(303);
    const page = await follow(acted.location);
    expect(page).toContain("Recovery completed");
    expect(page).toContain("CLAIMED → READY");
    expect((await db.task.findUniqueOrThrow({ where: { id: task.id } })).status).toBe("READY");
    const freed = await db.worker.findUniqueOrThrow({ where: { id: worker.id } });
    expect(freed.status).toBe("IDLE");
    expect(freed.taskId).toBeNull();
    expect(await db.event.count({ where: { taskId: task.id, type: "TASK_RECOVERED" } })).toBe(1);
    await trackTaskScope(task.id);
  });

  it("refuses unsafe and stale recoveries with truthful errors and zero movement", async () => {
    const { feature, repository, scratch } = await setupActionFeature("recover-no");
    const task = await setupActionTask(feature.id, "live");
    const worker = await createWorker({}, db);
    track("worker", worker.id);
    const assignment = await assignTaskToWorker(
      { taskId: task.id, workerId: worker.id, repositoryId: repository.id, workspaceRoot: `${scratch}/ws` },
      db,
    );
    track("workspace", assignment.workspace.id);
    await transitionTask(task.id, "IN_PROGRESS", db);
    await transitionWorker(worker.id, "RUNNING", db);

    const refused = await post("/actions/recover", { task: task.id, feature: feature.id, actor: "op" });
    expect(refused.status).toBe(303);
    expect(await follow(refused.location)).toContain("may still be active");
    expect((await db.task.findUniqueOrThrow({ where: { id: task.id } })).status).toBe("IN_PROGRESS");
    expect(await db.event.count({ where: { taskId: task.id, type: "TASK_RECOVERED" } })).toBe(0);

    // Stale UI state: resolve elsewhere, then act.
    const other = await setupActionFeature("recover-stale");
    const task2 = await setupActionTask(other.feature.id, "stale");
    const worker2 = await createWorker({}, db);
    track("worker", worker2.id);
    const assignment2 = await assignTaskToWorker(
      { taskId: task2.id, workerId: worker2.id, repositoryId: other.repository.id, workspaceRoot: `${other.scratch}/ws` },
      db,
    );
    track("workspace", assignment2.workspace.id);
    const { recoverStrandedAssignment } = await import("../src/workspaces/index.js");
    await recoverStrandedAssignment({ taskId: task2.id, actor: "other-op" }, db);
    const stale = await post("/actions/recover", { task: task2.id, feature: other.feature.id, actor: "op" });
    expect(stale.status).toBe(303);
    expect(await follow(stale.location)).toContain("not stranded");
    await trackTaskScope(task.id);
    await trackTaskScope(task2.id);
  });

  it("handles concurrent recoveries without corruption", async () => {
    const { feature, repository, scratch } = await setupActionFeature("recover-race");
    const task = await setupActionTask(feature.id, "raced");
    const worker = await createWorker({}, db);
    track("worker", worker.id);
    const assignment = await assignTaskToWorker(
      { taskId: task.id, workerId: worker.id, repositoryId: repository.id, workspaceRoot: `${scratch}/ws` },
      db,
    );
    track("workspace", assignment.workspace.id);
    const [r1, r2] = await Promise.all([
      post("/actions/recover", { task: task.id, feature: feature.id, actor: "op-a" }),
      post("/actions/recover", { task: task.id, feature: feature.id, actor: "op-b" }),
    ]);
    expect([r1.status, r2.status]).toEqual([303, 303]);
    // End state is safe regardless of interleaving: READY + IDLE + unlinked,
    // reschedulable, no corruption. (Known pre-existing M21 race: concurrent
    // winners can each record TASK_RECOVERED; the state outcome is identical
    // and safe. Recovery semantics are frozen, so this documents rather than
    // changes that behavior. Sequential double recovery is always refused —
    // see the stale test above.)
    expect((await db.task.findUniqueOrThrow({ where: { id: task.id } })).status).toBe("READY");
    const freed = await db.worker.findUniqueOrThrow({ where: { id: worker.id } });
    expect(freed.status).toBe("IDLE");
    expect(freed.taskId).toBeNull();
    expect(await db.event.count({ where: { taskId: task.id, type: "TASK_RECOVERED" } })).toBeGreaterThanOrEqual(1);
    await trackTaskScope(task.id);
  });
});

describe("transition action (same service as atlas task transition)", () => {
  it("applies a valid edge, emits the event, and reflects it in the UI", async () => {
    const { feature } = await setupActionFeature("trans-ok");
    const task = await setupActionTask(feature.id, "stuck");
    await transitionTask(task.id, "CLAIMED", db);
    await transitionTask(task.id, "IN_PROGRESS", db);
    await transitionTask(task.id, "VERIFICATION", db);

    const confirm = await fetch(`${base}/actions/transition?task=${task.id}`);
    expect(confirm.status).toBe(200);
    const confirmHtml = await confirm.text();
    expect(confirmHtml).toContain("VERIFICATION → FAILED");
    expect(confirmHtml).toContain("VERIFICATION → COMPLETED");

    const acted = await post("/actions/transition", { task: task.id, feature: feature.id, to: "FAILED", actor: "op", reason: "needs rework" });
    expect(acted.status).toBe(303);
    const page = await follow(acted.location);
    expect(page).toContain("VERIFICATION → FAILED");
    expect((await db.task.findUniqueOrThrow({ where: { id: task.id } })).status).toBe("FAILED");
    const events = await db.event.findMany({ where: { taskId: task.id, type: "TASK_TRANSITIONED" } });
    expect(events).toHaveLength(1);
    expect(events[0]?.actor).toBe("op");
    await trackTaskScope(task.id);
  });

  it("refuses invalid edges, missing actor/reason, and unknown tasks", async () => {
    const { feature } = await setupActionFeature("trans-bad");
    const task = await setupActionTask(feature.id, "bad");

    const invalid = await post("/actions/transition", { task: task.id, feature: feature.id, to: "COMPLETED", actor: "op", reason: "r" });
    expect(invalid.status).toBe(303);
    expect(await follow(invalid.location)).toContain("cannot transition");
    expect((await db.task.findUniqueOrThrow({ where: { id: task.id } })).status).toBe("READY");

    for (const params of [
      { task: task.id, feature: feature.id, to: "FAILED", reason: "r" },
      { task: task.id, feature: feature.id, to: "FAILED", actor: "op" },
    ]) {
      const missing = await post("/actions/transition", params);
      expect(missing.status).toBe(303);
      expect(await follow(missing.location)).toMatch(/actor|reason/);
    }
    const ghost = await post("/actions/transition", { task: "nope", feature: feature.id, to: "FAILED", actor: "op", reason: "r" });
    expect(ghost.status).toBe(303);
    expect(await follow(ghost.location)).toContain("not found");
    await trackTaskScope(task.id);
  });
});

describe("action route safety", () => {
  it("requires POST and never mutates on GET", async () => {
    const { feature } = await setupActionFeature("methods");
    const task = await setupActionTask(feature.id, "m");
    for (const path of ["/actions/recover", "/actions/transition", "/actions/plan/approve"]) {
      for (const method of ["PUT", "DELETE", "PATCH"]) {
        const res = await fetch(`${base}${path}`, { method });
        expect(res.status).toBe(405);
      }
    }
    // Confirm pages are reads: state unchanged afterwards.
    await (await fetch(`${base}/actions/recover?task=${task.id}`)).text();
    await (await fetch(`${base}/actions/transition?task=${task.id}`)).text();
    expect((await db.task.findUniqueOrThrow({ where: { id: task.id } })).status).toBe("READY");
    await trackTaskScope(task.id);
  });
});
