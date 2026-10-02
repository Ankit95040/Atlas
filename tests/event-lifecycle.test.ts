import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getPrismaClient } from "../src/db/client.js";
import {
  createFeature,
  createProject,
  createRepository,
  createTask,
  transitionTask,
} from "../src/core/service.js";
import { createTaskClaims } from "../src/claims/index.js";
import { getCurrentCommit } from "../src/git/index.js";
import { runFeatureWaveLoop } from "../src/orchestrator/index.js";
import { FakeWorkerProvider } from "../src/workers/index.js";
import { track, uniqueName } from "./domain-helpers.js";
import { initTempRepo, makeTempDir } from "./git-helpers.js";

const db = getPrismaClient();

interface FlowSetup {
  readonly featureId: string;
  readonly taskIds: string[];
  readonly repoDir: string;
  readonly baseCommit: string;
  readonly scratchRoot: string;
  readonly repositoryId: string;
}

async function setupFlow(
  suffix: string,
  tasks: Array<{ key: string; claims: Array<{ resource: string; access: string }> }>,
): Promise<FlowSetup> {
  const repoDir = await initTempRepo();
  const project = await createProject({ name: uniqueName(`evt-proj-${suffix}`) });
  track("project", project.id);
  const repository = await createRepository({ projectId: project.id, name: "main", localPath: repoDir });
  track("repository", repository.id);
  const feature = await createFeature({ projectId: project.id, title: `evt-feat-${suffix}` });
  track("feature", feature.id);
  const taskIds: string[] = [];
  for (const def of tasks) {
    const task = await createTask({ featureId: feature.id, title: def.key });
    track("task", task.id);
    await transitionTask(task.id, "READY", db);
    await createTaskClaims({ taskId: task.id, claims: def.claims });
    taskIds.push(task.id);
  }
  const scratchRoot = await makeTempDir();
  return {
    featureId: feature.id,
    taskIds,
    repoDir,
    baseCommit: await getCurrentCommit(repoDir),
    scratchRoot,
    repositoryId: repository.id,
  };
}

interface FakeBehavior {
  readonly files?: Record<string, string>;
  readonly commitMessage?: string;
  readonly failWith?: string;
}

async function runLoop(setup: FlowSetup, behaviors: Record<string, FakeBehavior>, keys: string[]) {
  const keyById = new Map(setup.taskIds.map((id, i) => [id, keys[i] as string]));
  const result = await runFeatureWaveLoop(
    {
      featureId: setup.featureId,
      repositoryId: setup.repositoryId,
      baseCommit: setup.baseCommit,
      workspaceRoot: setup.scratchRoot,
      trainBranch: `atlas/evt/${uniqueName("train")}`,
      trainPath: join(setup.scratchRoot, "train"),
      approvalActor: "evt-test",
      testCommand: [process.execPath, "--eval", "process.exit(0);"],
      maxConcurrency: 4,
    },
    {
      createProvider: (taskId: string) => new FakeWorkerProvider(behaviors[keyById.get(taskId) ?? taskId] ?? {}),
      track,
    },
    db,
  );
  for (const row of await db.event.findMany({ where: { featureId: setup.featureId }, select: { id: true } })) {
    track("event", row.id);
  }
  return result;
}

async function eventTypes(featureId: string): Promise<Array<{ type: string; taskId: string | null }>> {
  const rows = await db.event.findMany({ where: { featureId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  return rows.map((row) => ({ type: row.type, taskId: row.taskId }));
}

function indexOfType(
  events: Array<{ type: string; taskId: string | null }>,
  type: string,
  taskId: string | null,
): number {
  return events.findIndex((e) => e.type === type && e.taskId === taskId);
}

describe("event lifecycle (M19.5)", () => {
  it("emits an ordered, duplicate-free lifecycle for a normal run", async () => {
    const setup = await setupFlow("full", [
      { key: "a", claims: [{ resource: "src/a.txt", access: "WRITE" }] },
      { key: "b", claims: [{ resource: "src/b.txt", access: "WRITE" }] },
    ]);
    const result = await runLoop(
      setup,
      {
        a: { files: { "src/a.txt": "a\n" }, commitMessage: "fake a" },
        b: { files: { "src/b.txt": "b\n" }, commitMessage: "fake b" },
      },
      ["a", "b"],
    );
    expect(result.train?.status).toBe("COMPLETED");

    const events = await eventTypes(setup.featureId);
    const types = events.map((e) => e.type);
    // Workflow opens before any scheduling; run closes last.
    expect(types.indexOf("WORKFLOW_STARTED")).toBeLessThan(
      Math.min(...setup.taskIds.map((id) => indexOfType(events, "TASK_SCHEDULED", id))),
    );
    expect(types[types.length - 1]).toBe("RUN_COMPLETED");
    // Per-task causal chains are ordered.
    for (const taskId of setup.taskIds) {
      const chain = [
        "TASK_CREATED",
        "TASK_SCHEDULED",
        "TASK_ASSIGNED",
        "TASK_STARTED",
        "TASK_COMPLETED",
        "TEST_STARTED",
        "TEST_PASSED",
        "VERIFICATION_STARTED",
        "VERIFICATION_COMPLETED",
      ];
      let cursor = -1;
      for (const type of chain) {
        const at = indexOfType(events, type, taskId);
        expect(at, `${type} for ${taskId}`).toBeGreaterThan(cursor);
        cursor = at;
      }
      // WORKER_ASSIGNED carries the task link too.
      expect(indexOfType(events, "WORKER_ASSIGNED", taskId)).toBeGreaterThan(-1);
    }
    // Integration brackets the train.
    expect(types).toContain("INTEGRATION_STARTED");
    expect(types).toContain("INTEGRATION_COMPLETED");
    expect(types.indexOf("INTEGRATION_STARTED")).toBeLessThan(types.indexOf("INTEGRATION_COMPLETED"));
    // No duplicate single-fire lifecycle events per task.
    for (const singleton of ["TASK_CREATED", "TASK_SCHEDULED", "TASK_STARTED", "TASK_COMPLETED"]) {
      for (const taskId of setup.taskIds) {
        expect(events.filter((e) => e.type === singleton && e.taskId === taskId)).toHaveLength(1);
      }
    }
    // Every event carries a timestamp and parseable payload.
    const rows = await db.event.findMany({ where: { featureId: setup.featureId } });
    for (const row of rows) {
      expect(row.createdAt).toBeInstanceOf(Date);
      if (row.payload !== null) {
        expect(() => JSON.parse(row.payload as string)).not.toThrow();
      }
    }
  });

  it("emits TASK_FAILED for a failed task and still completes the run", async () => {
    const setup = await setupFlow("fail", [{ key: "a", claims: [{ resource: "src/a.txt", access: "WRITE" }] }]);
    await runLoop(setup, { a: { failWith: "boom" } }, ["a"]);

    const events = await eventTypes(setup.featureId);
    const types = events.map((e) => e.type);
    expect(types).toContain("TASK_FAILED");
    expect(types).not.toContain("TASK_COMPLETED");
    expect(types[types.length - 1]).toBe("RUN_COMPLETED");
  });

  it("records empty-diff completion distinctly without verification or test events", async () => {
    const setup = await setupFlow("empty", [{ key: "a", claims: [{ resource: "src/a.txt", access: "WRITE" }] }]);
    const result = await runLoop(setup, { a: {} }, ["a"]);

    expect(result.outcomes[0]?.execution.status).toBe("COMPLETED_EMPTY");
    const events = await eventTypes(setup.featureId);
    const mine = events.filter((e) => e.taskId === setup.taskIds[0]);
    expect(mine.map((e) => e.type)).toContain("TASK_COMPLETED");
    expect(mine.map((e) => e.type)).not.toContain("TEST_STARTED");
    expect(mine.map((e) => e.type)).not.toContain("VERIFICATION_STARTED");
    // Nothing to integrate: no train, no integration events, run still completes.
    expect(result.train).toBeNull();
    expect(mine.map((e) => e.type)).not.toContain("INTEGRATION_STARTED");
    expect(events.map((e) => e.type).slice(-1)).toEqual(["RUN_COMPLETED"]);
  });

  it("is deterministic: identical flows yield identical event-type sequences", async () => {
    const sequences: string[][] = [];
    for (const suffix of ["det1", "det2"]) {
      const setup = await setupFlow(suffix, [{ key: "a", claims: [{ resource: "src/a.txt", access: "WRITE" }] }]);
      await runLoop(setup, { a: { files: { "src/a.txt": "a\n" }, commitMessage: "fake a" } }, ["a"]);
      const roleOf = new Map(setup.taskIds.map((id, i) => [id, `T${i}`]));
      sequences.push(
        (await eventTypes(setup.featureId)).map((e) => `${e.type}:${e.taskId === null ? "-" : (roleOf.get(e.taskId) ?? "?")}`),
      );
    }
    expect(sequences[0]).toEqual(sequences[1]);
  });

  it("emits PLAN_CREATED once per newly persisted plan", async () => {
    const project = await createProject({ name: uniqueName("evt-plan-proj") });
    track("project", project.id);
    const feature = await createFeature({ projectId: project.id, title: "evt-plan-feat" });
    track("feature", feature.id);
    const { runPlanCommand } = await import("../src/cli/plan.js");
    const dir = await makeTempDir();
    const proposalPath = join(dir, "proposal.json");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      proposalPath,
      JSON.stringify({
        featureId: feature.id,
        tasks: [{ id: "alpha", title: "Alpha", claims: [{ resource: "src/alpha.txt", access: "WRITE" }] }],
        dependencies: [],
      }),
    );
    await runPlanCommand({ featureId: feature.id, proposal: proposalPath }, db);
    for (const row of await db.event.findMany({ where: { featureId: feature.id }, select: { id: true } })) {
      track("event", row.id);
    }
    for (const row of await db.approval.findMany({ where: { featureId: feature.id }, select: { id: true } })) {
      track("approval", row.id);
    }
    const first = await db.event.findMany({ where: { featureId: feature.id, type: "PLAN_CREATED" } });
    expect(first).toHaveLength(1);
    // Re-running the same proposal reuses the plan: no duplicate event.
    await runPlanCommand({ featureId: feature.id, proposal: proposalPath }, db);
    const second = await db.event.findMany({ where: { featureId: feature.id, type: "PLAN_CREATED" } });
    expect(second).toHaveLength(1);
    for (const row of second) track("event", row.id);
    for (const task of await db.task.findMany({ where: { featureId: feature.id } })) track("task", task.id);
  });
});
