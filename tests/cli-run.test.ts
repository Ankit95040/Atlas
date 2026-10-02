import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getPrismaClient } from "../src/db/client.js";
import { getCurrentCommit, runGit } from "../src/git/index.js";
import { createFeature, createProject, createRepository } from "../src/core/service.js";
import { payloadWorkerId } from "../src/workspaces/index.js";
import { runPlanCommand } from "../src/cli/plan.js";
import { runRunCommand } from "../src/cli/run-command.js";
import { track, uniqueName } from "./domain-helpers.js";
import { makeTempDir } from "./git-helpers.js";

const db = getPrismaClient();
const AGENT = fileURLToPath(new URL("./fixtures/script-agent.mjs", import.meta.url));

interface RunFixture {
  readonly featureId: string;
  readonly repositoryId: string;
  readonly repoDir: string;
  readonly baseCommit: string;
  readonly scratchRoot: string;
}

async function initFixtureRepo(check: string): Promise<{ repoDir: string; baseCommit: string }> {
  const dir = await makeTempDir();
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "m12-fixture", scripts: { test: "node check.mjs" } }));
  await writeFile(join(dir, "check.mjs"), check);
  await runGit(["init", "-b", "main"], { cwd: dir });
  await runGit(["config", "user.email", "m12-test@example.invalid"], { cwd: dir });
  await runGit(["config", "user.name", "M12 Test"], { cwd: dir });
  await runGit(["add", "-A"], { cwd: dir });
  await runGit(["-c", "commit.gpgsign=false", "commit", "-m", "m12 fixture"], { cwd: dir });
  return { repoDir: dir, baseCommit: await getCurrentCommit(dir) };
}

const PASS_CHECK = `import { existsSync, readFileSync } from "node:fs";
for (const [rel, expected] of [["src/a.txt", "a\\n"]]) {
  if (!existsSync(rel)) continue;
  const actual = readFileSync(rel, "utf8");
  if (actual !== expected) { console.error("bad " + rel); process.exit(1); }
}
process.exit(0);
`;

const STRICT_CHECK = `import { readFileSync } from "node:fs";
const actual = readFileSync("src/a.txt", "utf8");
if (actual !== "a\\n") { console.error("bad src/a.txt: " + JSON.stringify(actual)); process.exit(1); }
process.exit(0);
`;

async function setupRunFixture(check: string): Promise<RunFixture> {
  const { repoDir, baseCommit } = await initFixtureRepo(check);
  const project = await createProject({ name: uniqueName("m12-run"), description: "cli run test" }, db);
  track("project", project.id);
  const repository = await createRepository({ projectId: project.id, name: "main", localPath: repoDir }, db);
  track("repository", repository.id);
  const feature = await createFeature({ projectId: project.id, title: "run feature" }, db);
  track("feature", feature.id);
  return { featureId: feature.id, repositoryId: repository.id, repoDir, baseCommit, scratchRoot: await makeTempDir() };
}

async function writeProposalFile(featureId: string): Promise<string> {
  const path = join(await makeTempDir(), "proposal.json");
  await writeFile(
    path,
    JSON.stringify({
      featureId,
      tasks: [{ id: "solo", title: "Solo task", claims: [{ resource: "src/a.txt", access: "WRITE" }] }],
      dependencies: [],
    }),
  );
  return path;
}

async function planAndApprove(featureId: string): Promise<string> {
  const proposal = await writeProposalFile(featureId);
  const output = await runPlanCommand({ featureId, proposal, approve: true, actor: "ada" }, db);
  return (output.data as { approval: { id: string } }).approval.id;
}

async function trackRunScope(featureId: string): Promise<void> {
  const tasks = await db.task.findMany({ where: { featureId }, select: { id: true } });
  const taskIds = tasks.map((task) => task.id);
  for (const task of tasks) track("task", task.id);
  for (const row of await db.approval.findMany({ where: { featureId } })) track("approval", row.id);
  // M23.1: released terminal workers are invisible to the live-link query;
  // resolve every worker that ever touched these tasks via event payloads.
  const workerIds = new Set<string>();
  for (const row of await db.worker.findMany({ where: { taskId: { in: taskIds } }, select: { id: true } })) {
    workerIds.add(row.id);
  }
  for (const row of await db.event.findMany({ where: { taskId: { in: taskIds } }, select: { payload: true } })) {
    const wid = payloadWorkerId(row.payload);
    if (wid !== null) {
      workerIds.add(wid);
    }
  }
  for (const id of workerIds) track("worker", id);
  for (const row of await db.workspace.findMany({ where: { workerId: { in: [...workerIds] } } })) {
    track("workspace", row.id);
  }
  for (const row of await db.taskDependency.findMany({ where: { taskId: { in: taskIds } } })) {
    track("taskDependency", row.id);
  }
  for (const taskId of taskIds) {
    for (const row of await db.commit.findMany({ where: { taskId }, select: { id: true } })) track("commit", row.id);
    for (const row of await db.artifact.findMany({ where: { taskId }, select: { id: true } })) track("artifact", row.id);
    for (const row of await db.testRun.findMany({ where: { taskId }, select: { id: true } })) track("testRun", row.id);
    for (const row of await db.event.findMany({ where: { taskId }, select: { id: true } })) track("event", row.id);
  }
}

async function taskStatuses(featureId: string): Promise<string[]> {
  const tasks = await db.task.findMany({ where: { featureId }, select: { status: true } });
  return tasks.map((task) => task.status).sort();
}

describe("atlas run", () => {
  it("refuses when the plan approval is not APPROVED and executes nothing", async () => {
    const fixture = await setupRunFixture(PASS_CHECK);
    const proposal = await writeProposalFile(fixture.featureId);
    const planned = await runPlanCommand({ featureId: fixture.featureId, proposal }, db);
    const approvalId = (planned.data as { approval: { id: string } }).approval.id;

    await expect(
      runRunCommand(
        {
          featureId: fixture.featureId,
          repositoryId: fixture.repositoryId,
          planApproval: approvalId,
          actor: "ada",
          agent: process.execPath,
          agentArg: [AGENT, "--write", "src/a.txt=a\n", "--commit", "w"],
          approveMerge: true,
          workspaceRoot: join(fixture.scratchRoot, "work"),
        },
        db,
      ),
    ).rejects.toThrow(/is PENDING/);
    // Nothing executed: tasks never left READY.
    expect(await taskStatuses(fixture.featureId)).toEqual(["READY"]);
    await trackRunScope(fixture.featureId);
  }, 120000);

  it("refuses without --approve-merge and executes nothing", async () => {
    const fixture = await setupRunFixture(PASS_CHECK);
    const approvalId = await planAndApprove(fixture.featureId);

    await expect(
      runRunCommand(
        {
          featureId: fixture.featureId,
          repositoryId: fixture.repositoryId,
          planApproval: approvalId,
          actor: "ada",
          agent: process.execPath,
          agentArg: [AGENT],
          workspaceRoot: join(fixture.scratchRoot, "work"),
        },
        db,
      ),
    ).rejects.toThrow(/merge not authorized/);
    expect(await taskStatuses(fixture.featureId)).toEqual(["READY"]);
    await trackRunScope(fixture.featureId);
  }, 120000);

  it("refuses a plan approval that targets another feature", async () => {
    const fixture = await setupRunFixture(PASS_CHECK);
    const other = await setupRunFixture(PASS_CHECK);
    const approvalId = await planAndApprove(other.featureId);

    await expect(
      runRunCommand(
        {
          featureId: fixture.featureId,
          repositoryId: fixture.repositoryId,
          planApproval: approvalId,
          actor: "ada",
          agent: process.execPath,
          agentArg: [AGENT],
          approveMerge: true,
          workspaceRoot: join(fixture.scratchRoot, "work"),
        },
        db,
      ),
    ).rejects.toThrow(/targets feature/);
    await trackRunScope(fixture.featureId);
    await trackRunScope(other.featureId);
  }, 120000);

  it("executes an approved plan end to end with persisted approvals", async () => {
    const fixture = await setupRunFixture(PASS_CHECK);
    const approvalId = await planAndApprove(fixture.featureId);

    const output = await runRunCommand(
      {
        featureId: fixture.featureId,
        repositoryId: fixture.repositoryId,
        planApproval: approvalId,
        actor: "ada",
        agent: process.execPath,
        agentArg: [AGENT, "--write", "src/a.txt=a\n", "--commit", "agent work"],
        approveMerge: true,
        testCommand: process.execPath,
        testArg: ["check.mjs"],
        workspaceRoot: join(fixture.scratchRoot, "work"),
        trainPath: join(fixture.scratchRoot, "train"),
      },
      db,
    );
    await trackRunScope(fixture.featureId);

    expect(output.exitCode).toBe(0);
    const data = output.data as {
      train: { status: string; items: Array<{ status: string }> } | null;
      mergeApproval: { id: string; status: string; actor: string };
    };
    expect(data.train?.status).toBe("COMPLETED");
    expect(data.train?.items).toHaveLength(1);
    expect(data.mergeApproval.status).toBe("APPROVED");
    expect(data.mergeApproval.actor).toBe("ada");
    // The persisted merge row is the record, decided once via the API.
    const persisted = await db.approval.findUniqueOrThrow({ where: { id: data.mergeApproval.id } });
    expect(persisted.status).toBe("APPROVED");
    expect(persisted.decidedAt).not.toBeNull();
    expect(await getCurrentCommit(fixture.repoDir)).toBe(fixture.baseCommit);
    expect(output.human).toContain("merge approval:");
  }, 180000);

  it("reports claim violations truthfully with a halted exit code", async () => {
    const fixture = await setupRunFixture(STRICT_CHECK);
    const approvalId = await planAndApprove(fixture.featureId);

    const output = await runRunCommand(
      {
        featureId: fixture.featureId,
        repositoryId: fixture.repositoryId,
        planApproval: approvalId,
        actor: "ada",
        agent: process.execPath,
        agentArg: [AGENT, "--write", "src/evil.txt=x\n", "--commit", "evil"],
        approveMerge: true,
        testCommand: process.execPath,
        testArg: ["check.mjs"],
        workspaceRoot: join(fixture.scratchRoot, "work"),
        trainPath: join(fixture.scratchRoot, "train"),
      },
      db,
    );
    await trackRunScope(fixture.featureId);

    // Execution ran under authorization, but nothing verified: halted, not silent.
    expect(output.exitCode).toBe(2);
    expect(output.human).toContain("CLAIM_VIOLATION");
  }, 180000);

  it("applies --agent-timeout-ms to the worker provider timeout (M20.2a)", async () => {
    const fixture = await setupRunFixture(PASS_CHECK);
    const approvalId = await planAndApprove(fixture.featureId);

    const startedAt = Date.now();
    const output = await runRunCommand(
      {
        featureId: fixture.featureId,
        repositoryId: fixture.repositoryId,
        planApproval: approvalId,
        actor: "ada",
        agent: process.execPath,
        agentArg: [AGENT, "--sleep", "30000"],
        agentTimeoutMs: 1000,
        approveMerge: true,
        testCommand: process.execPath,
        testArg: ["check.mjs"],
        workspaceRoot: join(fixture.scratchRoot, "work"),
        trainPath: join(fixture.scratchRoot, "train"),
      },
      db,
    );
    const wallMs = Date.now() - startedAt;
    await trackRunScope(fixture.featureId);

    // The flag reached the provider: killed near 1s (plus SIGKILL grace),
    // far below both the 30s sleep and the 120s provider default.
    expect(output.exitCode).toBe(2);
    expect(wallMs).toBeLessThan(30000);
    const data = output.data as {
      outcomes: Array<{ execution: { status: string; errorCode?: string } }>;
    };
    expect(data.outcomes).toHaveLength(1);
    expect(data.outcomes[0]?.execution.status).toBe("FAILED");
    expect(data.outcomes[0]?.execution.errorCode).toBe("TIMEOUT");
  }, 180000);
});
