import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { disconnectDatabase, getPrismaClient } from "../src/db/client.js";
import {
  createFeature,
  createProject,
  createRepository,
  createTask,
  transitionTask,
} from "../src/core/service.js";
import { createTaskClaims } from "../src/claims/index.js";
import { loadProjects, loadRuns } from "../src/ui/data.js";
import { renderLanding } from "../src/ui/views.js";
import { createUiServer } from "../src/ui/serve.js";
import { track, uniqueName } from "./domain-helpers.js";
import { initTempRepo } from "./git-helpers.js";

const db = getPrismaClient();
let base = "";

async function seedSolo(): Promise<{ projectId: string; featureId: string }> {
  const seeded = await seedNavProject("solo", 1);
  return { projectId: seeded.projectId, featureId: seeded.featureIds[0] as string };
}

async function seedMulti(): Promise<{ projectId: string; featureIds: string[] }> {
  const seeded = await seedNavProject("multi", 2);
  return { projectId: seeded.projectId, featureIds: seeded.featureIds };
}

async function seedNavProject(suffix: string, runCount: number): Promise<{ projectId: string; featureIds: string[] }> {
  const repoDir = await initTempRepo();
  const project = await createProject({ name: uniqueName(`nav-proj-${suffix}`) }, db);
  track("project", project.id);
  const repository = await createRepository({ projectId: project.id, name: "main", localPath: repoDir }, db);
  track("repository", repository.id);
  const featureIds: string[] = [];
  for (let i = 0; i < runCount; i++) {
    const feature = await createFeature({ projectId: project.id, title: `nav-run-${suffix}-${i}` }, db);
    track("feature", feature.id);
    const task = await createTask({ featureId: feature.id, title: `nav-task-${suffix}-${i}` }, db);
    track("task", task.id);
    await transitionTask(task.id, "READY", db);
    await createTaskClaims({ taskId: task.id, claims: [{ resource: `src/${suffix}-${i}.txt`, access: "WRITE" }] });
    featureIds.push(feature.id);
  }
  return { projectId: project.id, featureIds };
}

beforeAll(async () => {
  const server = createUiServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  expect(port).toBeGreaterThan(0);
  base = `http://127.0.0.1:${port}`;
  (globalThis as { __navServer?: { close: (cb: (e?: Error) => void) => void } }).__navServer = server;
});

afterAll(async () => {
  const server = (globalThis as { __navServer?: { close: (cb: (e?: Error) => void) => void } }).__navServer;
  if (server) {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
  await disconnectDatabase();
});

describe("project vs feature identity (source of truth: Feature rows)", () => {
  it("rejects a project ID as a run scope", async () => {
    const { projectId } = await seedSolo();
    const projects = await loadProjects(db, [projectId]);
    const project = projects.find((p) => p.name.includes("nav-proj-solo")) ?? projects[0];
    expect(project).toBeDefined();
    const res = await fetch(`${base}/run?feature=${project?.id}&view=island&mode=proto`);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("unknown run scope");
  }, 60_000);

  it("loads a real feature ID and exposes its runs from the project", async () => {
    const { projectId, featureId: soloFeatureId } = await seedSolo();
    const projects = await loadProjects(db, [projectId]);
    const solo = projects.find((p) => p.runs.some((r) => r.id === soloFeatureId));
    expect(solo).toBeDefined();
    expect(solo?.runs).toHaveLength(1);
    expect(solo?.runs[0]?.totalTasks).toBe(1);
    // Same run discoverable through the runs loader (no HTML involved).
    const runs = await loadRuns(db, solo?.id);
    expect(runs.map((r) => r.id)).toContain(soloFeatureId);
  }, 60_000);

  it("gives single-run projects a direct link, multi-run projects a listing", async () => {
    const { projectId: soloPid, featureId: soloFeatureId } = await seedSolo();
    const { projectId: multiPid, featureIds: multiFeatureIds } = await seedMulti();
    const html = renderLanding(await loadProjects(db, [soloPid, multiPid]));
    const summaryOf = (name: string): string => {
      const start = html.indexOf(name);
      const end = html.indexOf("</summary>", start);
      return html.slice(start, end);
    };
    // Single-run: summary itself links straight to the run.
    expect(summaryOf("nav-proj-solo")).toContain(`/run?feature=${soloFeatureId}`);
    expect(summaryOf("nav-proj-solo")).toContain("Open run →");
    // Multi-run: summary links nothing (listing below carries one link per run).
    expect(summaryOf("nav-proj-multi")).not.toContain("Open run →");
    for (const fid of multiFeatureIds) {
      expect(html).toContain(`/run?feature=${fid}`);
    }
    // Project IDs never open runs.
    expect(html).not.toContain("/run?feature=nav-proj");
  }, 60_000);
});

describe("populated-run views over real feature IDs", () => {
  it("serves overview, workflow, island, and proto for a real run", async () => {
    const { featureId: soloFeatureId } = await seedSolo();
    for (const view of ["overview", "workflow", "island", "tasks", "workers", "verification", "train", "events"]) {
      const res = await fetch(`${base}/run?feature=${soloFeatureId}&view=${view}`);
      expect(res.status, view).toBe(200);
    }
    const proto = await fetch(`${base}/run?feature=${soloFeatureId}&view=island&mode=proto`);
    expect(proto.status).toBe(200);
    expect(await proto.text()).toContain("2.5D prototype");
  }, 60_000);

  it("keeps unknown and project IDs truthfully 404", async () => {
    const unknown = await fetch(`${base}/run?feature=no-such-feature&view=island&mode=proto`);
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toContain("unknown run scope");
    const projects = await loadProjects(db);
    const pid = projects[0]?.id ?? "nope";
    const asRun = await fetch(`${base}/run?feature=${pid}&view=overview`);
    expect(asRun.status).toBe(404);
  }, 60_000);

  it("discovers the richest run through loaders only (no HTML scraping)", async () => {
    const { projectId } = await seedSolo();
    const projects = await loadProjects(db, [projectId]);
    let best: { fid: string; title: string; tasks: number } | null = null;
    for (const p of projects) {
      for (const r of p.runs) {
        if (best === null || r.totalTasks > best.tasks) {
          best = { fid: r.id, title: r.title, tasks: r.totalTasks };
        }
      }
    }
    expect(best).not.toBeNull();
    expect(best?.tasks ?? 0).toBeGreaterThan(0);
    const res = await fetch(`${base}/run?feature=${best?.fid}&view=tasks`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(best?.fid?.slice(0, 8) ?? "");
  }, 60_000);
});

describe("UI/CLI database parity and route safety", () => {
  it("resolves the same database through the same client (no hardcoded paths)", async () => {
    // Both UI loaders and CLI services share getPrismaClient: seed through
    // the service layer (what the CLI uses) and read through the UI layer.
    const seeded = await seedNavProject("parity", 1);
    const projects = await loadProjects(db, [seeded.projectId]);
    expect(projects.map((p) => p.id)).toContain(seeded.projectId);
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    for (const file of ["data.ts", "views.ts", "actions.ts", "island.ts", "island25.ts"]) {
      const source = readFileSync(join(import.meta.dirname, "..", "src", "ui", file), "utf8");
      expect(source, `${file} hardcodes a database path`).not.toMatch(/dev\.db|["']\/tmp\//);
      expect(source, `${file} reads process.env`).not.toContain("process.env");
    }
  }, 60_000);

  it("exposes no mutation outside POST action routes", async () => {
    const { featureId } = await seedSolo();
    for (const method of ["PUT", "DELETE", "PATCH"]) {
      const res = await fetch(`${base}/run?feature=${featureId}&view=island&mode=proto`, { method });
      expect(res.status).toBe(405);
    }
    const get = await fetch(`${base}/actions/recover?task=nope`);
    expect([400, 404, 500]).toContain(get.status);
  }, 60_000);
});
