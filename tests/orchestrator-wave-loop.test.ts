import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getPrismaClient } from "../src/db/client.js";
import { getCurrentCommit, isClean, runGit } from "../src/git/index.js";
import {
  createFeature,
  createProject,
  createRepository,
  createTask,
  createTaskDependency,
  transitionTask,
} from "../src/core/service.js";
import { createTaskClaims } from "../src/claims/index.js";
import { CommandWorkerProvider, FakeWorkerProvider } from "../src/workers/index.js";
import { runFeatureWaveLoop } from "../src/orchestrator/index.js";
import { track, uniqueName } from "./domain-helpers.js";
import { makeTempDir } from "./git-helpers.js";

const db = getPrismaClient();
const AGENT = fileURLToPath(new URL("./fixtures/script-agent.mjs", import.meta.url));

interface TaskDef {
  readonly key: string;
  readonly claims: ReadonlyArray<{ resource: string; access: "READ" | "WRITE" }>;
  readonly dependsOn?: readonly string[];
}

interface LoopFixture {
  readonly repoDir: string;
  readonly baseCommit: string;
  readonly featureId: string;
  readonly repositoryId: string;
  readonly taskIds: Map<string, string>;
  readonly scratchRoot: string;
}

/** Cumulative check: every present file must hold allowed content; absent files pass. */
function checkScript(allowed: Record<string, string[]>): string {
  const cases = Object.entries(allowed)
    .map(([rel, contents]) => {
      const list = contents.map((c) => JSON.stringify(c)).join(", ");
      return `assertAllowed(${JSON.stringify(rel)}, [${list}]);`;
    })
    .join("\n");
  return `import { existsSync, readFileSync } from "node:fs";
function assertAllowed(rel, allowed) {
  if (!existsSync(rel)) return;
  const actual = readFileSync(rel, "utf8");
  if (!allowed.includes(actual)) {
    console.error("unexpected content in " + rel + ": " + JSON.stringify(actual));
    process.exit(1);
  }
}
${cases}
process.exit(0);
`;
}

async function initLoopRepo(baseFiles: Record<string, string>, check: string): Promise<{ repoDir: string; baseCommit: string }> {
  const dir = await makeTempDir();
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "m11-fixture", scripts: { test: "node check.mjs" } }));
  await writeFile(join(dir, "check.mjs"), check);
  for (const [rel, content] of Object.entries(baseFiles)) {
    const absolute = join(dir, rel);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
  await runGit(["init", "-b", "main"], { cwd: dir });
  await runGit(["config", "user.email", "m11-test@example.invalid"], { cwd: dir });
  await runGit(["config", "user.name", "M11 Test"], { cwd: dir });
  await runGit(["add", "-A"], { cwd: dir });
  await runGit(["-c", "commit.gpgsign=false", "commit", "-m", "m11 fixture"], { cwd: dir });
  return { repoDir: dir, baseCommit: await getCurrentCommit(dir) };
}

async function setupLoopFeature(repoDir: string, defs: TaskDef[]): Promise<Omit<LoopFixture, "repoDir" | "baseCommit" | "scratchRoot"> & { scratchRoot: string }> {
  const project = await createProject({ name: uniqueName("m11-loop"), description: "wave loop test" }, db);
  track("project", project.id);
  const repository = await createRepository({ projectId: project.id, name: "main", localPath: repoDir }, db);
  track("repository", repository.id);
  const feature = await createFeature({ projectId: project.id, title: "loop feature" }, db);
  track("feature", feature.id);
  const taskIds = new Map<string, string>();
  for (const def of defs) {
    const task = await createTask({ featureId: feature.id, title: def.key }, db);
    track("task", task.id);
    await transitionTask(task.id, "READY", db);
    await createTaskClaims(
      { taskId: task.id, claims: def.claims.map((claim) => ({ resource: claim.resource, access: claim.access })) },
      db,
    );
    taskIds.set(def.key, task.id);
  }
  for (const def of defs) {
    for (const dep of def.dependsOn ?? []) {
      const edge = await createTaskDependency({ taskId: taskIds.get(def.key) as string, dependsOnTaskId: taskIds.get(dep) as string }, db);
      track("taskDependency", edge.id);
    }
  }
  return { featureId: feature.id, repositoryId: repository.id, taskIds, scratchRoot: await makeTempDir() };
}

interface AgentBehavior {
  readonly args: string[];
  readonly timeoutMs?: number;
}

function providersFor(taskIds: Map<string, string>, behaviors: Record<string, AgentBehavior>) {
  return (taskId: string): CommandWorkerProvider => {
    const key = [...taskIds.entries()].find(([, id]) => id === taskId)?.[0];
    const behavior = key !== undefined ? behaviors[key] : undefined;
    if (behavior === undefined) {
      throw new Error(`no script-agent behavior for task ${taskId}`);
    }
    return new CommandWorkerProvider({
      command: [process.execPath, AGENT, ...behavior.args],
      ...(behavior.timeoutMs !== undefined ? { timeoutMs: behavior.timeoutMs } : {}),
    });
  };
}

async function trackLoopEvents(taskIds: Iterable<string>): Promise<void> {
  for (const taskId of taskIds) {
    for (const row of await db.event.findMany({ where: { taskId } })) track("event", row.id);
  }
}

async function workspaceOf(workerId: string): Promise<string> {
  const worker = await db.worker.findUniqueOrThrow({ where: { id: workerId }, include: { workspace: true } });
  const path = worker.workspace?.path;
  if (path === undefined) {
    throw new Error(`worker ${workerId} has no workspace`);
  }
  return path;
}

describe("feature wave-run loop", () => {
  it("runs one real subprocess task end to end through the merge train", async () => {
    const { repoDir, baseCommit } = await initLoopRepo({}, checkScript({ "src/a.txt": ["a\n"] }));
    const setup = await setupLoopFeature(repoDir, [{ key: "a", claims: [{ resource: "src/a.txt", access: "WRITE" }] }]);

    const result = await runFeatureWaveLoop(
      {
        featureId: setup.featureId,
        repositoryId: setup.repositoryId,
        baseCommit,
        workspaceRoot: setup.scratchRoot,
        trainBranch: `atlas/m11/${uniqueName("train")}`,
        trainPath: join(setup.scratchRoot, "train"),
        approvalActor: "m11-test",
        testCommand: ["node", "check.mjs"],
        maxConcurrency: 4,
      },
      { createProvider: providersFor(setup.taskIds, { a: { args: ["--write", "src/a.txt=a\n", "--commit", "agent a"] } }), track },
      db,
    );
    await trackLoopEvents(setup.taskIds.values());

    expect(result.waves).toHaveLength(1);
    expect(result.outcomes).toHaveLength(1);
    const outcome = result.outcomes[0] as (typeof result.outcomes)[number];
    expect(outcome.execution.status).toBe("COMPLETED");
    expect(outcome.testRun?.status).toBe("PASSED");
    expect(outcome.verification?.verdict).toBe("VERIFIED");
    expect(result.train?.status).toBe("COMPLETED");
    expect(result.train?.items).toHaveLength(1);
    expect(result.train?.items[0]?.status).toBe("INTEGRATED");
    expect(await getCurrentCommit(repoDir)).toBe(baseCommit);
  }, 180000);

  it("executes independent tasks concurrently in a single wave", async () => {
    const { repoDir, baseCommit } = await initLoopRepo(
      {},
      checkScript({ "src/a.txt": ["a\n"], "src/b.txt": ["b\n"] }),
    );
    const setup = await setupLoopFeature(repoDir, [
      { key: "a", claims: [{ resource: "src/a.txt", access: "WRITE" }] },
      { key: "b", claims: [{ resource: "src/b.txt", access: "WRITE" }] },
    ]);

    const result = await runFeatureWaveLoop(
      {
        featureId: setup.featureId,
        repositoryId: setup.repositoryId,
        baseCommit,
        workspaceRoot: setup.scratchRoot,
        trainBranch: `atlas/m11/${uniqueName("train")}`,
        trainPath: join(setup.scratchRoot, "train"),
        approvalActor: "m11-test",
        testCommand: ["node", "check.mjs"],
        maxConcurrency: 4,
      },
      {
        createProvider: providersFor(setup.taskIds, {
          a: { args: ["--write", "src/a.txt=a\n", "--commit", "agent a"] },
          b: { args: ["--write", "src/b.txt=b\n", "--commit", "agent b"] },
        }),
        track,
      },
      db,
    );
    await trackLoopEvents(setup.taskIds.values());

    expect(result.waves).toHaveLength(1);
    expect(result.waves[0]).toHaveLength(2);
    expect(result.outcomes.map((o) => o.verification?.verdict)).toEqual(["VERIFIED", "VERIFIED"]);
    expect(result.train?.status).toBe("COMPLETED");
    expect(result.train?.items.filter((i) => i.status === "INTEGRATED")).toHaveLength(2);
  }, 180000);

  it("schedules dependency chains across multiple waves via re-planning", async () => {
    const { repoDir, baseCommit } = await initLoopRepo(
      {},
      checkScript({ "src/a.txt": ["a\n"], "src/b.txt": ["b\n"] }),
    );
    const setup = await setupLoopFeature(repoDir, [
      { key: "a", claims: [{ resource: "src/a.txt", access: "WRITE" }] },
      { key: "b", claims: [{ resource: "src/b.txt", access: "WRITE" }], dependsOn: ["a"] },
    ]);

    const result = await runFeatureWaveLoop(
      {
        featureId: setup.featureId,
        repositoryId: setup.repositoryId,
        baseCommit,
        workspaceRoot: setup.scratchRoot,
        trainBranch: `atlas/m11/${uniqueName("train")}`,
        trainPath: join(setup.scratchRoot, "train"),
        approvalActor: "m11-test",
        testCommand: ["node", "check.mjs"],
        maxConcurrency: 4,
      },
      {
        createProvider: providersFor(setup.taskIds, {
          a: { args: ["--write", "src/a.txt=a\n", "--commit", "agent a"] },
          b: { args: ["--write", "src/b.txt=b\n", "--commit", "agent b"] },
        }),
        track,
      },
      db,
    );
    await trackLoopEvents(setup.taskIds.values());

    expect(result.waves).toHaveLength(2);
    const aId = setup.taskIds.get("a") as string;
    const bId = setup.taskIds.get("b") as string;
    expect(result.waves[0]).toEqual([aId]);
    expect(result.waves[1]).toEqual([bId]);
    expect(result.train?.status).toBe("COMPLETED");
  }, 180000);

  it("records claim violations as outcomes without throwing", async () => {
    const { repoDir, baseCommit } = await initLoopRepo({}, checkScript({ "src/ok.txt": ["ok\n"] }));
    const setup = await setupLoopFeature(repoDir, [{ key: "bad", claims: [{ resource: "src/ok.txt", access: "WRITE" }] }]);

    const result = await runFeatureWaveLoop(
      {
        featureId: setup.featureId,
        repositoryId: setup.repositoryId,
        baseCommit,
        workspaceRoot: setup.scratchRoot,
        trainBranch: `atlas/m11/${uniqueName("train")}`,
        trainPath: join(setup.scratchRoot, "train"),
        approvalActor: "m11-test",
        testCommand: ["node", "check.mjs"],
        maxConcurrency: 4,
      },
      { createProvider: providersFor(setup.taskIds, { bad: { args: ["--write", "src/evil.txt=x\n", "--commit", "evil"] } }), track },
      db,
    );
    await trackLoopEvents(setup.taskIds.values());

    expect(result.waves).toHaveLength(1);
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0]?.execution.status).toBe("CLAIM_VIOLATION");
    expect(result.outcomes[0]?.testRun).toBeNull();
    expect(result.outcomes[0]?.verification).toBeNull();
    expect(result.train).toBeNull();
  }, 180000);

  it("records worker command failures as outcomes", async () => {
    const { repoDir, baseCommit } = await initLoopRepo({}, checkScript({ "src/a.txt": ["a\n"] }));
    const setup = await setupLoopFeature(repoDir, [{ key: "a", claims: [{ resource: "src/a.txt", access: "WRITE" }] }]);

    const result = await runFeatureWaveLoop(
      {
        featureId: setup.featureId,
        repositoryId: setup.repositoryId,
        baseCommit,
        workspaceRoot: setup.scratchRoot,
        trainBranch: `atlas/m11/${uniqueName("train")}`,
        trainPath: join(setup.scratchRoot, "train"),
        approvalActor: "m11-test",
        testCommand: ["node", "check.mjs"],
        maxConcurrency: 4,
      },
      { createProvider: providersFor(setup.taskIds, { a: { args: ["--fail", "agent exploded"] } }), track },
      db,
    );
    await trackLoopEvents(setup.taskIds.values());

    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0]?.execution.status).toBe("FAILED");
    expect(result.train).toBeNull();
  }, 180000);

  it("records subprocess timeouts as outcomes", async () => {
    const { repoDir, baseCommit } = await initLoopRepo({}, checkScript({ "src/a.txt": ["a\n"] }));
    const setup = await setupLoopFeature(repoDir, [{ key: "a", claims: [{ resource: "src/a.txt", access: "WRITE" }] }]);

    const result = await runFeatureWaveLoop(
      {
        featureId: setup.featureId,
        repositoryId: setup.repositoryId,
        baseCommit,
        workspaceRoot: setup.scratchRoot,
        trainBranch: `atlas/m11/${uniqueName("train")}`,
        trainPath: join(setup.scratchRoot, "train"),
        approvalActor: "m11-test",
        testCommand: ["node", "check.mjs"],
        maxConcurrency: 4,
      },
      { createProvider: providersFor(setup.taskIds, { a: { args: ["--sleep", "15000"], timeoutMs: 1500 } }), track },
      db,
    );
    await trackLoopEvents(setup.taskIds.values());

    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0]?.execution.status).toBe("FAILED");
    expect(result.train).toBeNull();
  }, 180000);

  it("leaves dependents blocked when a task's tests fail, integrating only verified work", async () => {
    const { repoDir, baseCommit } = await initLoopRepo(
      {},
      checkScript({ "src/good.txt": ["good\n"], "src/bad.txt": ["bad\n"] }),
    );
    const setup = await setupLoopFeature(repoDir, [
      { key: "good", claims: [{ resource: "src/good.txt", access: "WRITE" }] },
      { key: "bad", claims: [{ resource: "src/bad.txt", access: "WRITE" }] },
      { key: "child", claims: [{ resource: "src/child.txt", access: "WRITE" }], dependsOn: ["bad"] },
    ]);

    const result = await runFeatureWaveLoop(
      {
        featureId: setup.featureId,
        repositoryId: setup.repositoryId,
        baseCommit,
        workspaceRoot: setup.scratchRoot,
        trainBranch: `atlas/m11/${uniqueName("train")}`,
        trainPath: join(setup.scratchRoot, "train"),
        approvalActor: "m11-test",
        testCommand: ["node", "check.mjs"],
        maxConcurrency: 4,
      },
      {
        createProvider: providersFor(setup.taskIds, {
          good: { args: ["--write", "src/good.txt=good\n", "--commit", "good"] },
          bad: { args: ["--write", "src/bad.txt=WRONG\n", "--commit", "bad"] },
          child: { args: ["--write", "src/child.txt=child\n", "--commit", "child"] },
        }),
        track,
      },
      db,
    );
    await trackLoopEvents(setup.taskIds.values());

    const byKey = new Map(result.outcomes.map((o) => [[...setup.taskIds.entries()].find(([, id]) => id === o.taskId)?.[0], o]));
    expect(byKey.get("good")?.verification?.verdict).toBe("VERIFIED");
    expect(byKey.get("bad")?.testRun?.status).toBe("FAILED");
    // The dependent never ran: its prerequisite never completed.
    expect(byKey.has("child")).toBe(false);
    expect((await db.task.findUniqueOrThrow({ where: { id: setup.taskIds.get("child") } })).status).toBe("READY");
    // Only verified work integrates.
    expect(result.train?.status).toBe("COMPLETED");
    expect(result.train?.items).toHaveLength(1);
  }, 180000);

  it("rejects verification when the cited Atlas test run did not pass", async () => {
    const { repoDir, baseCommit } = await initLoopRepo({}, checkScript({ "src/a.txt": ["a\n"] }));
    const setup = await setupLoopFeature(repoDir, [{ key: "a", claims: [{ resource: "src/a.txt", access: "WRITE" }] }]);

    const result = await runFeatureWaveLoop(
      {
        featureId: setup.featureId,
        repositoryId: setup.repositoryId,
        baseCommit,
        workspaceRoot: setup.scratchRoot,
        trainBranch: `atlas/m11/${uniqueName("train")}`,
        trainPath: join(setup.scratchRoot, "train"),
        approvalActor: "m11-test",
        testCommand: ["node", "check.mjs"],
        maxConcurrency: 4,
      },
      { createProvider: providersFor(setup.taskIds, { a: { args: ["--write", "src/a.txt=WRONG\n", "--commit", "wrong"] } }), track },
      db,
    );
    await trackLoopEvents(setup.taskIds.values());

    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0]?.execution.status).toBe("COMPLETED");
    expect(result.outcomes[0]?.testRun?.status).toBe("FAILED");
    expect(result.outcomes[0]?.verification?.verdict).toBe("REJECTED");
    expect(result.outcomes[0]?.verification?.reasons).toContain("TESTS_NOT_PASSED");
    expect(result.train).toBeNull();
    expect((await db.task.findUniqueOrThrow({ where: { id: setup.taskIds.get("a") } })).status).not.toBe("COMPLETED");
  }, 180000);

  it("re-plans across waves, unblocking transitive dependents", async () => {
    const { repoDir, baseCommit } = await initLoopRepo(
      {},
      checkScript({ "src/a.txt": ["a\n"], "src/b.txt": ["b\n"], "src/c.txt": ["c\n"], "src/x.txt": ["x\n"] }),
    );
    const setup = await setupLoopFeature(repoDir, [
      { key: "a", claims: [{ resource: "src/a.txt", access: "WRITE" }] },
      { key: "x", claims: [{ resource: "src/x.txt", access: "WRITE" }] },
      { key: "b", claims: [{ resource: "src/b.txt", access: "WRITE" }], dependsOn: ["a"] },
      { key: "c", claims: [{ resource: "src/c.txt", access: "WRITE" }], dependsOn: ["b"] },
    ]);
    const id = (key: string): string => setup.taskIds.get(key) as string;

    const result = await runFeatureWaveLoop(
      {
        featureId: setup.featureId,
        repositoryId: setup.repositoryId,
        baseCommit,
        workspaceRoot: setup.scratchRoot,
        trainBranch: `atlas/m11/${uniqueName("train")}`,
        trainPath: join(setup.scratchRoot, "train"),
        approvalActor: "m11-test",
        testCommand: ["node", "check.mjs"],
        maxConcurrency: 4,
      },
      {
        createProvider: providersFor(setup.taskIds, {
          a: { args: ["--write", "src/a.txt=a\n", "--commit", "a"] },
          x: { args: ["--write", "src/x.txt=x\n", "--commit", "x"] },
          b: { args: ["--write", "src/b.txt=b\n", "--commit", "b"] },
          c: { args: ["--write", "src/c.txt=c\n", "--commit", "c"] },
        }),
        track,
      },
      db,
    );
    await trackLoopEvents(setup.taskIds.values());

    expect(result.waves).toHaveLength(3);
    expect(new Set(result.waves[0])).toEqual(new Set([id("a"), id("x")]));
    expect(result.waves[1]).toEqual([id("b")]);
    expect(result.waves[2]).toEqual([id("c")]);
    expect(result.outcomes.every((o) => o.verification?.verdict === "VERIFIED")).toBe(true);
    expect(result.train?.status).toBe("COMPLETED");
    expect(result.train?.items).toHaveLength(4);
  }, 240000);

  it("integrates verified waves through the ordered merge train", async () => {
    const trainBranch = `atlas/m11/${uniqueName("train")}`;
    const { repoDir, baseCommit } = await initLoopRepo(
      {},
      checkScript({ "src/a.txt": ["a\n"], "src/b.txt": ["b\n"] }),
    );
    const setup = await setupLoopFeature(repoDir, [
      { key: "a", claims: [{ resource: "src/a.txt", access: "WRITE" }] },
      { key: "b", claims: [{ resource: "src/b.txt", access: "WRITE" }], dependsOn: ["a"] },
    ]);

    const result = await runFeatureWaveLoop(
      {
        featureId: setup.featureId,
        repositoryId: setup.repositoryId,
        baseCommit,
        workspaceRoot: setup.scratchRoot,
        trainBranch,
        trainPath: join(setup.scratchRoot, "train"),
        approvalActor: "m11-test",
        testCommand: ["node", "check.mjs"],
        maxConcurrency: 4,
      },
      {
        createProvider: providersFor(setup.taskIds, {
          a: { args: ["--write", "src/a.txt=a\n", "--commit", "a"] },
          b: { args: ["--write", "src/b.txt=b\n", "--commit", "b"] },
        }),
        track,
      },
      db,
    );
    await trackLoopEvents(setup.taskIds.values());

    expect(result.train?.status).toBe("COMPLETED");
    expect(result.train?.trainBranch).toBe(trainBranch);
    expect(result.train?.baseCommit).toBe(baseCommit);
    const commits = (result.train?.items ?? []).map((item) => item.mergeCommit);
    expect(commits).toHaveLength(2);
    for (const sha of commits) {
      expect(sha).toMatch(/^[0-9a-f]{40}$/);
    }
    expect(result.train?.finalCommit).toBe(commits[commits.length - 1]);
  }, 180000);

  it("never touches the main branch", async () => {
    const { repoDir, baseCommit } = await initLoopRepo(
      {},
      checkScript({ "src/a.txt": ["a\n"], "src/b.txt": ["b\n"] }),
    );
    const setup = await setupLoopFeature(repoDir, [
      { key: "a", claims: [{ resource: "src/a.txt", access: "WRITE" }] },
      { key: "b", claims: [{ resource: "src/b.txt", access: "WRITE" }] },
    ]);

    const result = await runFeatureWaveLoop(
      {
        featureId: setup.featureId,
        repositoryId: setup.repositoryId,
        baseCommit,
        workspaceRoot: setup.scratchRoot,
        trainBranch: `atlas/m11/${uniqueName("train")}`,
        trainPath: join(setup.scratchRoot, "train"),
        approvalActor: "m11-test",
        testCommand: ["node", "check.mjs"],
        maxConcurrency: 4,
      },
      {
        createProvider: providersFor(setup.taskIds, {
          a: { args: ["--write", "src/a.txt=a\n", "--commit", "a"] },
          b: { args: ["--write", "src/b.txt=b\n", "--commit", "b"] },
        }),
        track,
      },
      db,
    );
    await trackLoopEvents(setup.taskIds.values());

    expect(result.train?.status).toBe("COMPLETED");
    expect(await getCurrentCommit(repoDir)).toBe(baseCommit);
    expect(await isClean(repoDir)).toBe(true);
  }, 180000);

  it("keeps worker workspaces isolated from each other", async () => {
    const { repoDir, baseCommit } = await initLoopRepo(
      {},
      checkScript({ "src/a.txt": ["a\n"], "src/b.txt": ["b\n"] }),
    );
    const setup = await setupLoopFeature(repoDir, [
      { key: "a", claims: [{ resource: "src/a.txt", access: "WRITE" }] },
      { key: "b", claims: [{ resource: "src/b.txt", access: "WRITE" }] },
    ]);

    const result = await runFeatureWaveLoop(
      {
        featureId: setup.featureId,
        repositoryId: setup.repositoryId,
        baseCommit,
        workspaceRoot: setup.scratchRoot,
        trainBranch: `atlas/m11/${uniqueName("train")}`,
        trainPath: join(setup.scratchRoot, "train"),
        approvalActor: "m11-test",
        testCommand: ["node", "check.mjs"],
        maxConcurrency: 4,
      },
      {
        createProvider: providersFor(setup.taskIds, {
          a: { args: ["--write", "src/a.txt=a\n", "--commit", "a"] },
          b: { args: ["--write", "src/b.txt=b\n", "--commit", "b"] },
        }),
        track,
      },
      db,
    );
    await trackLoopEvents(setup.taskIds.values());

    expect(result.train?.status).toBe("COMPLETED");
    const pathA = await workspaceOf(result.outcomes.find((o) => o.taskId === setup.taskIds.get("a"))?.workerId as string);
    const pathB = await workspaceOf(result.outcomes.find((o) => o.taskId === setup.taskIds.get("b"))?.workerId as string);
    expect(pathA).not.toBe(pathB);
    // A's file never appears in B's isolated worktree and vice versa.
    await expect(readFile(join(pathA, "src/b.txt"), "utf8")).rejects.toThrow();
    await expect(readFile(join(pathB, "src/a.txt"), "utf8")).rejects.toThrow();
  }, 180000);

  it("records workerMs, verificationMs, and schedulingMs (M19.1 phase timing)", async () => {
    const { repoDir, baseCommit } = await initLoopRepo({}, checkScript({ "src/a.txt": ["a\n"] }));
    const setup = await setupLoopFeature(repoDir, [{ key: "a", claims: [{ resource: "src/a.txt", access: "WRITE" }] }]);

    const result = await runFeatureWaveLoop(
      {
        featureId: setup.featureId,
        repositoryId: setup.repositoryId,
        baseCommit,
        workspaceRoot: setup.scratchRoot,
        trainBranch: `atlas/m19/${uniqueName("train")}`,
        trainPath: join(setup.scratchRoot, "train"),
        approvalActor: "m19-test",
        testCommand: ["node", "check.mjs"],
        maxConcurrency: 4,
      },
      {
        createProvider: () =>
          new FakeWorkerProvider({ files: { "src/a.txt": "a\n" }, commitMessage: "fake a", delayMs: 60 }),
        track,
      },
      db,
    );
    await trackLoopEvents(setup.taskIds.values());

    expect(result.waves).toHaveLength(1);
    const outcome = result.outcomes[0] as (typeof result.outcomes)[number];
    expect(outcome.execution.status).toBe("COMPLETED");
    // A. workerMs measures the provider execution span (60ms injected delay).
    expect(typeof outcome.workerMs).toBe("number");
    expect(outcome.workerMs as number).toBeGreaterThanOrEqual(50);
    // D. verificationMs recorded when verification ran.
    expect(outcome.verification?.verdict).toBe("VERIFIED");
    expect(typeof outcome.verificationMs).toBe("number");
    expect(outcome.verificationMs as number).toBeGreaterThanOrEqual(0);
    // C. one scheduling span per planning round: the executed wave plus the
    // terminal round that plans but finds no fresh tasks.
    expect(result.schedulingMs).toBeDefined();
    expect((result.schedulingMs ?? []).length).toBeGreaterThanOrEqual(result.waves.length);
    for (const ms of result.schedulingMs ?? []) {
      expect(Number.isFinite(ms)).toBe(true);
      expect(ms).toBeGreaterThanOrEqual(0);
    }
  }, 180000);

  it("records null verificationMs when verification does not run", async () => {
    const { repoDir, baseCommit } = await initLoopRepo({}, checkScript({ "src/a.txt": ["a\n"] }));
    const setup = await setupLoopFeature(repoDir, [{ key: "a", claims: [{ resource: "src/a.txt", access: "WRITE" }] }]);

    const result = await runFeatureWaveLoop(
      {
        featureId: setup.featureId,
        repositoryId: setup.repositoryId,
        baseCommit,
        workspaceRoot: setup.scratchRoot,
        trainBranch: `atlas/m19/${uniqueName("train")}`,
        trainPath: join(setup.scratchRoot, "train"),
        approvalActor: "m19-test",
        testCommand: ["node", "check.mjs"],
        maxConcurrency: 4,
      },
      {
        createProvider: () => new FakeWorkerProvider({ failWith: "boom" }),
        track,
      },
      db,
    );
    await trackLoopEvents(setup.taskIds.values());

    const outcome = result.outcomes[0] as (typeof result.outcomes)[number];
    expect(outcome.execution.status).toBe("FAILED");
    expect(outcome.verification).toBeNull();
    expect(outcome.verificationMs).toBeNull();
    expect(typeof outcome.workerMs).toBe("number");
  }, 180000);
});
