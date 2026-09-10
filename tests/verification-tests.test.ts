import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { createFeature, createProject, createTask } from "../src/core/service.js";
import { getPrismaClient } from "../src/db/client.js";
import {
  NoTestCommandError,
  TestExecutionError,
  resolveTestCommandFromPackageJson,
  runTests,
} from "../src/verification/index.js";
import { track, uniqueName } from "./domain-helpers.js";
import { makeTempDir } from "./git-helpers.js";

const db = getPrismaClient();
const NODE = process.execPath;

async function setupTask(suffix: string) {
  const project = await createProject({ name: uniqueName(`test-run-${suffix}`) });
  track("project", project.id);
  const feature = await createFeature({ projectId: project.id, title: `feat-${suffix}` });
  track("feature", feature.id);
  const task = await createTask({ featureId: feature.id, title: `task-${suffix}` });
  track("task", task.id);
  return { project, feature, task };
}

async function initNodeRepo(scriptsTest?: string): Promise<string> {
  const dir = await makeTempDir();
  const pkg: Record<string, unknown> = { name: "fixture", private: true };
  if (scriptsTest !== undefined) {
    pkg.scripts = { test: scriptsTest };
  }
  await writeFile(join(dir, "package.json"), JSON.stringify(pkg));
  await writeFile(join(dir, "check.mjs"), "process.exit(0);\n");
  return dir;
}

describe("test command resolution", () => {
  it("resolves scripts.test from package.json", async () => {
    const dir = await initNodeRepo("node check.mjs");
    expect(await resolveTestCommandFromPackageJson(dir)).toEqual(["node", "check.mjs"]);
  });

  it("rejects repos without package.json", async () => {
    await expect(resolveTestCommandFromPackageJson(await makeTempDir())).rejects.toThrow(NoTestCommandError);
  });

  it("rejects package.json without scripts.test", async () => {
    await expect(resolveTestCommandFromPackageJson(await initNodeRepo())).rejects.toThrow(NoTestCommandError);
  });

  it("rejects malformed package.json", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "package.json"), "{not-json");
    await expect(resolveTestCommandFromPackageJson(dir)).rejects.toThrow(NoTestCommandError);
  });
});

describe("test execution service", () => {
  it("passes on exit zero and captures everything", async () => {
    const { task } = await setupTask("pass");
    const result = await runTests(
      {
        taskId: task.id,
        workdir: await makeTempDir(),
        command: [NODE, "--eval", "console.log('out'); console.error('err');"],
        name: "smoke",
      },
      db,
    );
    track("testRun", result.testRunId);
    expect(result.status).toBe("PASSED");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("out");
    expect(result.stderr).toContain("err");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.timedOut).toBe(false);

    const row = await db.testRun.findUniqueOrThrow({ where: { id: result.testRunId } });
    expect(row.status).toBe("PASSED");
    expect(row.exitCode).toBe(0);
    expect(row.startedAt).not.toBeNull();
    expect(row.finishedAt).not.toBeNull();
    expect(row.name).toBe("smoke");
  });

  it("fails on non-zero exit with the code preserved", async () => {
    const { task } = await setupTask("fail");
    const result = await runTests({ taskId: task.id, workdir: await makeTempDir(), command: [NODE, "--eval", "process.exit(3);"] }, db);
    track("testRun", result.testRunId);
    expect(result.status).toBe("FAILED");
    expect(result.exitCode).toBe(3);
    expect((await db.testRun.findUniqueOrThrow({ where: { id: result.testRunId } })).status).toBe("FAILED");
  });

  it("runs the repository-configured command when none is supplied", async () => {
    const { task } = await setupTask("resolved");
    const dir = await initNodeRepo("node check.mjs");
    const result = await runTests({ taskId: task.id, workdir: dir }, db);
    track("testRun", result.testRunId);
    expect(result.command).toEqual(["node", "check.mjs"]);
    expect(result.status).toBe("PASSED");
  });

  it("fails on timeout and flags it", async () => {
    const { task } = await setupTask("timeout");
    const result = await runTests(
      { taskId: task.id, workdir: await makeTempDir(), command: [NODE, "--eval", "setTimeout(() => {}, 30000);"], timeoutMs: 1000 },
      db,
    );
    track("testRun", result.testRunId);
    expect(result.status).toBe("FAILED");
    expect(result.timedOut).toBe(true);
  });

  it("marks aborted runs cancelled", async () => {
    const { task } = await setupTask("abort");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const result = await runTests(
      { taskId: task.id, workdir: await makeTempDir(), command: [NODE, "--eval", "setTimeout(() => {}, 30000);"] },
      db,
      { signal: controller.signal },
    );
    track("testRun", result.testRunId);
    expect(result.status).toBe("CANCELLED");
    expect((await db.testRun.findUniqueOrThrow({ where: { id: result.testRunId } })).status).toBe("CANCELLED");
  });

  it("truncates huge output in the database row but returns it fully", async () => {
    const { task } = await setupTask("bigout");
    const result = await runTests(
      { taskId: task.id, workdir: await makeTempDir(), command: [NODE, "--eval", "process.stdout.write('x'.repeat(300000));"] },
      db,
    );
    track("testRun", result.testRunId);
    expect(result.status).toBe("PASSED");
    expect(result.stdout).toHaveLength(300000);
    const row = await db.testRun.findUniqueOrThrow({ where: { id: result.testRunId } });
    const metadata = JSON.parse(row.metadata ?? "{}") as { stdoutTruncated?: boolean; stdout?: string };
    expect(metadata.stdoutTruncated).toBe(true);
    expect(metadata.stdout?.length ?? 0).toBeLessThanOrEqual(200000);
  });

  it("rejects missing tasks, binaries, workdirs, and malformed input", async () => {
    const dir = await makeTempDir();
    await expect(runTests({ taskId: "missing", workdir: dir, command: [NODE, "--eval", "1"] }, db)).rejects.toThrow();
    const { task } = await setupTask("badenv");
    await expect(
      runTests({ taskId: task.id, workdir: dir, command: ["atlas-no-such-binary-xyz"] }, db),
    ).rejects.toThrow(TestExecutionError);
    for (const t of await db.testRun.findMany({ where: { taskId: task.id } })) track("testRun", t.id);
    const stuck = await db.testRun.findMany({ where: { taskId: task.id } });
    expect(stuck).toHaveLength(1);
    expect(stuck[0]?.status).toBe("RUNNING");
    expect(JSON.parse(stuck[0]?.metadata ?? "{}")).toMatchObject({ infraError: expect.stringContaining("not found") });
    await expect(
      runTests({ taskId: task.id, workdir: join(dir, "nope"), command: [NODE, "--eval", "1"] }, db),
    ).rejects.toThrow(TestExecutionError);
    await expect(runTests({ taskId: "", workdir: dir, command: [NODE] }, db)).rejects.toThrow(ZodError);
  });
});
