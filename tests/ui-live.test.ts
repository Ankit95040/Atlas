import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { disconnectDatabase, getPrismaClient } from "../src/db/client.js";
import {
  createFeature,
  createProject,
  createRepository,
  createTask,
  createTaskDependency,
  createWorker,
  recordEvent,
  transitionFeature,
  transitionTask,
} from "../src/core/service.js";
import { createTaskClaims } from "../src/claims/index.js";
import { assignTaskToWorker } from "../src/workspaces/index.js";
import { loadRunState } from "../src/ui/data.js";
import { createUiServer } from "../src/ui/serve.js";
import { track, uniqueName } from "./domain-helpers.js";
import { initTempRepo, trackTempPath } from "./git-helpers.js";

const db = getPrismaClient();

async function seedLiveRun(suffix: string) {
  const repoDir = await initTempRepo();
  const project = await createProject({ name: uniqueName(`live-proj-${suffix}`) }, db);
  track("project", project.id);
  const repository = await createRepository({ projectId: project.id, name: "main", localPath: repoDir }, db);
  track("repository", repository.id);
  const feature = await createFeature({ projectId: project.id, title: `live-feat-${suffix}` }, db);
  track("feature", feature.id);
  const a = await createTask({ featureId: feature.id, title: "live-a" }, db);
  track("task", a.id);
  const b = await createTask({ featureId: feature.id, title: "live-b" }, db);
  track("task", b.id);
  await createTaskClaims({ taskId: a.id, claims: [{ resource: "src/a.txt", access: "WRITE" }] });
  await createTaskClaims({ taskId: b.id, claims: [{ resource: "src/b.txt", access: "WRITE" }] });
  await createTaskDependency({ taskId: b.id, dependsOnTaskId: a.id }, db);
  const dep = await db.taskDependency.findFirstOrThrow({ where: { taskId: b.id } });
  track("taskDependency", dep.id);
  await transitionTask(a.id, "READY", db);
  await transitionTask(b.id, "READY", db);
  const scratch = trackTempPath(`/tmp/atlas-ui-live-${uniqueName(suffix)}`);
  return { feature, repository, taskA: a.id, taskB: b.id, scratch };
}

afterAll(async () => {
  await disconnectDatabase();
});

describe("live run state (existing transition maps drive polling)", () => {
  it("reports non-terminal while work remains", async () => {
    const { feature } = await seedLiveRun("active");
    const state = await loadRunState(db, feature.id);
    expect(state.status).toBe("DRAFT");
    expect(state.terminal).toBe(false);
  });

  it("reports terminal when every task is terminal", async () => {
    const { feature, taskA, taskB } = await seedLiveRun("done");
    for (const taskId of [taskA, taskB]) {
      await transitionTask(taskId, "CLAIMED", db);
      await transitionTask(taskId, "IN_PROGRESS", db);
      await transitionTask(taskId, "VERIFICATION", db);
      await transitionTask(taskId, "COMPLETED", db);
    }
    const state = await loadRunState(db, feature.id);
    expect(state.terminal).toBe(true);
  });

  it("reports terminal for terminal features", async () => {
    const { feature } = await seedLiveRun("cancelled");
    await transitionFeature(feature.id, "CANCELLED", db);
    expect((await loadRunState(db, feature.id)).terminal).toBe(true);
  });

  it("rejects unknown runs", async () => {
    await expect(loadRunState(db, "no-such-feature")).rejects.toThrow(/unknown run scope/);
  });
});

describe("live polling pages (subsequent reads reflect new state)", () => {
  it("task, worker, and event changes appear without new endpoints", async () => {
    const { feature, repository, taskA, scratch } = await seedLiveRun("fresh");
    trackTempPath(scratch);
    const server = createUiServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    try {
      const page = async (view: string) =>
        (await (await fetch(`http://localhost:${port}/run?feature=${feature.id}&view=${view}`)).text());
      const before = await page("tasks");
      expect(before).toContain('data-terminal="false"');
      expect(before).toContain("setInterval(tick, 2500)");
      expect(before).not.toContain("CLAIMED");

      const worker = await createWorker({}, db);
      track("worker", worker.id);
      const assignment = await assignTaskToWorker(
        { taskId: taskA, workerId: worker.id, repositoryId: repository.id, workspaceRoot: scratch },
        db,
      );
      track("workspace", assignment.workspace.id);
      await recordEvent({ type: "TASK_STARTED", featureId: feature.id, taskId: taskA, actor: "test" }, db);

      const afterTasks = await page("tasks");
      expect(afterTasks).toContain("CLAIMED");
      const afterWorkers = await page("workers");
      expect(afterWorkers).toContain("atlas/worker/");
      const afterEvents = await page("events");
      expect(afterEvents).toContain("TASK_STARTED");

      for (const row of await db.event.findMany({ where: { taskId: taskA }, select: { id: true } })) {
        track("event", row.id);
      }
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("terminal runs render once with polling disabled", async () => {
    const { feature, taskA, taskB } = await seedLiveRun("fin");
    for (const taskId of [taskA, taskB]) {
      await transitionTask(taskId, "CLAIMED", db);
      await transitionTask(taskId, "IN_PROGRESS", db);
      await transitionTask(taskId, "VERIFICATION", db);
      await transitionTask(taskId, "COMPLETED", db);
    }
    const server = createUiServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    try {
      const html = await (await fetch(`http://localhost:${port}/run?feature=${feature.id}&view=overview`)).text();
      expect(html).toContain('data-terminal="true"');
      expect(html).toContain("Run finished");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("served pages carry the live affordances and failure behavior", async () => {
    const { feature } = await seedLiveRun("afford");
    const server = createUiServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    try {
      const html = await (await fetch(`http://localhost:${port}/run?feature=${feature.id}&view=events`)).text();
      for (const marker of [
        "live-indicator",
        "last-updated",
        "live-notice",
        "data-terminal",
        "setInterval(tick, 2500)",
        "clearInterval(window.__atlasPoll)",
        "Unable to refresh",
        "Last updated: ",
        "Run not found",
      ]) {
        expect(html, `missing live marker: ${marker}`).toContain(marker);
      }
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});

describe("live UI keeps the read-only contract", () => {
  it("reads no secrets or environment beyond the port flag", () => {
    // Static enforcement on top of the M24.1 mutation test: the UI layer
    // must not read process environment (DATABASE_URL belongs to the db
    // layer; provider credentials must never be reachable from display
    // code). serve.ts alone may read ATLAS_UI_PORT.
    const data = readFileSync(join(import.meta.dirname, "..", "src", "ui", "data.ts"), "utf8");
    const views = readFileSync(join(import.meta.dirname, "..", "src", "ui", "views.ts"), "utf8");
    expect(data).not.toContain("process.env");
    expect(views).not.toContain("process.env");
    const serve = readFileSync(join(import.meta.dirname, "..", "src", "ui", "serve.ts"), "utf8");
    expect(serve.match(/process\.env/g)?.length ?? 0).toBeLessThanOrEqual(2);
    expect(serve).toContain("ATLAS_UI_PORT");
  });
});
