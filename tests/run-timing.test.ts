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
import { runFeatureWaveLoop } from "../src/orchestrator/index.js";
import { buildTimingSummary } from "../src/cli/run-command.js";
import { track, uniqueName } from "./domain-helpers.js";
import { makeTempDir } from "./git-helpers.js";

const db = getPrismaClient();
const AGENT = fileURLToPath(new URL("./fixtures/script-agent.mjs", import.meta.url));

async function setupTimedFeature(
  repoDir: string,
  keys: string[],
): Promise<{ featureId: string; repositoryId: string; taskIds: string[]; scratchRoot: string }> {
  const project = await createProject({ name: uniqueName("timing") }, db);
  track("project", project.id);
  const repository = await createRepository({ projectId: project.id, name: "main", localPath: repoDir }, db);
  track("repository", repository.id);
  const feature = await createFeature({ projectId: project.id, title: "timing feature" }, db);
  track("feature", feature.id);
  const taskIds: string[] = [];
  for (const key of keys) {
    const task = await createTask({ featureId: feature.id, title: key }, db);
    track("task", task.id);
    await transitionTask(task.id, "READY", db);
    await createTaskClaims({ taskId: task.id, claims: [{ resource: `${key}.txt`, access: "WRITE" }] });
    taskIds.push(task.id);
  }
  return { featureId: feature.id, repositoryId: repository.id, taskIds, scratchRoot: await makeTempDir() };
}

async function initTimedRepo(): Promise<{ repoDir: string; baseCommit: string }> {
  const dir = await makeTempDir();
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "timing-fixture", scripts: { test: "node -e \"process.exit(0)\"" } }));
  for (const rel of ["a.txt", "b.txt"]) {
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await writeFile(join(dir, rel), "seed\n");
  }
  await runGit(["init", "-b", "main"], { cwd: dir });
  await runGit(["config", "user.email", "timing-test@example.invalid"], { cwd: dir });
  await runGit(["config", "user.name", "Timing Test"], { cwd: dir });
  await runGit(["add", "-A"], { cwd: dir });
  await runGit(["-c", "commit.gpgsign=false", "commit", "-m", "timing fixture"], { cwd: dir });
  return { repoDir: dir, baseCommit: await getCurrentCommit(dir) };
}

function providerFor(write: boolean) {
  return () =>
    new CommandWorkerProvider({
      command: write
        ? [process.execPath, AGENT, "--write", "a.txt=a\n", "--commit", "agent write"]
        : [process.execPath, AGENT],
    });
}

describe("run timing instrumentation (M28.2)", () => {
  it("records assign and train spans on a fully integrated run", async () => {
    const { repoDir, baseCommit } = await initTimedRepo();
    const setup = await setupTimedFeature(repoDir, ["a"]);
    const result = await runFeatureWaveLoop(
      {
        featureId: setup.featureId,
        repositoryId: setup.repositoryId,
        baseCommit,
        workspaceRoot: setup.scratchRoot,
        trainBranch: `atlas/timing/${uniqueName("train")}`,
        trainPath: join(setup.scratchRoot, "train"),
        approvalActor: "timing-test",
        maxConcurrency: 4,
      },
      { createProvider: providerFor(true), track },
      db,
    );
    expect(result.train?.status).toBe("COMPLETED");
    const outcome = result.outcomes[0];
    expect(outcome?.assignMs).toBeGreaterThanOrEqual(0);
    expect(typeof result.trainMs).toBe("number");
    expect(result.trainMs).toBeGreaterThanOrEqual(0);
    const timing = buildTimingSummary(result, 1234);
    expect(timing.totalElapsedMs).toBe(1234);
    expect(timing.assignMs).toBe(outcome?.assignMs ?? -1);
    expect(timing.trainMs).toBe(result.trainMs);
    expect(timing.missing).toEqual([]);
    expect(timing.schedulingMs).toBeGreaterThanOrEqual(0);
  });

  it("reports missing train timing when integration is skipped", async () => {
    const { repoDir, baseCommit } = await initTimedRepo();
    const setup = await setupTimedFeature(repoDir, ["a"]);
    const result = await runFeatureWaveLoop(
      {
        featureId: setup.featureId,
        repositoryId: setup.repositoryId,
        baseCommit,
        workspaceRoot: setup.scratchRoot,
        trainBranch: `atlas/timing/${uniqueName("train")}`,
        trainPath: join(setup.scratchRoot, "train"),
        approvalActor: "timing-test",
        maxConcurrency: 4,
      },
      { createProvider: providerFor(false), track },
      db,
    );
    // Empty agent output: nothing verified, train skipped — timing must say
    // so explicitly rather than inventing zeros.
    expect(result.train).toBeNull();
    expect(result.trainMs).toBeNull();
    const timing = buildTimingSummary(result, 500);
    expect(timing.trainMs).toBeNull();
    expect(timing.missing.join(" ")).toContain("train (skipped: nothing verified)");
    expect(timing.missing.join(" ")).toContain("tests (no test run executed)");
  });

  it("sums per-task spans and names absent phases in missing", () => {
    const timing = buildTimingSummary(
      {
        featureId: "f",
        repositoryId: "r",
        baseCommit: "abc",
        waves: [["t1"], ["t2"]],
        outcomes: [
          {
            taskId: "t1",
            workerId: "w1",
            execution: { taskId: "t1", workerId: "w1", status: "COMPLETED", changedResources: [], undeclaredResources: [] },
            testRun: null,
            verification: null,
            workerMs: 100,
            verificationMs: null,
            assignMs: 10,
          },
          {
            taskId: "t2",
            workerId: "w2",
            execution: { taskId: "t2", workerId: "w2", status: "FAILED", changedResources: [], undeclaredResources: [] },
            testRun: null,
            verification: null,
            workerMs: 50,
            verificationMs: null,
            assignMs: 5,
          },
        ],
        train: null,
        triage: null,
        schedulingMs: [1, 2],
        trainMs: null,
      },
      1000,
    );
    expect(timing).toMatchObject({
      totalElapsedMs: 1000,
      schedulingMs: 3,
      assignMs: 15,
      workerMs: 150,
      testMs: 0,
      verificationMs: 0,
    });
    expect(timing.missing).toContain("train (skipped: nothing verified)");
  });
});
