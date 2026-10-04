import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getPrismaClient } from "../src/db/client.js";
import { getCurrentCommit, runGit } from "../src/git/index.js";
import {
  createFeature,
  createProject,
  createRepository,
  createTask,
  transitionTask,
} from "../src/core/service.js";
import { createTaskClaims } from "../src/claims/index.js";
import { CommandWorkerProvider } from "../src/workers/index.js";
import { runFeatureWaveLoop, trackTaskEvidence } from "../src/orchestrator/index.js";
import { track, uniqueName } from "./domain-helpers.js";
import { makeTempDir } from "./git-helpers.js";

const db = getPrismaClient();
const AGENT = fileURLToPath(new URL("./fixtures/script-agent.mjs", import.meta.url));

async function setupPair() {
  const dir = await makeTempDir();
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "track-fixture", scripts: { test: "node -e \"process.exit(0)\"" } }));
  await writeFile(join(dir, "a.txt"), "seed\n");
  await runGit(["init", "-b", "main"], { cwd: dir });
  await runGit(["config", "user.email", "track-test@example.invalid"], { cwd: dir });
  await runGit(["config", "user.name", "Track Test"], { cwd: dir });
  await runGit(["add", "-A"], { cwd: dir });
  await runGit(["-c", "commit.gpgsign=false", "commit", "-m", "track fixture"], { cwd: dir });
  const baseCommit = await getCurrentCommit(dir);
  const project = await createProject({ name: uniqueName("track") }, db);
  track("project", project.id);
  const repository = await createRepository({ projectId: project.id, name: "main", localPath: dir }, db);
  track("repository", repository.id);
  const feature = await createFeature({ projectId: project.id, title: "track feature" }, db);
  track("feature", feature.id);
  const task = await createTask({ featureId: feature.id, title: "a" }, db);
  track("task", task.id);
  await transitionTask(task.id, "READY", db);
  await createTaskClaims({ taskId: task.id, claims: [{ resource: "a.txt", access: "WRITE" }] });
  return { dir, baseCommit, featureId: feature.id, repositoryId: repository.id };
}

function provider() {
  return new CommandWorkerProvider({
    command: [process.execPath, AGENT, "--write", "a.txt=a\n", "--commit", "agent write"],
  });
}

async function runOnce(useTrack: boolean) {
  const setup = await setupPair();
  const scratchRoot = await makeTempDir();
  const seen: Array<[string, string]> = [];
  const result = await runFeatureWaveLoop(
    {
      featureId: setup.featureId,
      repositoryId: setup.repositoryId,
      baseCommit: setup.baseCommit,
      workspaceRoot: scratchRoot,
      trainBranch: `atlas/track/${uniqueName("train")}`,
      trainPath: join(scratchRoot, "train"),
      approvalActor: "track-test",
      maxConcurrency: 4,
    },
    {
      createProvider: () => provider(),
      ...(useTrack ? { track: (model: string, id: string) => { seen.push([model, id]); track(model, id); } } : {}),
    },
    db,
  );
  if (!useTrack) {
    // The loop created worker/workspace/approval/evidence rows that no
    // tracker observed: collect them by feature for shared-DB cleanup.
    // (This is test hygiene only; production rows persist by design.)
    const tasks = await db.task.findMany({ where: { featureId: setup.featureId }, select: { id: true } });
    const ids = tasks.map((t) => t.id);
    for (const w of await db.worker.findMany({ where: { taskId: { in: ids } }, select: { id: true } })) {
      track("worker", w.id);
    }
    for (const w of await db.workspace.findMany({ where: { worker: { taskId: { in: ids } } }, select: { id: true } })) {
      track("workspace", w.id);
    }
    for (const a of await db.approval.findMany({ where: { taskId: { in: ids } }, select: { id: true } })) {
      track("approval", a.id);
    }
    for (const e of await db.event.findMany({ where: { taskId: { in: ids } }, select: { id: true } })) {
      track("event", e.id);
    }
    for (const t of await db.testRun.findMany({ where: { taskId: { in: ids } }, select: { id: true } })) {
      track("testRun", t.id);
    }
    for (const a of await db.artifact.findMany({ where: { taskId: { in: ids } }, select: { id: true } })) {
      track("artifact", a.id);
    }
    for (const c of await db.commit.findMany({ where: { taskId: { in: ids } }, select: { id: true } })) {
      track("commit", c.id);
    }
  }
  return { result, seen };
}

function shapeOf(result: Awaited<ReturnType<typeof runFeatureWaveLoop>>) {
  return {
    waves: result.waves.map((w) => w.length),
    outcomes: result.outcomes.map((o) => [o.execution.status, o.verification?.verdict ?? null, o.testRun?.status ?? null]),
    train: result.train === null ? null : result.train.status,
  };
}

type Counter = { count: number; restore: () => void; byModel?: Record<string, number> };

function countEvidenceQueries(): Counter & { byModel: Record<string, number> } {
  // Counts findMany calls on exactly the four models trackTaskEvidence
  // enumerates. Other loop queries (tasks, workers, approvals, …) use
  // different delegates and never touch this counter.
  const state = { count: 0 };
  const byModel: Record<string, number> = {};
  const originals = new Map<string, unknown>();
  for (const model of ["event", "testRun", "artifact", "commit"] as const) {
    const delegate = db[model] as unknown as Record<string, unknown>;
    const orig = delegate["findMany"];
    originals.set(model, orig);
    delegate["findMany"] = async (...args: unknown[]) => {
      state.count += 1;
      byModel[model] = (byModel[model] ?? 0) + 1;
      return (orig as (...a: unknown[]) => Promise<unknown[]>).call(delegate, ...args);
    };
  }
  return {
    get count() {
      return state.count;
    },
    byModel,
    restore() {
      for (const model of ["event", "testRun", "artifact", "commit"] as const) {
        (db[model] as unknown as Record<string, unknown>)["findMany"] = originals.get(model);
      }
    },
  };
}

// M29.1: skipping test-hygiene evidence enumeration without a tracker must
// not change orchestration outcomes. Parity across both paths, plus proof
// the tracked path still records evidence rows.
describe("untracked evidence skip (M29.1)", () => {
  it("eliminates exactly the evidence-enumeration queries when untracked", async () => {
    // Direct unit proof with a nonexistent task id: the four evidence
    // queries still execute (empty results) with a tracker, and zero run
    // without one. No rows created, nothing to clean up.
    const counter = countEvidenceQueries();
    try {
      const seen: Array<[string, string]> = [];
      await trackTaskEvidence(db, (model: string, id: string) => {
        seen.push([model, id]);
      }, ["task-that-does-not-exist"]);
      expect(counter.count).toBe(4);
      expect(seen).toEqual([]);
      await trackTaskEvidence(db, undefined, ["task-that-does-not-exist"]);
      expect(counter.count).toBe(4);
    } finally {
      counter.restore();
    }
  });

  it("produces identical outcomes with and without a tracker", async () => {
    const tracked = await runOnce(true);
    const untracked = await runOnce(false);
    expect(tracked.result.train?.status).toBe("COMPLETED");
    expect(shapeOf(untracked.result)).toEqual(shapeOf(tracked.result));
    // The tracked path still records evidence rows (hygiene intact).
    expect(tracked.seen.filter(([model]) => model === "event").length).toBeGreaterThan(0);
    expect(untracked.seen).toEqual([]);
  });
});
