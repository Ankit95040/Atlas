import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { disconnectDatabase, getPrismaClient } from "../src/db/client.js";
import { createFeature, createProject, createRepository, createTask, transitionTask } from "../src/core/service.js";
import { createUiServer } from "../src/ui/serve.js";
import { ApiHomeSchema, ApiRunSummarySchema } from "../src/ui/api.js";
import { track, uniqueName } from "./domain-helpers.js";
import { initTempRepo } from "./git-helpers.js";

const db = getPrismaClient();
let base = "";

beforeAll(async () => {
  const server = createUiServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  expect(port).toBeGreaterThan(0);
  base = `http://127.0.0.1:${port}`;
  (globalThis as { __apiServer?: { close: (cb: (e?: Error) => void) => void } }).__apiServer = server;
});

async function seedApiRun(): Promise<{ featureId: string }> {
  const repoDir = await initTempRepo();
  const project = await createProject({ name: uniqueName("api-proj") }, db);
  track("project", project.id);
  const repository = await createRepository({ projectId: project.id, name: "main", localPath: repoDir }, db);
  track("repository", repository.id);
  const feature = await createFeature({ projectId: project.id, title: "api-run" }, db);
  track("feature", feature.id);
  const task = await createTask({ featureId: feature.id, title: "api-task" }, db);
  track("task", task.id);
  await transitionTask(task.id, "READY", db);
  return { featureId: feature.id };
}

afterAll(async () => {
  const server = (globalThis as { __apiServer?: { close: (cb: (e?: Error) => void) => void } }).__apiServer;
  if (server) {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
  await disconnectDatabase();
});

async function getJson(path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${base}${path}`, { headers: { Accept: "application/json" } });
  return { status: res.status, body: (await res.json()) as unknown };
}

describe("read-only JSON API for the React frontend (M26 PoC)", () => {
  it("serves /api/home matching the ApiHome contract", async () => {
    await seedApiRun();
    const { status, body } = await getJson("/api/home");
    expect(status).toBe(200);
    expect((body as { ok: boolean }).ok).toBe(true);
    const parsed = ApiHomeSchema.safeParse((body as { data: unknown }).data);
    expect(parsed.success).toBe(true);
  });

  it("serves /api/runs as a list of ApiRunSummary", async () => {
    await seedApiRun();
    const { status, body } = await getJson("/api/runs");
    expect(status).toBe(200);
    const data = (body as { data: unknown[] }).data;
    expect(Array.isArray(data)).toBe(true);
    for (const row of data) {
      expect(ApiRunSummarySchema.safeParse(row).success).toBe(true);
    }
    expect(data.some((row) => (row as { title: string }).title === "api-run")).toBe(true);
  });

  it("serves /api/run/:id/island with the IslandScene shape", async () => {
    const { featureId } = await seedApiRun();
    const { status, body } = await getJson(`/api/run/${featureId}/island`);
    expect(status).toBe(200);
    const scene = (body as { data: Record<string, unknown> }).data;
    expect(scene["runId"]).toBe(featureId);
    expect(Array.isArray(scene["buildings"])).toBe(true);
    expect(Array.isArray(scene["paths"])).toBe(true);
    expect(Array.isArray(scene["cars"])).toBe(true);
  });

  it("rejects non-GET methods on the API (read-only)", async () => {
    const res = await fetch(`${base}/api/home`, { method: "POST" });
    expect(res.status).toBe(405);
  });

  it("returns JSON 404 for unknown API routes", async () => {
    const { status, body } = await getJson("/api/nope");
    expect(status).toBe(404);
    expect((body as { ok: boolean }).ok).toBe(false);
  });

  it("serves the React shell at /app", async () => {
    const res = await fetch(`${base}/app`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<div id="root">');
  });

  it("rejects path traversal under /app", async () => {
    const res = await fetch(`${base}/app/../serve.js`);
    expect([400, 404]).toContain(res.status);
  });
});
