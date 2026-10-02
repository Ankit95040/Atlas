import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
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
import { runDiagnoseCommand } from "../src/cli/show.js";
import { uniqueName } from "./domain-helpers.js";
import { initTempRepo, makeTempDir } from "./git-helpers.js";

let tmpDbPath = "";
let tmpDbUrl = "";

function freshClient(): PrismaClient {
  return new PrismaClient({ datasources: { db: { url: tmpDbUrl } } });
}

beforeAll(() => {
  // One disposable file-backed database for the whole file (OS temp, never
  // the repo): schema applied once via db push so every test below starts
  // from migrated state.
  tmpDbPath = join(tmpdir(), `atlas-persist-evidence-test-${process.pid}.db`);
  tmpDbUrl = `file:${tmpDbPath}`;
  execFileSync("npx", ["prisma", "db", "push", "--skip-generate"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: tmpDbUrl },
    stdio: "pipe",
  });
}, 120000);

afterAll(async () => {
  const { rm } = await import("node:fs/promises");
  await rm(tmpDbPath, { force: true });
  await rm(`${tmpDbPath}-journal`, { force: true });
  await rm(`${tmpDbPath}-wal`, { force: true });
  await rm(`${tmpDbPath}-shm`, { force: true });
});

interface FlowSetup {
  readonly featureId: string;
  readonly taskIds: string[];
  readonly repoDir: string;
  readonly baseCommit: string;
  readonly scratchRoot: string;
  readonly repositoryId: string;
}

async function setupFlow(
  db: PrismaClient,
  suffix: string,
  tasks: Array<{ key: string; claims: Array<{ resource: string; access: string }> }>,
): Promise<FlowSetup> {
  const repoDir = await initTempRepo();
  const project = await createProject({ name: uniqueName(`persist-proj-${suffix}`) }, db);
  const repository = await createRepository({ projectId: project.id, name: "main", localPath: repoDir }, db);
  const feature = await createFeature({ projectId: project.id, title: `persist-feat-${suffix}` }, db);
  const taskIds: string[] = [];
  for (const def of tasks) {
    const task = await createTask({ featureId: feature.id, title: def.key }, db);
    await transitionTask(task.id, "READY", db);
    await createTaskClaims({ taskId: task.id, claims: def.claims }, db);
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

async function runLoop(
  db: PrismaClient,
  setup: FlowSetup,
  behaviors: Record<string, { files?: Record<string, string>; commitMessage?: string; failWith?: string }>,
  keys: string[],
  testCommand?: string[],
) {
  const keyById = new Map(setup.taskIds.map((id, i) => [id, keys[i] as string]));
  return runFeatureWaveLoop(
    {
      featureId: setup.featureId,
      repositoryId: setup.repositoryId,
      baseCommit: setup.baseCommit,
      workspaceRoot: setup.scratchRoot,
      trainBranch: `atlas/persist/${uniqueName("train")}`,
      trainPath: join(setup.scratchRoot, "train"),
      approvalActor: "persist-test",
      ...(testCommand !== undefined ? { testCommand } : {}),
      maxConcurrency: 4,
    },
    {
      createProvider: (taskId: string) => new FakeWorkerProvider(behaviors[keyById.get(taskId) ?? taskId] ?? {}),
    },
    db,
  );
}

describe("persisted failure evidence across fresh clients (M21.2)", () => {
  it("A. provider failure survives a fresh process/database boundary", async () => {
    const writer = freshClient();
    let taskId = "";
    try {
      const setup = await setupFlow(writer, "provfail", [
        { key: "a", claims: [{ resource: "src/a.txt", access: "WRITE" }] },
      ]);
      taskId = setup.taskIds[0] as string;
      await runLoop(
        writer,
        setup,
        {
          a: {
            // Representative provider-thrown failure (no live provider calls).
            failWith: "Detail: AI_APICallError: Rate limit exceeded. Please try again later.",
          },
        },
        ["a"],
      );
    } finally {
      await writer.$disconnect();
    }

    const reader = freshClient();
    try {
      const rows = await reader.event.findMany({
        where: { taskId, type: "TASK_FAILED" },
        orderBy: { createdAt: "asc" },
      });
      expect(rows.length).toBeGreaterThan(0);
      const payload = JSON.parse((rows[rows.length - 1]?.payload ?? "{}") as string) as Record<string, unknown>;
      expect(payload["outcome"]).toBe("FAILED");
      // Plain provider throws carry no command-failure code: honest absence.
      expect(payload["errorCode"] ?? null).toBeNull();
      expect(payload["error"]).toContain("Rate limit exceeded");
      expect(payload["phase"]).toBe("worker-execution");
    } finally {
      await reader.$disconnect();
    }
  });

  it("B. timeout evidence survives with its structured code", async () => {
    const writer = freshClient();
    let taskId = "";
    try {
      const setup = await setupFlow(writer, "timeout", [
        { key: "a", claims: [{ resource: "src/a.txt", access: "WRITE" }] },
      ]);
      taskId = setup.taskIds[0] as string;
      // Simulate the timeout path deterministically: a delay longer than the
      // provider-level budget is timing-flaky, so record the timeout-shaped
      // failure directly through the failure path instead.
      const { CommandFailureError } = await import("../src/workers/command-provider.js");
      const { executeTask } = await import("../src/workers/runtime.js");
      // Drive a real execution that fails fast with a TIMEOUT-coded error.
      const { assignTaskToWorker } = await import("../src/workspaces/index.js");
      const { createWorker, createApproval, decideApproval } = await import("../src/core/service.js");
      const worker = await createWorker({}, writer);
      const approval = await createApproval({ taskId }, writer);
      await decideApproval(approval.id, { decision: "APPROVED", actor: "tester" }, writer);
      const scratch = await makeTempDir();
      await assignTaskToWorker({ taskId, workerId: worker.id, repositoryId: setup.repositoryId, workspaceRoot: scratch }, writer);
      const throwing = {
        execute: async (): Promise<unknown> => {
          throw new CommandFailureError("TIMEOUT", { executable: "agent", message: "command timed out after 5ms" });
        },
      };
      const base = await getCurrentCommit(setup.repoDir);
      const outcome = await executeTask({ taskId, workerId: worker.id, expectedBaseCommit: base }, throwing, writer);
      expect(outcome.status).toBe("FAILED");
      expect(outcome.errorCode).toBe("TIMEOUT");
    } finally {
      await writer.$disconnect();
    }

    const reader = freshClient();
    try {
      const rows = await reader.event.findMany({ where: { taskId, type: "TASK_FAILED" } });
      expect(rows).toHaveLength(1);
      const payload = JSON.parse((rows[0]?.payload ?? "{}") as string) as Record<string, unknown>;
      expect(payload["errorCode"]).toBe("TIMEOUT");
      expect(payload["phase"]).toBe("worker-execution");
    } finally {
      await reader.$disconnect();
    }
  });

  it("C. worker failure without a code stays honestly generic", async () => {
    const writer = freshClient();
    let taskId = "";
    try {
      const setup = await setupFlow(writer, "generic", [
        { key: "a", claims: [{ resource: "src/a.txt", access: "WRITE" }] },
      ]);
      taskId = setup.taskIds[0] as string;
      await runLoop(writer, setup, { a: { failWith: "boom" } }, ["a"]);
    } finally {
      await writer.$disconnect();
    }

    const reader = freshClient();
    try {
      const rows = await reader.event.findMany({ where: { taskId, type: "TASK_FAILED" } });
      expect(rows).toHaveLength(1);
      const payload = JSON.parse((rows[0]?.payload ?? "{}") as string) as Record<string, unknown>;
      expect(payload["errorCode"] ?? null).toBeNull();
      expect(payload["error"]).toContain("boom");
      const output = await runDiagnoseCommand(
        { runId: (await reader.task.findUniqueOrThrow({ where: { id: taskId } })).featureId },
        reader,
      );
      expect(output.human).toContain("worker execution");
    } finally {
      await reader.$disconnect();
    }
  });

  it("D. verification rejection persists reasons for fresh readers", async () => {
    const writer = freshClient();
    let featureId = "";
    try {
      const setup = await setupFlow(writer, "rejected", [
        { key: "a", claims: [{ resource: "src/a.txt", access: "WRITE" }] },
      ]);
      featureId = setup.featureId;
      await runLoop(
        writer,
        setup,
        { a: { files: { "src/a.txt": "a\n" }, commitMessage: "fake a" } },
        ["a"],
        [process.execPath, "--eval", "process.exit(2);"],
      );
    } finally {
      await writer.$disconnect();
    }

    const reader = freshClient();
    try {
      const rows = await reader.event.findMany({
        where: { featureId, type: "VERIFICATION_COMPLETED" },
        orderBy: { createdAt: "asc" },
      });
      expect(rows.length).toBeGreaterThan(0);
      const payload = JSON.parse((rows[rows.length - 1]?.payload ?? "{}") as string) as Record<string, unknown>;
      expect(payload["verdict"]).toBe("REJECTED");
      expect(payload["reasons"]).toContain("TESTS_NOT_PASSED");
      // Diagnose reports the proximate cause (the failed test run); the
      // rejection reasons remain available in the persisted payload above.
      const output = await runDiagnoseCommand({ runId: featureId }, reader);
      expect(output.human).toContain("latest test run FAILED");
    } finally {
      await reader.$disconnect();
    }
  });

  it("E. integration halt behavior is unchanged (CONFLICT still halts)", async () => {
    const writer = freshClient();
    try {
      const setup = await setupFlow(writer, "halted", [
        { key: "a", claims: [{ resource: "shared.txt", access: "WRITE" }] },
        { key: "b", claims: [{ resource: "shared.txt", access: "WRITE" }] },
      ]);
      const result = await runLoop(
        writer,
        setup,
        {
          a: { files: { "shared.txt": "aaa\n" }, commitMessage: "fake a" },
          b: { files: { "shared.txt": "bbb\n" }, commitMessage: "fake b" },
        },
        ["a", "b"],
        [process.execPath, "--eval", "process.exit(0);"],
      );
      expect(result.train?.status).toBe("HALTED");
      const statuses = (result.train?.items ?? []).map((i) => i.status).sort();
      expect(statuses).toContain("CONFLICT");
    } finally {
      await writer.$disconnect();
    }
  });

  it("F. empty execution persists its distinct outcome, not ordinary success", async () => {
    const writer = freshClient();
    let taskId = "";
    try {
      const setup = await setupFlow(writer, "empty", [
        { key: "a", claims: [{ resource: "src/a.txt", access: "WRITE" }] },
      ]);
      taskId = setup.taskIds[0] as string;
      await runLoop(writer, setup, { a: {} }, ["a"]);
    } finally {
      await writer.$disconnect();
    }

    const reader = freshClient();
    try {
      expect((await reader.task.findUniqueOrThrow({ where: { id: taskId } })).status).toBe("COMPLETED_EMPTY");
      const rows = await reader.event.findMany({ where: { taskId, type: "TASK_COMPLETED" } });
      expect(rows).toHaveLength(1);
      const payload = JSON.parse((rows[0]?.payload ?? "{}") as string) as Record<string, unknown>;
      expect(payload["outcome"]).toBe("COMPLETED_EMPTY");
    } finally {
      await reader.$disconnect();
    }
  });
});
