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
  transitionTask,
} from "../src/core/service.js";
import { createTaskClaims } from "../src/claims/index.js";
import { assignTaskToWorker } from "../src/workspaces/index.js";
import { loadWorkflow, type WorkflowGraphData } from "../src/ui/data.js";
import { createUiServer } from "../src/ui/serve.js";
import { renderWorkflow } from "../src/ui/views.js";
import { track, uniqueName } from "./domain-helpers.js";
import { initTempRepo, trackTempPath } from "./git-helpers.js";

const db = getPrismaClient();

async function seedWorkflow(suffix: string) {
  const repoDir = await initTempRepo();
  const project = await createProject({ name: uniqueName(`wf-proj-${suffix}`) }, db);
  track("project", project.id);
  const repository = await createRepository({ projectId: project.id, name: "main", localPath: repoDir }, db);
  track("repository", repository.id);
  const feature = await createFeature({ projectId: project.id, title: `wf-feat-${suffix}` }, db);
  track("feature", feature.id);
  const a = await createTask({ featureId: feature.id, title: "wf-alpha" }, db);
  track("task", a.id);
  const b = await createTask({ featureId: feature.id, title: "wf-beta" }, db);
  track("task", b.id);
  const c = await createTask({ featureId: feature.id, title: "wf-gamma" }, db);
  track("task", c.id);
  await createTaskClaims({ taskId: a.id, claims: [{ resource: "src/a.txt", access: "WRITE" }] });
  await createTaskClaims({ taskId: b.id, claims: [{ resource: "src/b.txt", access: "WRITE" }] });
  await createTaskClaims({ taskId: c.id, claims: [{ resource: "src/c.txt", access: "WRITE" }] });
  await createTaskDependency({ taskId: c.id, dependsOnTaskId: a.id }, db);
  const dep = await db.taskDependency.findFirstOrThrow({ where: { taskId: c.id } });
  track("taskDependency", dep.id);
  for (const t of [a, b, c]) {
    await transitionTask(t.id, "READY", db);
  }
  // Live worker on alpha via the real assignment path (temp git repo).
  const scratch = trackTempPath(`/tmp/atlas-ui-wf-${uniqueName(suffix)}`);
  const live = await createWorker({}, db);
  track("worker", live.id);
  const assignment = await assignTaskToWorker(
    { taskId: a.id, workerId: live.id, repositoryId: repository.id, workspaceRoot: scratch },
    db,
  );
  track("workspace", assignment.workspace.id);
  // Historical worker on beta: released link, history in events only.
  const hist = await createWorker({}, db);
  track("worker", hist.id);
  await recordEvent(
    { type: "WORKER_ASSIGNED", featureId: feature.id, taskId: b.id, actor: "test", payload: { workerId: hist.id, taskId: b.id } },
    db,
  );
  for (const row of await db.event.findMany({ where: { taskId: { in: [a.id, b.id, c.id] } }, select: { id: true } })) {
    track("event", row.id);
  }
  return { feature, taskA: a.id, taskB: b.id, taskC: c.id, liveId: live.id, histId: hist.id };
}

function fabricated(overrides: Partial<WorkflowGraphData> = {}): WorkflowGraphData {
  return {
    runId: "run-1",
    runTitle: "Fab",
    runStatus: "IN_PROGRESS",
    nodes: [],
    edges: [],
    phases: [
      { name: "PLAN", active: false, detail: "none" },
      { name: "SCHEDULE", active: true, detail: "1 waiting" },
      { name: "EXECUTE", active: false, detail: "idle" },
      { name: "VERIFY", active: false, detail: "none" },
      { name: "MERGE", active: false, detail: "no train yet" },
    ],
    trainHalted: false,
    trainHaltReason: null,
    ...overrides,
  };
}

afterAll(async () => {
  await disconnectDatabase();
});

describe("workflow read model (real Atlas state, no second source)", () => {
  it("builds nodes, edges, waves, and pipeline from control-plane rows", async () => {
    const { feature, taskA, taskB, taskC, liveId, histId } = await seedWorkflow("model");
    const graph = await loadWorkflow(db, feature.id);
    expect(graph.runStatus).toBe("DRAFT");
    expect(graph.nodes).toHaveLength(3);
    expect(graph.edges).toEqual([{ from: taskA, to: taskC }]);
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    expect(byId.get(taskA)?.workerId).toBe(liveId);
    expect(byId.get(taskA)?.workerLink).toBe("live");
    expect(byId.get(taskB)?.workerId).toBe(histId);
    expect(byId.get(taskB)?.workerLink).toBe("historical");
    expect(byId.get(taskC)?.workerLink).toBe("none");
    // Real scheduler behavior: runnable B is waved; the blocked dependent
    // and the already-active task are not (waves cover runnable work only).
    expect(byId.get(taskB)?.wave).toBe(1);
    expect(byId.get(taskC)?.wave).toBeNull();
    expect(byId.get(taskA)?.wave).toBeNull();
    // Complete the prerequisite through valid edges: the dependent becomes scheduled.
    for (const to of ["CLAIMED", "IN_PROGRESS", "VERIFICATION", "COMPLETED"] as const) {
      await transitionTask(taskA, to, db);
    }
    const regrouped = await loadWorkflow(db, feature.id);
    const regroupedById = new Map(regrouped.nodes.map((n) => [n.id, n]));
    expect(regroupedById.get(taskC)?.wave).not.toBeNull();
    expect(byId.get(taskA)?.verdict).toBeNull();
    expect(byId.get(taskA)?.integrated).toBe(false);
    const schedule = graph.phases.find((p) => p.name === "SCHEDULE");
    expect(schedule?.active).toBe(true);
    expect(graph.trainHalted).toBe(false);
  });

  it("rejects unknown runs", async () => {
    await expect(loadWorkflow(db, "nope")).rejects.toThrow();
  });
});

describe("workflow rendering (extends the M24.1 SVG, no new engine)", () => {
  it("renders node states, workers, waves, and truthful unknowns", () => {
    const html = renderWorkflow("run-1", fabricated({
      nodes: [
        { id: "a1", title: "API Client", status: "RUNNING", workerId: "w1", workerStatus: "RUNNING", workerLink: "live", wave: 1, verdict: null, integrated: false, dependsOn: [] },
        { id: "b2", title: "Database Schema", status: "COMPLETED", workerId: "w2", workerStatus: "COMPLETED", workerLink: "historical", wave: 1, verdict: "VERIFIED", integrated: true, dependsOn: [] },
        { id: "c3", title: "Integration Tests", status: "BLOCKED", workerId: null, workerStatus: null, workerLink: "none", wave: null, verdict: null, integrated: false, dependsOn: ["a1", "b2"] },
        { id: "d4", title: "Frontend", status: "FAILED", workerId: "w4", workerStatus: "FAILED", workerLink: "historical", wave: 2, verdict: "REJECTED", integrated: false, dependsOn: ["c3"] },
        { id: "e5", title: "Weird One", status: "SOME_FUTURE_STATE", workerId: null, workerStatus: null, workerLink: "none", wave: null, verdict: null, integrated: false, dependsOn: [] },
      ],
      edges: [{ from: "a1", to: "c3" }, { from: "b2", to: "c3" }, { from: "c3", to: "d4" }],
    }));
    expect(html).toContain("<svg");
    expect(html).toContain("API Client");
    expect(html).toContain("● RUNNING");
    expect(html).toContain("✓");
    expect(html).toContain("× FAILED");
    expect(html).toContain("○ BLOCKED");
    expect(html).toContain("○ SOME_FUTURE_STATE");
    expect(html).toContain("(historical)");
    expect(html).toContain("wave 1");
    expect(html).toContain("INTEGRATED");
    expect(html).toContain("REJECTED");
    expect(html).toContain("depends:");
    expect(html).toContain('href="/run?feature=run-1&view=tasks#task-a1"');
    expect(html).toContain('href="/run?feature=run-1&view=workers#worker-w1"');
    // Accessible text equivalent mirrors the graph.
    expect(html).toContain("Nodes (text equivalent)");
  });

  it("shows halt banners, empty states, and escapes text", () => {
    const halted = renderWorkflow("r", fabricated({
      nodes: [{ id: "h1", title: "Halted Task", status: "VERIFICATION", workerId: "w9", workerStatus: "COMPLETED", workerLink: "live", wave: null, verdict: null, integrated: false, dependsOn: [] }],
      trainHalted: true,
      trainHaltReason: "merge conflicts in x",
    }));
    expect(halted).toContain("Merge train halted");
    expect(halted).toContain("merge conflicts in x");
    expect(renderWorkflow("r", fabricated())).toContain("No tasks yet");
    const evil = renderWorkflow("r", fabricated({
      nodes: [{ id: "x<script>", title: "<b>bold</b>", status: "READY", workerId: null, workerStatus: null, workerLink: "none", wave: null, verdict: null, integrated: false, dependsOn: [] }],
    }));
    expect(evil).not.toContain("<b>bold</b>");
    expect(evil).toContain("&lt;b&gt;bold&lt;/b&gt;");
  });
});

describe("workflow live behavior (M24.2 polling covers the graph)", () => {
  it("serves the view, reflects mutations, and flags terminality", async () => {
    const { feature, taskA } = await seedWorkflow("live");
    const server = (await import("../src/ui/serve.js")).createUiServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    try {
      const page = async () => (await (await fetch(`http://localhost:${port}/run?feature=${feature.id}&view=workflow`)).text());
      const before = await page();
      expect(before).toContain('data-terminal="false"');
      expect(before).toContain("setInterval(tick, 2500)");
      expect(before).toContain("wf-alpha");
      await transitionTask(taskA, "IN_PROGRESS", db);
      const after = await page();
      expect(after).toContain("IN_PROGRESS");
      expect(after).not.toEqual(before);
      for (const row of await db.event.findMany({ where: { taskId: taskA }, select: { id: true } })) {
        track("event", row.id);
      }
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});

describe("workflow dependency discipline", () => {
  it("adds no graph, http, or state dependencies", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    // M25.1 sanctioned exception: three (WebGL renderer, island3d client
    // only) + @types/three (dev). Nothing else may join this list without
    // its own milestone justification.
    expect(Object.keys(pkg.dependencies).sort()).toEqual(["@prisma/client", "commander", "dotenv", "three", "zod"]);
    expect(Object.keys(pkg.devDependencies).sort()).toEqual(["@types/node", "@types/three", "prisma", "typescript", "vitest"]);
  });
});
