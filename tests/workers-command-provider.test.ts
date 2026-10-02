import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { getPrismaClient } from "../src/db/client.js";
import { getCurrentCommit } from "../src/git/index.js";
import {
  createApproval,
  createFeature,
  createProject,
  createRepository,
  createTask,
  createWorker,
  decideApproval,
  transitionTask,
} from "../src/core/service.js";
import { createTaskClaims } from "../src/claims/index.js";
import { assignTaskToWorker } from "../src/workspaces/index.js";
import {
  CommandFailureError,
  CommandWorkerProvider,
  executeTask,
  type WorkerExecutionInput,
} from "../src/workers/index.js";
import { track, uniqueName } from "./domain-helpers.js";
import { initTempRepo, makeTempDir } from "./git-helpers.js";

const db = getPrismaClient();
const AGENT = fileURLToPath(new URL("./fixtures/script-agent.mjs", import.meta.url));

interface TaskSetup {
  readonly repoDir: string;
  readonly baseCommit: string;
  readonly taskId: string;
  readonly workerId: string;
  readonly repositoryId: string;
  readonly scratchRoot: string;
}

async function setupTask(claims: ReadonlyArray<{ resource: string; access: "READ" | "WRITE" }>): Promise<TaskSetup> {
  const repoDir = await initTempRepo();
  const project = await createProject({ name: uniqueName("m11-prov"), description: "command provider test" }, db);
  track("project", project.id);
  const repository = await createRepository({ projectId: project.id, name: "main", localPath: repoDir }, db);
  track("repository", repository.id);
  const feature = await createFeature({ projectId: project.id, title: "provider feature" }, db);
  track("feature", feature.id);
  const task = await createTask({ featureId: feature.id, title: "provider task" }, db);
  track("task", task.id);
  await transitionTask(task.id, "READY", db);
  await createTaskClaims(
    { taskId: task.id, claims: claims.map((claim) => ({ resource: claim.resource, access: claim.access })) },
    db,
  );
  const worker = await createWorker({}, db);
  track("worker", worker.id);
  const approval = await createApproval({ taskId: task.id }, db);
  track("approval", approval.id);
  await decideApproval(approval.id, { decision: "APPROVED", actor: "m11-provider-test" }, db);
  return {
    repoDir,
    baseCommit: await getCurrentCommit(repoDir),
    taskId: task.id,
    workerId: worker.id,
    repositoryId: repository.id,
    scratchRoot: await makeTempDir(),
  };
}

async function runAgent(setup: TaskSetup, agentArgs: string[], providerOptions?: { timeoutMs?: number; envAllowlist?: string[] }) {
  const assignment = await assignTaskToWorker(
    {
      taskId: setup.taskId,
      workerId: setup.workerId,
      repositoryId: setup.repositoryId,
      workspaceRoot: join(setup.scratchRoot, "ws"),
    },
    db,
  );
  track("workspace", assignment.workspace.id);
  const provider = new CommandWorkerProvider({
    command: [process.execPath, AGENT, ...agentArgs],
    ...(providerOptions?.timeoutMs !== undefined ? { timeoutMs: providerOptions.timeoutMs } : {}),
    ...(providerOptions?.envAllowlist !== undefined ? { envAllowlist: providerOptions.envAllowlist } : {}),
  });
  const execution = await executeTask(
    { taskId: setup.taskId, workerId: setup.workerId, expectedBaseCommit: setup.baseCommit },
    provider,
    db,
  );
  // Track runtime-created rows so shared-DB cleanup deletes children first.
  for (const row of await db.event.findMany({ where: { taskId: setup.taskId } })) track("event", row.id);
  for (const row of await db.artifact.findMany({ where: { taskId: setup.taskId } })) track("artifact", row.id);
  return { assignment, execution };
}

function providerInput(workspacePath: string): WorkerExecutionInput {
  return {
    taskId: "task-probe",
    workerId: "worker-probe",
    workspacePath,
    taskTitle: "probe",
    resourceClaims: [],
    repositoryCommit: "abc1234",
    relevantContext: { branch: null, featureId: "feature-probe" },
  };
}

describe("command worker provider", () => {
  it("completes a successful subprocess modification observed from Git", async () => {
    const setup = await setupTask([{ resource: "src/out.txt", access: "WRITE" }]);
    const { execution } = await runAgent(setup, ["--write", "src/out.txt=hello\n", "--commit", "agent work"]);

    expect(execution.status).toBe("COMPLETED");
    expect(execution.changedResources).toEqual([{ path: "src/out.txt", change: "ADDED" }]);
    expect(execution.undeclaredResources).toEqual([]);
    expect(execution.providerSummary).toMatch(/^command-worker: .* exit 0$/);
  }, 60000);

  it("completes a no-op subprocess run with no changes", async () => {
    const setup = await setupTask([{ resource: "src/future.txt", access: "WRITE" }]);
    const { execution } = await runAgent(setup, []);

    // M19.4 Policy 3: valid hygiene with no effective diff is COMPLETED_EMPTY.
    expect(execution.status).toBe("COMPLETED_EMPTY");
    expect(execution.changedResources).toEqual([]);
    expect(execution.undeclaredResources).toEqual([]);
  }, 60000);

  it("flags a forbidden modification as CLAIM_VIOLATION, never success", async () => {
    const setup = await setupTask([{ resource: "src/allowed.txt", access: "WRITE" }]);
    const { execution } = await runAgent(setup, ["--write", "src/forbidden.txt=nope\n", "--commit", "bad work"]);

    expect(execution.status).toBe("CLAIM_VIOLATION");
    expect(execution.undeclaredResources).toEqual(["src/forbidden.txt"]);
  }, 60000);

  it("fails a runaway subprocess on timeout without hanging the suite", async () => {
    const setup = await setupTask([{ resource: "src/out.txt", access: "WRITE" }]);
    const { execution } = await runAgent(setup, ["--sleep", "15000", "--write", "src/out.txt=late\n"], { timeoutMs: 1000 });

    expect(execution.status).toBe("FAILED");
    expect(execution.error ?? "").toContain("command-worker");
    expect(execution.errorCode).toBe("TIMEOUT");
  }, 60000);

  it("maps a non-zero command exit to a structured failure", async () => {
    const setup = await setupTask([{ resource: "src/out.txt", access: "WRITE" }]);
    const { execution } = await runAgent(setup, ["--write", "src/out.txt=partial\n", "--fail", "boom-marker"]);

    expect(execution.status).toBe("FAILED");
    expect(execution.error ?? "").toContain("boom-marker");
    expect(execution.errorCode).toBe("EXIT_NONZERO");
  }, 60000);

  it("ignores garbage stdout: child output is never authority", async () => {
    const setup = await setupTask([{ resource: "src/ok.txt", access: "WRITE" }]);
    const { execution } = await runAgent(setup, ["--garbage", "--write", "src/ok.txt=fine\n", "--commit", "ok work"]);

    expect(execution.status).toBe("COMPLETED");
    expect(execution.undeclaredResources).toEqual([]);
    // The summary is Atlas-built from the argv (whitespace-flattened);
    // unstructured child stdout never leaks into it as content.
    expect(execution.providerSummary ?? "").not.toContain("THIS IS NOT A PROVIDER RESULT");
    expect(execution.providerSummary).toMatch(/exit 0$/);
  }, 60000);

  it("confines work to the assigned workspace and rejects workspace overrides", async () => {
    // Config cannot name a workspace: strict schema rejects the key.
    expect(() => new CommandWorkerProvider({ command: ["node"], workspacePath: "/elsewhere" })).toThrow(ZodError);
    expect(() => new CommandWorkerProvider({ command: [] })).toThrow(ZodError);

    // Relative writes land inside the Atlas-assigned worktree (cwd proof).
    const setup = await setupTask([{ resource: "src/inside.txt", access: "WRITE" }]);
    const { assignment, execution } = await runAgent(setup, ["--write", "src/inside.txt=in\n", "--commit", "in work"]);

    expect(execution.status).toBe("COMPLETED");
    await expect(readFile(join(assignment.workspace.path, "src/inside.txt"), "utf8")).resolves.toBe("in\n");

    // An absolute-path write outside the workspace is invisible to Atlas
    // claim enforcement (Git diff is worktree-scoped). This documents the
    // M11 non-sandbox boundary: process isolation, not hostile-code isolation.
    const outside = join(setup.scratchRoot, "outside.txt");
    const escape = await setupTask([{ resource: "src/nowhere.txt", access: "WRITE" }]);
    const escaped = await runAgent(escape, ["--write-absolute", `${outside}=evil\n`]);

    // M19.4 Policy 3: the worktree itself is unchanged, so the valid run is
    // COMPLETED_EMPTY; the outside write still lands (documented boundary).
    expect(escaped.execution.status).toBe("COMPLETED_EMPTY");
    expect(escaped.execution.changedResources).toEqual([]);
    await expect(readFile(outside, "utf8")).resolves.toBe("evil\n");
  }, 120000);

  it("delivers stdin EOF so stdin-reading children exit before the timeout", async () => {
    // Regression: execFile leaves child stdin open with no writer, so a
    // stdin-reading worker (e.g. OpenCode) would wait until timeout. The
    // provider ends stdin up front; EOF must arrive and the marker must be
    // captured far inside the timeout budget.
    const dir = await makeTempDir();
    const startedAt = Date.now();
    const output = (await new CommandWorkerProvider({
      command: [
        process.execPath,
        "-e",
        "process.stdin.resume(); process.stdin.on('end', () => console.log('ATLAS-STDIN-EOF'));",
      ],
      timeoutMs: 15000,
    }).execute(providerInput(dir))) as { summary: string; notes?: string };
    const elapsedMs = Date.now() - startedAt;

    expect(output.summary).toMatch(/exit 0$/);
    expect(output.notes ?? "").toContain("ATLAS-STDIN-EOF");
    expect(elapsedMs).toBeLessThan(15000);
  }, 60000);

  it("terminates a SIGTERM-ignoring child that errors but stays alive", async () => {
    // Regression for rate-limited providers: the child prints an API error
    // (like a rate-limit message) and then ignores SIGTERM, staying alive.
    // A single-SIGTERM timeout cannot end that wait; the provider must
    // escalate to SIGKILL and return a failure instead of hanging.
    const dir = await makeTempDir();
    const startedAt = Date.now();
    const error = await new CommandWorkerProvider({
      command: [
        process.execPath,
        "-e",
        "process.on('SIGTERM', () => {}); console.error('AI_APICallError: Rate limit exceeded. Please try again later.'); setInterval(() => {}, 1000);",
      ],
      timeoutMs: 1000,
    })
      .execute(providerInput(dir))
      .then(
        () => null,
        (e: unknown) => e,
      );
    const elapsedMs = Date.now() - startedAt;

    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error)?.message ?? "")).toContain("timed out after 1000ms");
    // Provider diagnostics survive into the recorded failure.
    expect(String((error as Error)?.message ?? "")).toContain("Rate limit exceeded");
    // Bounded by timeout + SIGKILL grace (5s) with slack: without escalation
    // this would hang until the test timeout instead.
    expect(elapsedMs).toBeLessThan(15000);
  }, 60000);

  it("forwards no host secrets by default; allowlisted vars pass through", async () => {
    process.env["ATLAS_M11_TEST_SECRET"] = "topsecret-secret";
    process.env["ATLAS_M11_TEST_PUBLIC"] = "public-value";
    try {
      const dir = await makeTempDir();
      const probe = (envAllowlist?: string[]): Promise<unknown> =>
        new CommandWorkerProvider({
          command: [process.execPath, AGENT, "--print-env", "ATLAS_M11_TEST_SECRET", "--print-env", "ATLAS_M11_TEST_PUBLIC"],
          ...(envAllowlist !== undefined ? { envAllowlist } : {}),
        }).execute(providerInput(dir));

      const denied = (await probe()) as { summary: string; notes?: string };
      expect(denied.notes ?? "").toContain("ATLAS_M11_TEST_SECRET=<unset>");
      expect(denied.notes ?? "").toContain("ATLAS_M11_TEST_PUBLIC=<unset>");
      expect(denied.notes ?? "").not.toContain("topsecret-secret");

      const allowed = (await probe(["ATLAS_M11_TEST_PUBLIC"])) as { summary: string; notes?: string };
      expect(allowed.notes ?? "").toContain("ATLAS_M11_TEST_PUBLIC=public-value");
      expect(allowed.notes ?? "").not.toContain("topsecret-secret");
    } finally {
      delete process.env["ATLAS_M11_TEST_SECRET"];
      delete process.env["ATLAS_M11_TEST_PUBLIC"];
    }
  }, 60000);

  it("classifies a timeout-killed child as TIMEOUT with the existing message", async () => {
    const dir = await makeTempDir();
    const error = await new CommandWorkerProvider({
      command: [process.execPath, "-e", "setInterval(() => {}, 1000);"],
      timeoutMs: 1000,
    })
      .execute(providerInput(dir))
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(error).toBeInstanceOf(CommandFailureError);
    expect((error as CommandFailureError).kind).toBe("TIMEOUT");
    expect((error as CommandFailureError).timedOut).toBe(true);
    expect((error as Error).message).toContain("command terminated by SIGTERM");
  }, 60000);

  it("classifies a non-zero exit as EXIT_NONZERO preserving stderr evidence", async () => {
    const dir = await makeTempDir();
    const error = await new CommandWorkerProvider({
      command: [process.execPath, "-e", "console.error('boom-517'); process.exit(3);"],
      timeoutMs: 15000,
    })
      .execute(providerInput(dir))
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(error).toBeInstanceOf(CommandFailureError);
    expect((error as CommandFailureError).kind).toBe("EXIT_NONZERO");
    expect((error as CommandFailureError).exitCode).toBe(3);
    expect((error as Error).message).toContain("command exited with code 3");
    expect((error as Error).message).toContain("boom-517");
  }, 60000);

  it("classifies a provider rate-limit signature as RATE_LIMIT", async () => {
    const dir = await makeTempDir();
    const error = await new CommandWorkerProvider({
      command: [
        process.execPath,
        "-e",
        "console.error('AI_APICallError: Rate limit exceeded. Please try again later.'); process.exit(1);",
      ],
      timeoutMs: 15000,
    })
      .execute(providerInput(dir))
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(error).toBeInstanceOf(CommandFailureError);
    expect((error as CommandFailureError).kind).toBe("RATE_LIMIT");
    // The provider's diagnostic text is preserved, not replaced.
    expect((error as Error).message).toContain("Rate limit exceeded");
  }, 60000);

  it("does not classify generic stderr as RATE_LIMIT", async () => {
    const dir = await makeTempDir();
    const run = (script: string) =>
      new CommandWorkerProvider({ command: [process.execPath, "-e", script], timeoutMs: 15000 })
        .execute(providerInput(dir))
        .then(
          () => null,
          (e: unknown) => e,
        );

    const gerund = await run("console.error('rate limiting enabled'); process.exit(1);");
    expect((gerund as CommandFailureError).kind).toBe("EXIT_NONZERO");
    const numbers = await run("console.error('boom-517 total=42'); process.exit(1);");
    expect((numbers as CommandFailureError).kind).toBe("EXIT_NONZERO");
  }, 60000);

  it("classifies an unspawnable executable as SPAWN_FAILED", async () => {
    const dir = await makeTempDir();
    const error = await new CommandWorkerProvider({
      command: ["/nonexistent-atlas-binary-xyz"],
      timeoutMs: 15000,
    })
      .execute(providerInput(dir))
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(error).toBeInstanceOf(CommandFailureError);
    expect((error as CommandFailureError).kind).toBe("SPAWN_FAILED");
    expect((error as Error).message).toContain("command failed to start");
  }, 60000);
});
