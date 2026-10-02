import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { disconnectDatabase, getPrismaClient } from "../src/db/client.js";
import {
  loadClaims,
  loadDependencies,
  loadEvents,
  loadOverview,
  loadProjects,
  loadRuns,
  loadTasks,
  loadTrain,
  loadVerification,
  loadWorkers,
} from "../src/ui/data.js";
import { createUiServer } from "../src/ui/serve.js";
import { seedDemoDatabase } from "../src/ui/seed.js";
import {
  renderClaims,
  renderDeps,
  renderError,
  renderEvents,
  renderLanding,
  renderNotFound,
  renderOverview,
  renderTasks,
  renderTrain,
  renderVerification,
  renderWorkers,
} from "../src/ui/views.js";
import { track } from "./domain-helpers.js";
import { trackTempPath } from "./git-helpers.js";

const db = getPrismaClient();

async function seedUi(): Promise<{ projectId: string; featureId: string }> {
  const seeded = await seedDemoDatabase(db);
  // Creation order (project → repository → feature) so reverse-order
  // cleanup deletes children before parents.
  track("project", seeded.projectId);
  const repository = await db.repository.findFirstOrThrow({ where: { projectId: seeded.projectId } });
  track("repository", repository.id);
  track("feature", seeded.featureId);
  trackTempPath(seeded.repoDir);
  trackTempPath(seeded.scratchRoot);
  await trackDemoScope(seeded.featureId);
  return { projectId: seeded.projectId, featureId: seeded.featureId };
}

async function trackDemoScope(fid: string): Promise<void> {
  const tasks = await db.task.findMany({ where: { featureId: fid }, select: { id: true } });
  const taskIds = tasks.map((t) => t.id);
  for (const t of tasks) track("task", t.id);
  for (const row of await db.taskDependency.findMany({ where: { taskId: { in: taskIds } }, select: { id: true } })) {
    track("taskDependency", row.id);
  }
  const workerIds = new Set<string>();
  for (const row of await db.worker.findMany({ where: { taskId: { in: taskIds } }, select: { id: true } })) {
    workerIds.add(row.id);
  }
  for (const row of await db.event.findMany({ where: { taskId: { in: taskIds } }, select: { payload: true } })) {
    try {
      const wid = (JSON.parse(row.payload ?? "") as { workerId?: unknown }).workerId;
      if (typeof wid === "string") {
        workerIds.add(wid);
      }
    } catch {
      // Ignore non-JSON payloads.
    }
  }
  for (const id of workerIds) track("worker", id);
  for (const row of await db.workspace.findMany({ where: { workerId: { in: [...workerIds] } } })) {
    track("workspace", row.id);
  }
  for (const taskId of taskIds) {
    for (const row of await db.commit.findMany({ where: { taskId }, select: { id: true } })) track("commit", row.id);
    for (const row of await db.artifact.findMany({ where: { taskId }, select: { id: true } })) track("artifact", row.id);
    for (const row of await db.testRun.findMany({ where: { taskId }, select: { id: true } })) track("testRun", row.id);
    for (const row of await db.event.findMany({ where: { taskId }, select: { id: true } })) track("event", row.id);
  }
  for (const row of await db.approval.findMany({ where: { featureId: fid } })) track("approval", row.id);
}

beforeAll(async () => {
  // Per-test seeding (see seedUi): the shared tracked registry is cleaned
  // after every test, so file-level fixtures would vanish after test one.
});

afterAll(async () => {
  await disconnectDatabase();
});

describe("dashboard data loaders (real seeded control-plane state)", () => {
  it("loads projects and runs", async () => {
    const { projectId, featureId } = await seedUi();
    const projects = await loadProjects(db);
    expect(projects.map((p) => p.name)).toContain("Demo Shop");
    const runs = await loadRuns(db, projectId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.title).toBe("Checkout utilities");
    expect(runs[0]?.totalTasks).toBe(3);
    void featureId;
  });

  it("loads the overview with counts, workers, waves, verification, and merge", async () => {
    const { featureId } = await seedUi();
    const overview = await loadOverview(db, featureId);
    expect(overview.project.name).toBe("Demo Shop");
    expect(overview.run.totalTasks).toBe(3);
    expect(overview.run.taskCounts["FAILED"]).toBe(1);
    expect(overview.workers.length).toBeGreaterThanOrEqual(1);
    expect(overview.verification.verified).toBe(1);
    expect(overview.waves.note).toMatch(/display only/);
    expect(overview.merge.trainBranches).toEqual([]);
  });

  it("loads tasks with claims, dependencies, workers, and verdicts", async () => {
    const { featureId } = await seedUi();
    const tasks = await loadTasks(db, featureId);
    expect(tasks).toHaveLength(3);
    const byTitle = new Map(tasks.map((t) => [t.title, t]));
    expect(byTitle.get("Cover slugify with tests")?.dependsOn).toHaveLength(1);
    expect(byTitle.get("Implement slugify")?.worker).not.toBeNull();
    expect(byTitle.get("Implement slugify")?.worker?.link).toBe("live");
    expect(byTitle.get("Add greeting helper")?.verdict).toBe("VERIFIED");
    expect(byTitle.get("Cover slugify with tests")?.testRuns[0]?.status).toBe("FAILED");
  });

  it("loads workers with live linkage", async () => {
    const { featureId } = await seedUi();
    const workers = await loadWorkers(db, featureId);
    expect(workers.length).toBeGreaterThanOrEqual(1);
    const live = workers.find((w) => w.link === "live");
    expect(live?.branch).toMatch(/atlas\/worker\//);
  });

  it("loads dependencies, claims, verification, train, and events", async () => {
    const { featureId } = await seedUi();
    const deps = await loadDependencies(db, featureId);
    expect(deps.edges).toHaveLength(1);
    const claims = await loadClaims(db, featureId);
    expect(claims.perTask).toHaveLength(3);
    expect(claims.overlaps.length).toBeGreaterThanOrEqual(1);
    const verification = await loadVerification(db, featureId);
    expect(verification.total).toBe(3);
    expect(verification.findings.map((f) => f.phase)).toContain("testing");
    const train = await loadTrain(db, featureId);
    expect(train.branches).toEqual([]);
    const events = await loadEvents(db, featureId);
    expect(events.total).toBeGreaterThan(0);
    expect(events.events.map((e) => e.type)).toContain("TASK_FAILED");
    expect(events.events.map((e) => e.type)).toContain("VERIFICATION_COMPLETED");
  });

  it("rejects unknown run scopes", async () => {
    await expect(loadOverview(db, "no-such-feature")).rejects.toThrow(/unknown run scope/);
  });
});

describe("dashboard renderers (pure projection, no mocks)", () => {
  it("renders landing, overview, tasks, and workers with real values", async () => {
    const { projectId, featureId } = await seedUi();
    const landing = renderLanding(await loadProjects(db, [projectId]));
    expect(landing).toContain("Demo Shop");
    expect(landing).toContain("Checkout utilities");
    const overview = renderOverview(await loadOverview(db, featureId));
    expect(overview).toContain("Demo Shop");
    expect(overview).toContain("Checkout utilities");
    const tasks = await loadTasks(db, featureId);
    const titles = new Map(tasks.map((t) => [t.id, t.title] as const));
    const tasksHtml = renderTasks(featureId, tasks, titles);
    expect(tasksHtml).toContain("Implement slugify");
    expect(tasksHtml).toContain("src/slug.js");
    expect(tasksHtml).toContain("current");
    const workersHtml = renderWorkers(featureId, await loadWorkers(db, featureId));
    expect(workersHtml).toContain("atlas/worker/");
  });

  it("renders deps as SVG with edges, plus claims, verification, train, and events", async () => {
    const { featureId } = await seedUi();
    const depsHtml = renderDeps(featureId, await loadDependencies(db, featureId));
    expect(depsHtml).toContain("<svg");
    expect(depsHtml).toContain("───→");
    const claimsHtml = renderClaims(featureId, await loadClaims(db, featureId));
    expect(claimsHtml).toContain("src/slug.js");
    expect(claimsHtml).toContain("Conflicts");
    const verificationHtml = renderVerification(featureId, await loadVerification(db, featureId));
    expect(verificationHtml).toContain("VERIFIED");
    expect(verificationHtml).toContain("testing");
    const trainHtml = renderTrain(featureId, await loadTrain(db, featureId));
    expect(trainHtml).toContain("No train branches recorded");
    const eventsHtml = renderEvents(featureId, await loadEvents(db, featureId));
    expect(eventsHtml).toContain("TASK_FAILED");
    expect(eventsHtml).toContain("VERIFICATION_COMPLETED");
    expect(renderNotFound("gone")).toContain("Not found");
    expect(renderError("boom")).toContain("Something went wrong");
  });

  it("escapes untrusted text and renders empty states", () => {
    const featureId = "demo-feature";
    const evil = renderTasks(featureId, [
      {
        id: "t1",
        title: "<script>alert(1)</script>",
        status: "READY",
        dependsOn: [],
        requiredBy: [],
        claims: [{ resourceId: "a&b.ts", access: "WRITE" }],
        worker: null,
        testRuns: [],
        verdict: null,
        reasons: [],
      },
    ], new Map([["t1", "<script>alert(1)</script>"]]));
    expect(evil).not.toContain("<script>alert(1)</script>");
    expect(evil).toContain("&lt;script&gt;");
    expect(evil).toContain("a&amp;b.ts");
    expect(renderTasks(featureId, [], new Map())).toContain("No tasks yet");
    expect(renderWorkers(featureId, [])).toContain("No workers");
    expect(renderDeps(featureId, { tasks: [], edges: [] })).toContain("No tasks, no edges");
    expect(renderVerification(featureId, { findings: [], completed: 0, total: 0 })).toContain("No tasks to verify");
  });
});

describe("dashboard server (read-only HTTP boundary)", () => {
  it("serves pages, rejects unknown routes, and refuses mutations", async () => {
    const { featureId } = await seedUi();
    const server = createUiServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    expect(port).toBeGreaterThan(0);
    try {
      const get = async (path: string) => fetch(`http://localhost:${port}${path}`);
      const landing = await get("/");
      expect(landing.status).toBe(200);
      expect(await landing.text()).toContain("Atlas");
      for (const view of ["overview", "tasks", "workers", "deps", "claims", "verification", "train", "events"]) {
        const res = await get(`/run?feature=${featureId}&view=${view}`);
        expect(res.status).toBe(200);
        expect((await res.text()).toLowerCase()).toContain(view === "deps" ? "dependencies" : view);
      }
      expect((await get("/run?feature=no-such-feature")).status).toBe(404);
      expect((await get("/run")).status).toBe(404);
      expect((await get("/run?feature=x&view=bogus")).status).toBe(404);
      expect((await get("/nope")).status).toBe(404);
      const post = await fetch(`http://localhost:${port}/`, { method: "POST" });
      expect(post.status).toBe(405);
      const del = await fetch(`http://localhost:${port}/run?feature=${featureId}`, { method: "DELETE" });
      expect(del.status).toBe(405);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("contains zero data mutations by construction", () => {
    // Static enforcement: the serving path may only read. Prisma writes,
    // transactions, raw queries, and subprocesses have no place here —
    // every displayed value must come from existing control-plane reads.
    // (seed.ts is excluded on purpose: it is dev-only setup scaffolding
    // that writes a scratch database, never part of the serving path.)
    const sources = ["data.ts", "views.ts", "serve.ts", "island.ts", "island25.ts"].map((file) =>
      readFileSync(join(import.meta.dirname, "..", "src", "ui", file), "utf8"),
    );
    const forbidden = [
      /\bdb\.\w+\.(create|update|delete|upsert)\(/,
      /\.(createMany|updateMany|deleteMany)\(/,
      /\$transaction\(/,
      /\$executeRaw/,
      /\$queryRaw/,
      /execFile\(/,
      /child_process/,
    ];
    for (const [index, source] of sources.entries()) {
      for (const pattern of forbidden) {
        expect(source, `src/ui/${["data.ts", "views.ts", "serve.ts", "island.ts", "island25.ts"][index]} matches ${String(pattern)}`).not.toMatch(pattern);
      }
    }
  });
});
