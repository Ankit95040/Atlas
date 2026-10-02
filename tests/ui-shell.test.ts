import { afterAll, describe, expect, it } from "vitest";
import { disconnectDatabase, getPrismaClient } from "../src/db/client.js";
import {
  createFeature,
  createProject,
  createRepository,
  createTask,
  transitionTask,
} from "../src/core/service.js";
import { createTaskClaims } from "../src/claims/index.js";
import { loadHome } from "../src/ui/data.js";
import { createUiServer } from "../src/ui/serve.js";
import { track, uniqueName } from "./domain-helpers.js";
import { initTempRepo } from "./git-helpers.js";

const db = getPrismaClient();

async function seedShell(suffix: string) {
  const repoDir = await initTempRepo();
  const project = await createProject({ name: uniqueName(`shell-proj-${suffix}`) }, db);
  track("project", project.id);
  const repository = await createRepository({ projectId: project.id, name: "main", localPath: repoDir }, db);
  track("repository", repository.id);
  const feature = await createFeature({ projectId: project.id, title: `shell-feat-${suffix}` }, db);
  track("feature", feature.id);
  const task = await createTask({ featureId: feature.id, title: `shell-task-${suffix}` }, db);
  track("task", task.id);
  await transitionTask(task.id, "READY", db);
  await createTaskClaims({ taskId: task.id, claims: [{ resource: "src/a.txt", access: "WRITE" }] });
  for (const row of await db.event.findMany({ where: { taskId: task.id }, select: { id: true } })) {
    track("event", row.id);
  }
  return { feature };
}

afterAll(async () => {
  await disconnectDatabase();
});

describe("product shell (hierarchy over the same read-only UI)", () => {
  it("renders primary navigation with the run hierarchy", async () => {
    const { feature } = await seedShell("nav");
    const server = createUiServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    try {
      const home = await (await fetch(`http://localhost:${port}/`)).text();
      for (const label of ["Home", "Runs", "Workers", "Activity"]) {
        expect(home, `missing primary nav: ${label}`).toContain(`>${label}<`);
      }
      expect(home).toContain("Orchestrate AI coding work with evidence.");
      expect(home).toContain("System snapshot");
      expect(home).toContain("Open Island →");
      const run = await (await fetch(`http://localhost:${port}/run?feature=${feature.id}&view=island`)).text();
      const tabOrder = ["Island", "Workflow", "Tasks", "Workers", "Verification", "Merge Train", "Activity"];
      let cursor = -1;
      for (const label of tabOrder) {
        const at = run.indexOf(`>${label}<`, cursor + 1);
        expect(at, `run tab missing or misordered: ${label}`).toBeGreaterThan(cursor);
        cursor = at;
      }
      // Secondary row keeps every technical view one click away.
      for (const label of ["Overview", "Dependencies", "Claims", "Events"]) {
        expect(run).toContain(`>${label}<`);
      }
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  }, 60_000);

  it("serves runs, workers, activity, and run activity from real state", async () => {
    const { feature } = await seedShell("pages");
    const server = createUiServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    try {
      const runsRes = await fetch(`http://localhost:${port}/runs`);
      expect(runsRes.status).toBe(200);
      const runs = await runsRes.text();
      expect(runs).toContain("shell-feat-pages");
      expect(runs).toContain(`/run?feature=${feature.id}`);
      // Every run href on the page resolves: project IDs never open runs.
      const hrefs = [...new Set([...runs.matchAll(/\/run\?feature=([a-z0-9]+)/g)].map((m) => m[1] as string))].slice(0, 5);
      expect(hrefs.length).toBeGreaterThan(0);
      for (const id of hrefs) {
        const res = await fetch(`http://localhost:${port}/run?feature=${id}&view=overview`);
        expect(res.status, `run href dead: ${id}`).toBe(200);
      }
      const workersRes = await fetch(`http://localhost:${port}/workers`);
      expect(workersRes.status).toBe(200);
      expect(await workersRes.text()).toContain("Workers");
      const activity = await (await fetch(`http://localhost:${port}/activity`)).text();
      expect(activity).toContain("Activity");
      const runActivity = await (await fetch(`http://localhost:${port}/run?feature=${feature.id}&view=activity`)).text();
      expect(runActivity).toContain("timeline");
      expect(runActivity).toContain("TASK_CREATED");
      // Technical views still reachable.
      for (const view of ["deps", "claims", "events", "overview"]) {
        const res = await fetch(`http://localhost:${port}/run?feature=${feature.id}&view=${view}`);
        expect(res.status, view).toBe(200);
      }
      expect((await fetch(`http://localhost:${port}/nope`)).status).toBe(404);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  }, 60_000);

  it("exposes real home metrics without fabrication", async () => {
    await seedShell("metrics");
    const home = await loadHome(db);
    expect(home.metrics.projects).toBeGreaterThanOrEqual(1);
    expect(home.metrics.tasks).toBeGreaterThanOrEqual(1);
    expect(home.recentRuns.length).toBeGreaterThanOrEqual(1);
    // No invented aggregates: every number traces to a row count.
    expect(home.activeRuns.every((r) => r.totalTasks > 0)).toBe(true);
  }, 60_000);
});
