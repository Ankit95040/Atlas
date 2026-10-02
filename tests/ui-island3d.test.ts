import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { disconnectDatabase, getPrismaClient } from "../src/db/client.js";
import {
  createApproval,
  createFeature,
  createProject,
  createRepository,
  createTask,
  createTaskDependency,
  createWorker,
  decideApproval,
  recordCommit,
  recordEvent,
  transitionTask,
} from "../src/core/service.js";
import { createTaskClaims } from "../src/claims/index.js";
import { assignTaskToWorker } from "../src/workspaces/index.js";
import { loadWorkflow } from "../src/ui/data.js";
import { buildIslandScene } from "../src/ui/island3d/scene.js";
import { createUiServer } from "../src/ui/serve.js";
import { track, uniqueName } from "./domain-helpers.js";
import { initTempRepo, trackTempPath } from "./git-helpers.js";

const db = getPrismaClient();

async function seed3d(suffix: string) {
  const repoDir = await initTempRepo();
  const project = await createProject({ name: uniqueName(`isl3-proj-${suffix}`) }, db);
  track("project", project.id);
  const repository = await createRepository({ projectId: project.id, name: "main", localPath: repoDir }, db);
  track("repository", repository.id);
  const feature = await createFeature({ projectId: project.id, title: `isl3-feat-${suffix}` }, db);
  track("feature", feature.id);
  const a = await createTask({ featureId: feature.id, title: "isl3-alpha" }, db);
  track("task", a.id);
  const b = await createTask({ featureId: feature.id, title: "isl3-beta" }, db);
  track("task", b.id);
  await createTaskClaims({ taskId: a.id, claims: [{ resource: "src/a.txt", access: "WRITE" }] });
  await createTaskClaims({ taskId: b.id, claims: [{ resource: "src/b.txt", access: "WRITE" }] });
  await createTaskDependency({ taskId: b.id, dependsOnTaskId: a.id }, db);
  const dep = await db.taskDependency.findFirstOrThrow({ where: { taskId: b.id } });
  track("taskDependency", dep.id);
  for (const t of [a, b]) {
    await transitionTask(t.id, "READY", db);
  }
  const scratch = trackTempPath(`/tmp/atlas-ui-isl3-${uniqueName(suffix)}`);
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
  await recordEvent(
    { type: "VERIFICATION_COMPLETED", featureId: feature.id, taskId: a.id, actor: "test", payload: { verdict: "VERIFIED", reasons: [], workerId: live.id } },
    db,
  );
  const commit = await recordCommit({ repositoryId: repository.id, sha: "abc1234def5678901234567890abcdef12345678", branch: `atlas/train-3d-${uniqueName("map")}`, subject: "atlas-train: integrate", taskId: a.id }, db);
  track("commit", commit.id);
  await recordEvent(
    { type: "INTEGRATION_COMPLETED", featureId: feature.id, actor: "test", payload: { trainBranch: "atlas/train-3d", status: "COMPLETED" } },
    db,
  );
  for (const row of await db.event.findMany({ where: { taskId: { in: [a.id, b.id] } }, select: { id: true } })) {
    track("event", row.id);
  }
  for (const row of await db.event.findMany({ where: { featureId: feature.id, taskId: null }, select: { id: true } })) {
    track("event", row.id);
  }
  return { feature, repository, taskA: a.id, taskB: b.id, liveId: live.id, histId: hist.id };
}

afterAll(async () => {
  await disconnectDatabase();
});

describe("3D scene descriptor (pure projection input)", () => {
  it("maps tasks, workers, paths, gates, cars, halt, and harbor from Atlas state", async () => {
    const { feature, taskA, taskB, liveId, histId } = await seed3d("map");
    const scene = buildIslandScene(await loadWorkflow(db, feature.id));
    expect(scene.runId).toBe(feature.id);
    expect(scene.buildings).toHaveLength(2);
    const byTask = new Map(scene.buildings.map((b) => [b.taskId, b]));
    expect(byTask.get(taskA)?.worker).toEqual({ id: liveId, status: "ASSIGNED", link: "live" });
    expect(byTask.get(taskB)?.worker).toEqual({ id: histId, status: "IDLE", link: "historical" });
    expect(scene.paths).toEqual([{ fromTaskId: taskA, toTaskId: taskB, satisfied: false }]);
    expect(scene.gates).toEqual([{ taskId: taskA, title: "isl3-alpha", verdict: "VERIFIED", reasons: [] }]);
    expect(scene.cars).toHaveLength(1);
    expect(scene.cars[0]).toMatchObject({ taskId: taskA, order: 0 });
    expect(scene.cars[0]?.sha).toHaveLength(40);
    expect(scene.halt).toBeNull();
    expect(scene.harbor).toEqual({ branch: "main" });
    expect(scene.phases.map((p) => p.name)).toContain("MERGE");
    expect(typeof scene.seed).toBe("number");
  });

  it("is deterministic and invents nothing", async () => {
    const { feature, taskA, taskB } = await seed3d("det");
    const graph = await loadWorkflow(db, feature.id);
    const first = buildIslandScene(graph);
    const second = buildIslandScene(graph);
    expect(second).toEqual(first);
    const known = new Set([taskA, taskB, ...(await db.worker.findMany({ where: { task: { featureId: feature.id } }, select: { id: true } })).map((w) => w.id)]);
    for (const row of await db.event.findMany({ where: { featureId: feature.id }, select: { payload: true } })) {
      try {
        const wid = (JSON.parse(row.payload ?? "") as { workerId?: unknown }).workerId;
        if (typeof wid === "string") {
          known.add(wid);
        }
      } catch {
        // Ignore.
      }
    }
    const ids = new Set<string>();
    for (const b of first.buildings) {
      ids.add(b.taskId);
      if (b.worker !== null) {
        ids.add(b.worker.id);
      }
    }
    for (const id of ids) {
      expect(known.has(id), `invented id ${id}`).toBe(true);
    }
    // Unknown future states pass through untouched.
    expect(first.buildings.find((b) => b.taskId === taskA)?.status).toBe("CLAIMED");
  });

  it("represents halt and empty runs truthfully", async () => {
    const { feature, repository, taskA } = await seed3d("halt");
    // Unique branch per run: branch names are global, so a fixed name would
    // collide with leaked rows from earlier runs and poison status lookups.
    const branch = `atlas/train-3d-${uniqueName("halt")}`;
    const commit = await recordCommit({ repositoryId: repository.id, sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", branch, subject: "x", taskId: taskA }, db);
    track("commit", commit.id);
    await recordEvent(
      { type: "INTEGRATION_FAILED", featureId: feature.id, actor: "test", payload: { trainBranch: branch, status: "HALTED", haltReason: "boom" } },
      db,
    );
    for (const row of await db.event.findMany({ where: { featureId: feature.id, taskId: null }, select: { id: true } })) {
      track("event", row.id);
    }
    const halted = buildIslandScene(await loadWorkflow(db, feature.id));
    expect(halted.halt).toEqual({ reason: "boom" });
    const emptyFeat = await (async () => {
      const project = await createProject({ name: uniqueName("isl3-empty") }, db);
      track("project", project.id);
      const feat = await createFeature({ projectId: project.id, title: "empty" }, db);
      track("feature", feat.id);
      return feat;
    })();
    const empty = buildIslandScene(await loadWorkflow(db, emptyFeat.id));
    expect(empty.buildings).toEqual([]);
    expect(empty.paths).toEqual([]);
    expect(empty.cars).toEqual([]);
    expect(empty.halt).toBeNull();
    void taskA;
  });
});

describe("3D route, fallback, and isolation", () => {
  it("serves mode=3d with payload, fallback, and text table; default island unchanged", async () => {
    const { feature } = await seed3d("route");
    const server = createUiServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    try {
      const res = await fetch(`http://localhost:${port}/run?feature=${feature.id}&view=island&mode=3d`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('"imports"');
      expect(html).toContain("/ui-static/three-build/three.module.js");
      expect(html).toContain("/ui-static/island3d-client.js");
      expect(html).toContain('id="island3d-data"');
      expect(html).toContain("isl3-alpha");
      expect(html).toContain('id="island3d-fallback"');
      expect(html).toContain("Island nodes (text equivalent)");
      expect(html).toContain("flat Island");
      const flat = await (await fetch(`http://localhost:${port}/run?feature=${feature.id}&view=island`)).text();
      expect(flat).not.toContain("three.module.js");
      expect(flat).toContain("ATLAS ISLAND");
      // Vendor + client static files serve as JavaScript.
      for (const path of ["/ui-static/three-build/three.module.js", "/ui-static/three-build/three.core.js", "/ui-static/OrbitControls.js", "/ui-static/island3d-client.js", "/ui-static/transitions.js"]) {
        const file = await fetch(`http://localhost:${port}${path}`);
        expect(file.status, path).toBe(200);
        expect(file.headers.get("content-type")).toContain("application/javascript");
      }
      expect((await fetch(`http://localhost:${port}/ui-static/../../package.json`)).status).toBe(404);
      expect((await fetch(`http://localhost:${port}/ui-static/three-build/three.module.js`, { method: "POST" })).status).toBe(405);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});

describe("3D discipline (static enforcement)", () => {
  it("keeps the projector free of state, network, and orchestration", () => {
    for (const file of ["scene.ts", "view.ts", "client.ts"]) {
      const source = readFileSync(join(import.meta.dirname, "..", "src", "ui", "island3d", file), "utf8");
      expect(source, `${file} mutates`).not.toMatch(/\bdb\.\w+\.(create|update|delete|upsert)\(|\.(createMany|updateMany|deleteMany)\(|\$transaction\(|\$executeRaw|\$queryRaw/);
      expect(source, `${file} reads env`).not.toContain("process.env");
    }
    const client = readFileSync(join(import.meta.dirname, "..", "src", "ui", "island3d", "client.ts"), "utf8");
    for (const banned of ["fetch(", "WebSocket", "XMLHttpRequest", "EventSource", "localStorage", "indexedDB"]) {
      expect(client, `client uses ${banned}`).not.toContain(banned);
    }
    for (const mod of ["../scheduler", "../workers/", "../verification/", "../orchestrator/", "../benchmark/", "react", "pixi", "phaser", "@react-three"]) {
      expect(client, `client depends on ${mod}`).not.toContain(mod);
    }
    const scene = readFileSync(join(import.meta.dirname, "..", "src", "ui", "island3d", "scene.ts"), "utf8");
    for (const mod of ["../scheduler", "../workers/", "../verification/", "../orchestrator/", "../benchmark/"]) {
      expect(scene, `scene depends on ${mod}`).not.toContain(mod);
    }
  });
});

describe("visual transition model (pure, deterministic)", () => {
  const baseScene = (): import("../src/ui/island3d/scene.js").IslandScene => ({
    runId: "r",
    runTitle: "T",
    runStatus: "IN_PROGRESS",
    seed: 7,
    bounds: { cols: 2, rows: 1 },
    buildings: [
      { taskId: "a", title: "A", status: "IN_PROGRESS", level: 0, col: 0, x: 0, z: 0, wave: 1, verdict: null, integrated: false, dependsOn: [], worker: { id: "w1", status: "RUNNING", link: "live" } },
      { taskId: "b", title: "B", status: "READY", level: 0, col: 1, x: 6, z: 0, wave: 1, verdict: null, integrated: false, dependsOn: [], worker: null },
    ],
    paths: [],
    gates: [],
    cars: [],
    halt: null,
    harbor: { branch: "main" },
    phases: [],
    waves: [],
  });

  it("emits nothing for identical scenes or first render", async () => {
    const { diffIslandScenes } = await import("../src/ui/island3d/transitions.js");
    const scene = baseScene();
    expect(diffIslandScenes(scene, structuredClone(scene))).toEqual([]);
    expect(diffIslandScenes(null, scene)).toEqual([]);
  });

  it("derives worker, state, verification, car, and halt transitions in priority order", async () => {
    const { diffIslandScenes } = await import("../src/ui/island3d/transitions.js");
    const prev = baseScene();
    const progressed = baseScene();
    const bBuilding = progressed.buildings[1];
    if (bBuilding === undefined) {
      throw new Error("fixture needs two buildings");
    }
    progressed.buildings[1] = { ...bBuilding, status: "IN_PROGRESS", worker: { id: "w2", status: "RUNNING", link: "live" } };
    progressed.gates.push({ taskId: "a", title: "A", verdict: "VERIFIED", reasons: [] });
    const aBuilding = progressed.buildings[0];
    if (aBuilding === undefined) {
      throw new Error("fixture needs an alpha building");
    }
    progressed.buildings[0] = { ...aBuilding, status: "COMPLETED", verdict: "VERIFIED", integrated: true };
    progressed.cars.push({ taskId: "a", title: "A", sha: "abc123", subject: "m", order: 0 });
    progressed.halt = { reason: "stuck" };
    const list = diffIslandScenes(prev, progressed);
    const kinds = list.map((t) => t.kind);
    expect(kinds).toEqual(["WORKER_ENTER", "TASK_STATE_CHANGE", "TASK_STATE_CHANGE", "VERIFICATION_CHANGE", "MERGE_CAR_ENTER", "HALT_CHANGE"]);
    expect(list[0]).toMatchObject({ entityId: "w2", from: "absent" });
    expect(list.find((t) => t.kind === "HALT_CHANGE")).toMatchObject({ entityId: "halt", to: "stuck" });
    // Priorities strictly non-decreasing (deterministic budget order).
    const pris = list.map((t) => t.priority);
    expect([...pris].sort((x, y) => x - y)).toEqual(pris);
  });

  it("never invents cars, workers, or dependencies and keeps history visible", async () => {
    const { diffIslandScenes } = await import("../src/ui/island3d/transitions.js");
    const prev = baseScene();
    const done = {
      ...baseScene(),
      buildings: baseScene().buildings.map((b) => ({ ...b, status: "COMPLETED", worker: null })),
    };
    // Release without task change: no motion, figure simply renders historical.
    expect(diffIslandScenes(prev, done)).toEqual([
      expect.objectContaining({ kind: "TASK_STATE_CHANGE", entityId: "a" }),
      expect.objectContaining({ kind: "TASK_STATE_CHANGE", entityId: "b" }),
    ]);
    // Completion without integration: no car.
    expect(diffIslandScenes(prev, done).some((t) => t.kind === "MERGE_CAR_ENTER")).toBe(false);
  });

  it("orders ties by entity id and exposes durations", async () => {
    const { diffIslandScenes, TRANSITION_MS } = await import("../src/ui/island3d/transitions.js");
    const prev = baseScene();
    const next = baseScene();
    next.buildings = next.buildings.map((b) => ({ ...b, status: "FAILED" }));
    const list = diffIslandScenes(prev, next);
    expect(list.map((t) => t.entityId)).toEqual(["a", "b"]);
    expect(TRANSITION_MS.WORKER_ENTER).toBe(300);
    expect(TRANSITION_MS.TASK_STATE_CHANGE).toBe(200);
    expect(TRANSITION_MS.MERGE_CAR_ENTER).toBe(400);
    expect(TRANSITION_MS.HALT_CHANGE).toBe(600);
    expect(Math.max(...Object.values(TRANSITION_MS))).toBeLessThanOrEqual(600);
  });
});

describe("3D click navigation (existing routes only)", () => {
  it("tags pickable entities and routes clicks to detail views", () => {
    const source = readFileSync(join(import.meta.dirname, "..", "src", "ui", "island3d", "client.ts"), "utf8");
    // Every interactive kind carries a navigation target on existing routes.
    for (const kind of ["task", "worker", "gate", "car", "halt", "tower", "harbor"]) {
      expect(source, `missing entity tag: ${kind}`).toContain(`kind: "${kind}"`);
    }
    expect(source).toContain("view=tasks#task-");
    expect(source).toContain("view=workers#worker-");
    expect(source).toContain("view=verification");
    expect(source).toContain("view=train");
    expect(source).toContain("view=overview");
    // Clicks require a press without drag; hover only changes the cursor.
    expect(source).toContain("pointerdown");
    expect(source).toContain("pointerup");
    expect(source).toContain("cursor");
    // No navigation outside existing run routes, no mutations.
    const assigns = [...source.matchAll(/window\.location\.assign\(([^)]+)\)/g)].map((m) => m[1]);
    expect(assigns.length).toBeGreaterThan(0);
    for (const target of assigns) {
      expect(target).toBe("route");
    }
  });
});

describe("3D module graph (M25.3 blank-canvas regression)", () => {
  it("resolves every client import through the page importmap to served files", async () => {
    const { feature } = await (async () => {
      const { initTempRepo } = await import("./git-helpers.js");
      const { createProject, createFeature } = await import("../src/core/service.js");
      const { getPrismaClient } = await import("../src/db/client.js");
      const { track, uniqueName } = await import("./domain-helpers.js");
      await initTempRepo();
      const db = getPrismaClient();
      const project = await createProject({ name: uniqueName("isl3-modgraph") }, db);
      track("project", project.id);
      const feat = await createFeature({ projectId: project.id, title: "modgraph" }, db);
      track("feature", feat.id);
      return { feature: feat };
    })();
    const server = (await import("../src/ui/serve.js")).createUiServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    try {
      const html = await (await fetch(`http://localhost:${port}/run?feature=${feature.id}&view=island&mode=3d`)).text();
      const mapMatch = html.match(/<script type="importmap">(.*?)<\/script>/s);
      expect(mapMatch?.[1], "importmap present").toBeDefined();
      const importmap = JSON.parse(mapMatch?.[1] ?? "{}") as { imports: Record<string, string> };
      const resolve = (specifier: string): string => {
        for (const [prefix, target] of Object.entries(importmap.imports)) {
          if (specifier === prefix || (prefix.endsWith("/") && specifier.startsWith(prefix))) {
            return specifier === prefix ? target : target + specifier.slice(prefix.length);
          }
        }
        throw new Error(`unmapped specifier: ${specifier}`);
      };
      // Every static module the page pulls, plus every bare/relative import
      // inside the served client, must resolve to a served file.
      const moduleSrcs = [...html.matchAll(/<script type="module" src="([^"]+)">/g)].map((m) => m[1] as string);
      expect(moduleSrcs).toContain("/ui-static/island3d-client.js");
      const checked = new Set<string>();
      const queue: Array<{ path: string; from: string }> = moduleSrcs.map((path) => ({ path, from: "/" }));
      while (queue.length > 0) {
        const { path, from } = queue.pop() as { path: string; from: string };
        if (checked.has(path)) {
          continue;
        }
        checked.add(path);
        const res = await fetch(`http://localhost:${port}${path}`);
        expect(res.status, `serves ${path} (via ${from})`).toBe(200);
        expect(res.headers.get("content-type")).toContain("application/javascript");
        const body = await res.text();
        for (const match of body.matchAll(/from\s+["']([^"']+)["']/g)) {
          const spec = match[1] as string;
          if (spec.startsWith("three/") || spec === "three") {
            queue.push({ path: resolve(spec), from: path });
          } else if (spec.startsWith("./") || spec.startsWith("../")) {
            // Resolve against the importing file's directory, like a browser.
            const base = path.slice(0, path.lastIndexOf("/") + 1);
            const parts = (base + spec).split("/");
            const stack: string[] = [];
            for (const part of parts) {
              if (part === "..") {
                stack.pop();
              } else if (part !== ".") {
                stack.push(part);
              }
            }
            queue.push({ path: stack.join("/"), from: path });
          }
        }
      }
      expect([...checked]).toContain("/ui-static/three-build/three.module.js");
      // Traversal and wrong-dir probes stay 404.
      expect((await fetch(`http://localhost:${port}/ui-static/three-build/package.json`)).status).toBe(404);
      expect((await fetch(`http://localhost:${port}/ui-static/three-build/`)).status).toBe(404);
      // The readiness flag + error trap close the silent-blank failure mode.
      expect(html).toContain("__atlasIsland3dReady");
      expect(html).toContain('id="island3d-fallback"');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("never caches HTML or errors, and versions vendor bytes immutably", async () => {
    // M25.3 blank-canvas incident: heuristically cached HTML (stale import
    // map) and cached 404s kept a fixed deployment broken in real browsers.
    // Pages and errors are no-store; pinned vendor bytes are immutable.
    const { feature } = await (async () => {
      const { initTempRepo } = await import("./git-helpers.js");
      const { createProject, createFeature } = await import("../src/core/service.js");
      const { getPrismaClient } = await import("../src/db/client.js");
      const { track, uniqueName } = await import("./domain-helpers.js");
      await initTempRepo();
      const db = getPrismaClient();
      const project = await createProject({ name: uniqueName("isl3-cache") }, db);
      track("project", project.id);
      const feat = await createFeature({ projectId: project.id, title: "cache" }, db);
      track("feature", feat.id);
      return { feature: feat };
    })();
    const server = (await import("../src/ui/serve.js")).createUiServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    try {
      const page = await fetch(`http://localhost:${port}/run?feature=${feature.id}&view=island&mode=3d`);
      expect(page.headers.get("cache-control")).toContain("no-store");
      const missing = await fetch(`http://localhost:${port}/ui-static/three-build/definitely-not-here.js`);
      expect(missing.status).toBe(404);
      expect(missing.headers.get("cache-control")).toContain("no-store");
      const vendor = await fetch(`http://localhost:${port}/ui-static/three-build/three.core.js`);
      expect(vendor.headers.get("cache-control")).toContain("immutable");
      const own = await fetch(`http://localhost:${port}/ui-static/island3d-client.js`);
      expect(own.headers.get("cache-control")).toContain("no-store");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
