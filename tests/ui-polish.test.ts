import { afterAll, describe, expect, it } from "vitest";
import { disconnectDatabase, getPrismaClient } from "../src/db/client.js";
import {
  createFeature,
  createProject,
  createRepository,
  createTask,
  recordEvent,
  transitionTask,
} from "../src/core/service.js";
import { createTaskClaims } from "../src/claims/index.js";
import { loadHome } from "../src/ui/data.js";
import { createUiServer } from "../src/ui/serve.js";
import { track, uniqueName } from "./domain-helpers.js";
import { initTempRepo } from "./git-helpers.js";

const db = getPrismaClient();

async function seedPolish(suffix: string) {
  const repoDir = await initTempRepo();
  const project = await createProject({ name: uniqueName(`pol-proj-${suffix}`) }, db);
  track("project", project.id);
  const repository = await createRepository({ projectId: project.id, name: "main", localPath: repoDir }, db);
  track("repository", repository.id);
  const feature = await createFeature({ projectId: project.id, title: `pol-feat-${suffix}` }, db);
  track("feature", feature.id);
  const task = await createTask({ featureId: feature.id, title: `pol-task-${suffix}` }, db);
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

describe("product polish (visual system without new behavior)", () => {
  it("marks navigation active states and renders primitives", async () => {
    const { feature } = await seedPolish("nav");
    const server = createUiServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    try {
      const home = await (await fetch(`http://localhost:${port}/`)).text();
      expect(home).toContain('<a href="/" class="on">Home</a>');
      expect(home).toContain("Orchestrate AI coding work with evidence.");
      expect(home).toContain("System snapshot");
      const run = await (await fetch(`http://localhost:${port}/run?feature=${feature.id}&view=island`)).text();
      expect(run).toContain('href="/run?feature=');
      expect(run).toContain('class="on">Island<');
      expect(run).toContain('id="run-hud"');
      expect(run).toContain("focus-visible");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("renders home metrics identical to loader data (no fabrication)", async () => {
    await seedPolish("metrics");
    const expected = await loadHome(db);
    const server = createUiServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    try {
      const html = await (await fetch(`http://localhost:${port}/`)).text();
      for (const [label, value] of Object.entries(expected.metrics)) {
        const name = { projects: "Projects", runs: "Runs", tasks: "Tasks", liveWorkers: "Live workers", verified: "Verified", merges: "Merges" }[label] as string;
        expect(html, `metric ${label}`).toContain(`<div class="k">${name}</div><div class="v">${value}</div>`);
      }
      for (const run of expected.recentRuns.slice(0, 3)) {
        expect(html).toContain(`/run?feature=${run.id}`);
      }
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("renders run HUD truthfully including phases and halt state", async () => {
    const { feature } = await seedPolish("hud");
    await recordEvent(
      { type: "INTEGRATION_FAILED", featureId: feature.id, actor: "test", payload: { trainBranch: "atlas/t-hud", status: "HALTED", haltReason: "hud halt reason" } },
      db,
    );
    for (const row of await db.event.findMany({ where: { featureId: feature.id, taskId: null }, select: { id: true } })) {
      track("event", row.id);
    }
    const server = createUiServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    try {
      const html = await (await fetch(`http://localhost:${port}/run?feature=${feature.id}&view=tasks`)).text();
      expect(html).toContain('id="run-hud"');
      expect(html).toContain("pol-feat-hud");
      expect(html).toContain("PLAN");
      expect(html).toContain("EXECUTE");
      expect(html).toContain("VERIFY");
      expect(html).toContain("MERGE");
      expect(html).toContain("hud halt reason");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("exposes island interaction targets, fallback, and responsive markers", async () => {
    const { feature } = await seedPolish("interact");
    const server = createUiServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    try {
      const flat = await (await fetch(`http://localhost:${port}/run?feature=${feature.id}&view=island`)).text();
      // SVG links are natively keyboard-focusable; the 3D canvas is focusable.
      expect(flat).toContain('role="img"');
      expect(flat).toContain("Island nodes (text equivalent)");
      expect(flat).toContain("prefers-reduced-motion");
      expect(flat).toContain('name="viewport"');
      expect(flat).toContain("@media (max-width: 800px)");
      expect(flat).toContain("overflow-wrap");
      const proto = await (await fetch(`http://localhost:${port}/run?feature=${feature.id}&view=island&mode=proto`)).text();
      expect(proto).toContain("ATLAS ISLAND");
      const three = await (await fetch(`http://localhost:${port}/run?feature=${feature.id}&view=island&mode=3d`)).text();
      expect(three).toContain('tabindex="0"');
      expect(three).toContain('role="img"');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
