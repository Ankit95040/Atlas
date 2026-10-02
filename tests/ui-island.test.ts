import { afterAll, describe, expect, it } from "vitest";
import { disconnectDatabase, getPrismaClient } from "../src/db/client.js";
import {
  createFeature,
  createProject,
  createRepository,
  createTask,
  createTaskDependency,
  createWorker,
  recordCommit,
  recordEvent,
  transitionTask,
} from "../src/core/service.js";
import { createTaskClaims } from "../src/claims/index.js";
import { assignTaskToWorker } from "../src/workspaces/index.js";
import { loadWorkflow, type WorkflowGraphData } from "../src/ui/data.js";
import { createUiServer } from "../src/ui/serve.js";
import { renderIsland } from "../src/ui/island.js";
import { track, uniqueName } from "./domain-helpers.js";
import { initTempRepo, trackTempPath } from "./git-helpers.js";

const db = getPrismaClient();

async function seedIsland(suffix: string) {
  const repoDir = await initTempRepo();
  const project = await createProject({ name: uniqueName(`isl-proj-${suffix}`) }, db);
  track("project", project.id);
  const repository = await createRepository({ projectId: project.id, name: "main", localPath: repoDir }, db);
  track("repository", repository.id);
  const feature = await createFeature({ projectId: project.id, title: `isl-feat-${suffix}` }, db);
  track("feature", feature.id);
  const a = await createTask({ featureId: feature.id, title: "isl-alpha" }, db);
  track("task", a.id);
  const b = await createTask({ featureId: feature.id, title: "isl-beta" }, db);
  track("task", b.id);
  const c = await createTask({ featureId: feature.id, title: "isl-gamma" }, db);
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
  const scratch = trackTempPath(`/tmp/atlas-ui-isl-${uniqueName(suffix)}`);
  const live = await createWorker({}, db);
  track("worker", live.id);
  const assignment = await assignTaskToWorker(
    { taskId: a.id, workerId: live.id, repositoryId: repository.id, workspaceRoot: scratch },
    db,
  );
  track("workspace", assignment.workspace.id);
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
    runId: "run-9",
    runTitle: "Fab Island",
    runStatus: "IN_PROGRESS",
    nodes: [],
    edges: [],
    phases: [],
    trainHalted: false,
    trainHaltReason: null,
    trainCars: [],
    defaultBranch: "main",
    ...overrides,
  };
}

afterAll(async () => {
  await disconnectDatabase();
});

describe("island read model (extends WorkflowGraphData only)", () => {
  it("carries reasons, train cars, and default branch", async () => {
    const { feature, taskA } = await seedIsland("model");
    await recordEvent(
      { type: "VERIFICATION_COMPLETED", featureId: feature.id, taskId: taskA, actor: "test", payload: { verdict: "REJECTED", reasons: ["unit said no"], workerId: "w" } },
      db,
    );
    const event = await db.event.findFirstOrThrow({ where: { taskId: taskA, type: "VERIFICATION_COMPLETED" } });
    track("event", event.id);
    const graph = await loadWorkflow(db, feature.id);
    const node = graph.nodes.find((n) => n.id === taskA);
    expect(node?.reasons).toEqual(["unit said no"]);
    expect(graph.trainCars).toEqual([]);
    expect(graph.defaultBranch).toBe("main");
  });
});

describe("island rendering (static projection, no animation)", () => {
  const rich = (): WorkflowGraphData =>
    fabricated({
      nodes: [
        { id: "a1", title: "Alpha", status: "COMPLETED", workerId: "w1", workerStatus: "COMPLETED", workerLink: "historical", wave: 1, verdict: "VERIFIED", reasons: [], integrated: true, dependsOn: [] },
        { id: "b2", title: "Beta", status: "IN_PROGRESS", workerId: "w2", workerStatus: "RUNNING", workerLink: "live", wave: 1, verdict: null, integrated: false, dependsOn: [] },
        { id: "c3", title: "Gamma", status: "BLOCKED", workerId: null, workerStatus: null, workerLink: "none", wave: null, verdict: null, integrated: false, dependsOn: ["a1"] },
        { id: "d4", title: "Delta", status: "FAILED", workerId: "w4", workerStatus: "FAILED", workerLink: "historical", wave: 2, verdict: "REJECTED", reasons: ["tests red"], integrated: false, dependsOn: ["c3"] },
        { id: "e5", title: "Enigma", status: "FUTURE_WEIRD", workerId: null, workerStatus: null, workerLink: "none", wave: null, verdict: null, integrated: false, dependsOn: [] },
      ],
      edges: [{ from: "a1", to: "c3" }, { from: "c3", to: "d4" }],
      trainCars: [{ taskId: "a1", title: "Alpha", sha: "abc123def456789", subject: "atlas-train: integrate" }],
    });

  it("renders structures, figures, paths, wall, railyard, and harbor", () => {
    const html = renderIsland("run-9", rich());
    expect(html).toContain("ATLAS CONTROL");
    expect(html).toContain("ATLAS ISLAND");
    expect(html).toContain("Alpha");
    // Levels from dependency depth, waves separate.
    expect(html).toContain("LEVEL 1");
    expect(html).toContain("LEVEL 2");
    expect(html).toContain("LEVEL 3");
    expect(html).toContain("WAVE 1");
    expect(html).toContain("LEVEL = dependency depth");
    expect(html).toContain("WAVE = scheduler output");
    // Workers beside structures, never as progress.
    expect(html).toContain("(historical)");
    const main = html.split("<main")[1]?.split("</main>")[0] ?? "";
    expect(main).not.toMatch(/\d+%/);
    expect(main).not.toContain("progress");
    // Verification wall with persisted reason; railyard car from merge state.
    expect(html).toContain("VERIFICATION WALL");
    expect(html).toContain("tests red");
    expect(html).toContain("abc123def456");
    expect(html).toContain("HARBOR");
    expect(html).toContain("MAIN main");
    expect(html).toContain("stores no main SHA");
    // Failure without theatrics; blocked with waiting names.
    expect(html).toContain("× FAILED");
    expect(html).toContain("waiting on Alpha");
    // Unknown future states stay truthful.
    expect(html).toContain("○ FUTURE_WEIRD");
    // Full-ID navigation anchors.
    expect(html).toContain('href="/run?feature=run-9&view=tasks#task-a1"');
    expect(html).toContain('href="/run?feature=run-9&view=workers#worker-w1"');
    expect(html).toContain('href="/run?feature=run-9&view=overview"');
    // Text equivalent present on the same page.
    expect(html).toContain("Island nodes (text equivalent)");
  });

  it("renders halt beacons with persisted reasons and empty states", () => {
    const halted = renderIsland("r", fabricated({
      nodes: [{ id: "h", title: "H", status: "VERIFICATION", workerId: "w", workerStatus: "COMPLETED", workerLink: "live", wave: null, verdict: null, reasons: [], integrated: false, dependsOn: [] }],
      trainHalted: true,
      trainHaltReason: "merge conflicts in shared/counter.txt",
    }));
    expect(halted).toContain("! HALTED");
    expect(halted).toContain("merge conflicts in shared/counter.txt");
    expect(renderIsland("r", fabricated())).toContain("open water");
  });

  it("escapes untrusted text everywhere", () => {
    const evil = renderIsland("r \"quoted\"", fabricated({
      nodes: [{ id: "x", title: "<img src=x onerror=1>", status: "READY", workerId: null, workerStatus: null, workerLink: "none", wave: null, verdict: null, integrated: false, dependsOn: [] }],
    }));
    expect(evil).not.toContain("<img src=x onerror=1>");
    expect(evil).toContain("&lt;img");
    expect(evil).not.toContain('feature=r "quoted"');
  });
});

describe("island route and live behavior", () => {
  it("serves the island through existing polling with no new endpoints", async () => {
    const { feature, taskA } = await seedIsland("route");
    const server = (await import("../src/ui/serve.js")).createUiServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    try {
      const page = async () => (await (await fetch(`http://localhost:${port}/run?feature=${feature.id}&view=island`)).text());
      const before = await page();
      expect(before).toContain("ATLAS ISLAND");
      expect(before).toContain("isl-alpha");
      expect(before).toContain('data-terminal="false"');
      expect(before).toContain("setInterval(tick, 2500)");
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

describe("island live lifecycle (state changes become visual changes)", () => {
  async function seedWalk(suffix: string) {
    const repoDir = await initTempRepo();
    const project = await createProject({ name: uniqueName(`islw-proj-${suffix}`) }, db);
    track("project", project.id);
    const repository = await createRepository({ projectId: project.id, name: "main", localPath: repoDir }, db);
    track("repository", repository.id);
    const feature = await createFeature({ projectId: project.id, title: `islw-feat-${suffix}` }, db);
    track("feature", feature.id);
    const task = await createTask({ featureId: feature.id, title: "isl-walk" }, db);
    track("task", task.id);
    await createTaskClaims({ taskId: task.id, claims: [{ resource: "src/w.txt", access: "WRITE" }] });
    const trackAll = async () => {
      for (const row of await db.event.findMany({ where: { taskId: task.id }, select: { id: true } })) track("event", row.id);
      for (const row of await db.testRun.findMany({ where: { taskId: task.id }, select: { id: true } })) track("testRun", row.id);
      for (const row of await db.commit.findMany({ where: { taskId: task.id }, select: { id: true } })) track("commit", row.id);
      for (const row of await db.worker.findMany({ where: { taskId: task.id }, select: { id: true } })) track("worker", row.id);
    };
    return { feature, repository, taskId: task.id, trackAll };
  }

  async function islandHtml(port: number, featureId: string): Promise<string> {
    const res = await fetch(`http://localhost:${port}/run?feature=${featureId}&view=island`);
    expect(res.status).toBe(200);
    return res.text();
  }

  it("walks PENDING to INTEGRATED with worker release, all through polling reads", async () => {
    const { feature, repository, taskId, trackAll } = await seedWalk("walk");
    const server = (await import("../src/ui/serve.js")).createUiServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    try {
      // 1-2. PENDING → READY.
      expect(await islandHtml(port, feature.id)).toContain("○ PENDING");
      await transitionTask(taskId, "READY", db);
      expect(await islandHtml(port, feature.id)).toContain("○ READY");
      // 3. READY → CLAIMED with a live worker figure.
      const worker = await createWorker({}, db);
      track("worker", worker.id);
      const scratch = trackTempPath(`/tmp/atlas-ui-islw-${uniqueName("walk")}`);
      const assignment = await assignTaskToWorker(
        { taskId, workerId: worker.id, repositoryId: repository.id, workspaceRoot: scratch },
        db,
      );
      track("workspace", assignment.workspace.id);
      const claimed = await islandHtml(port, feature.id);
      expect(claimed).toContain("● CLAIMED");
      expect(claimed).toContain(`worker-${worker.id}`);
      // 4-5. CLAIMED → IN_PROGRESS → COMPLETED.
      await transitionTask(taskId, "IN_PROGRESS", db);
      expect(await islandHtml(port, feature.id)).toContain("● IN_PROGRESS");
      await transitionTask(taskId, "VERIFICATION", db);
      await transitionTask(taskId, "COMPLETED", db);
      expect(await islandHtml(port, feature.id)).toContain("✓ COMPLETED");
      // 6. VERIFICATION_COMPLETED event opens the gate (persisted verdict only).
      await recordEvent(
        { type: "VERIFICATION_COMPLETED", featureId: feature.id, taskId, actor: "test", payload: { verdict: "VERIFIED", reasons: [], workerId: worker.id } },
        db,
      );
      const gated = await islandHtml(port, feature.id);
      expect(gated).toContain("✓");
      expect(gated).toContain("VERIFIED");
      // 7-10. Integration commit creates the car; release hollows the figure.
      await recordCommit({ repositoryId: repository.id, sha: "abc1234def5678901234567890abcdef12345678", branch: "atlas/train-live", subject: "atlas-train: integrate", taskId }, db);
      await recordEvent(
        { type: "INTEGRATION_COMPLETED", featureId: feature.id, actor: "test", payload: { trainBranch: "atlas/train-live", status: "COMPLETED" } },
        db,
      );
      const { releaseWorkerAssignment } = await import("../src/core/service.js");
      await transitionWorkerForRelease(worker.id);
      await releaseWorkerAssignment(worker.id, db);
      const merged = await islandHtml(port, feature.id);
      expect(merged).toContain("abc1234def56");
      expect(merged).toContain("historical");
      expect(merged).toContain("data-terminal=\"true\"");
      await trackAll();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("shows FAILED, halt beacons, and terminal stop without animation", async () => {
    const { feature, taskId, trackAll } = await seedWalk("fail");
    await transitionTask(taskId, "READY", db);
    await transitionTask(taskId, "CLAIMED", db);
    await transitionTask(taskId, "IN_PROGRESS", db);
    await transitionTask(taskId, "FAILED", db);
    await recordEvent(
      { type: "TASK_FAILED", featureId: feature.id, taskId, actor: "test", payload: { phase: "testing", error: "boom" } },
      db,
    );
    const server = (await import("../src/ui/serve.js")).createUiServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    try {
      // 8. Failed task stays failed and distinguishable.
      const failed = await islandHtml(port, feature.id);
      expect(failed).toContain("× FAILED");
      expect(failed).toContain("HARBOR");
      // 9. Halted train with the real persisted reason.
      await recordCommit({ repositoryId: (await db.repository.findFirstOrThrow({ where: { project: { features: { some: { id: feature.id } } } } })).id, sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", branch: "atlas/train-halt", subject: "x", taskId }, db);
      await recordEvent(
        { type: "INTEGRATION_FAILED", featureId: feature.id, actor: "test", payload: { trainBranch: "atlas/train-halt", status: "HALTED", haltReason: "merge conflicts in f.txt" } },
        db,
      );
      const halted = await islandHtml(port, feature.id);
      expect(halted).toContain("! HALTED");
      expect(halted).toContain("merge conflicts in f.txt");
      // 11. Terminal: all tasks terminal stops polling.
      await transitionTask(taskId, "READY", db);
      await transitionTask(taskId, "CLAIMED", db);
      await transitionTask(taskId, "IN_PROGRESS", db);
      await transitionTask(taskId, "VERIFICATION", db);
      await transitionTask(taskId, "COMPLETED", db);
      expect(await islandHtml(port, feature.id)).toContain("data-terminal=\"true\"");
      // 14. Non-mutating reads only: main repo untouched (no worktree writes by UI).
      const { runGit } = await import("../src/git/index.js");
      const { repository } = await (async () => {
        const r = await db.repository.findFirstOrThrow({ where: { project: { features: { some: { id: feature.id } } } } });
        return { repository: r };
      })();
      const status = await runGit(["status", "--porcelain"], { cwd: repository.localPath });
      expect(status.stdout).toBe("");
      await trackAll();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("refuses POST on the island route (no mutation surface)", async () => {
    const { feature } = await seedWalk("post");
    const server = (await import("../src/ui/serve.js")).createUiServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    try {
      const res = await fetch(`http://localhost:${port}/run?feature=${feature.id}&view=island`, { method: "POST" });
      expect(res.status).toBe(405);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});

async function transitionWorkerForRelease(workerId: string): Promise<void> {
  const { transitionWorker } = await import("../src/core/service.js");
  // Walk the worker to terminal through valid edges (mirrors execution end).
  await transitionWorker(workerId, "RUNNING", db);
  await transitionWorker(workerId, "VERIFYING", db);
  await transitionWorker(workerId, "COMPLETED", db);
}
