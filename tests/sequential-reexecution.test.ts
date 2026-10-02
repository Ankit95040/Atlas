import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getPrismaClient } from "../src/db/client.js";
import { getCurrentCommit, runGit } from "../src/git/index.js";
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
import {
  assignTaskToWorker,
  recoverStrandedAssignment,
} from "../src/workspaces/index.js";
import { executeTask, FakeWorkerProvider } from "../src/workers/index.js";
import { runTests } from "../src/verification/tests.js";
import { verifyExecution } from "../src/verification/verify.js";
import { runMergeTrain } from "../src/verification/mergetrain.js";
import { TaskAssignmentError } from "../src/workspaces/errors.js";
import { runRunCommand } from "../src/cli/run-command.js";
import { runPlanCommand } from "../src/cli/plan.js";
import { runTaskTransitionCommand } from "../src/cli/transition.js";
import {
  runDiagnoseCommand,
  runShowRunCommand,
  runShowTaskCommand,
  runShowWorkerCommand,
} from "../src/cli/show.js";
import { track, uniqueName } from "./domain-helpers.js";
import { makeTempDir, trackTempPath } from "./git-helpers.js";
import { fileURLToPath } from "node:url";

const db = getPrismaClient();
const AGENT = fileURLToPath(new URL("./fixtures/script-agent.mjs", import.meta.url));

const PASS_CHECK = `import { existsSync, readFileSync } from "node:fs";
for (const [rel, expected] of [["src/a.txt", "a\\n"]]) {
  if (!existsSync(rel)) continue;
  const actual = readFileSync(rel, "utf8");
  if (actual !== expected) { console.error("bad " + rel); process.exit(1); }
}
process.exit(0);
`;

const STRICT_B_CHECK = `import { readFileSync } from "node:fs";
const actual = readFileSync("src/a.txt", "utf8");
if (actual !== "b\\n") { console.error("want b, got " + JSON.stringify(actual)); process.exit(1); }
process.exit(0);
`;

async function initFixtureRepo(check: string, withBaseFile = false): Promise<{ repoDir: string; baseCommit: string }> {
  const dir = trackTempPath(await makeTempDir());
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "m23x-fixture", scripts: { test: "node check.mjs" } }));
  await writeFile(join(dir, "check.mjs"), check);
  if (withBaseFile) {
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "a.txt"), "base\n");
  }
  await runGit(["init", "-b", "main"], { cwd: dir });
  await runGit(["config", "user.email", "m23x-test@example.invalid"], { cwd: dir });
  await runGit(["config", "user.name", "M23X Test"], { cwd: dir });
  await runGit(["add", "-A"], { cwd: dir });
  await runGit(["-c", "commit.gpgsign=false", "commit", "-m", "m23x fixture"], { cwd: dir });
  return { repoDir: dir, baseCommit: await getCurrentCommit(dir) };
}

async function setupFeature(suffix: string, repoDir: string) {
  const project = await createProject({ name: uniqueName(`m23x-proj-${suffix}`) }, db);
  track("project", project.id);
  const repository = await createRepository({ projectId: project.id, name: "main", localPath: repoDir }, db);
  track("repository", repository.id);
  const feature = await createFeature({ projectId: project.id, title: `m23x-feat-${suffix}` }, db);
  track("feature", feature.id);
  return { project, repository, feature };
}

async function setupTask(featureId: string, title: string, claims: Array<{ resource: string; access: "READ" | "WRITE" }>) {
  const pending = await createTask({ featureId, title }, db);
  track("task", pending.id);
  const ready = await transitionTask(pending.id, "READY", db);
  await createTaskClaims({ taskId: ready.id, claims });
  // executeTask's approval gate requires an APPROVED task approval.
  const approval = await createApproval({ taskId: ready.id }, db);
  track("approval", approval.id);
  await decideApproval(approval.id, { decision: "APPROVED", actor: "test" }, db);
  return ready;
}

async function makeWorker() {
  const worker = await createWorker({}, db);
  track("worker", worker.id);
  return worker;
}

async function trackTaskScope(taskId: string): Promise<void> {
  // Child rows first in push order are deleted... pushed LAST here so the
  // reverse-order cleanup deletes them BEFORE the task/worker/feature rows
  // pushed during setup (FK restrict otherwise fails the delete).
  // Push order mirrors trackRunScope (cli-run): reverse-order cleanup then
  // deletes events → testRuns → artifacts → commits before workers/tasks.
  for (const row of await db.commit.findMany({ where: { taskId }, select: { id: true } })) {
    track("commit", row.id);
  }
  for (const row of await db.artifact.findMany({ where: { taskId }, select: { id: true } })) {
    track("artifact", row.id);
  }
  for (const row of await db.testRun.findMany({ where: { taskId }, select: { id: true } })) {
    track("testRun", row.id);
  }
  for (const row of await db.event.findMany({ where: { taskId }, select: { id: true } })) {
    track("event", row.id);
  }
}

function workerIdsFromEvents(events: Array<{ payload: string | null }>): string[] {
  const ids: string[] = [];
  for (const event of events) {
    try {
      const parsed: unknown = JSON.parse(event.payload ?? "");
      const wid = (parsed as { workerId?: unknown } | null)?.workerId;
      if (typeof wid === "string" && !ids.includes(wid)) {
        ids.push(wid);
      }
    } catch {
      // Non-JSON payloads carry no worker linkage.
    }
  }
  return ids;
}

describe("sequential re-execution (M23.1)", () => {
  it("releases the worker link on failure and re-executes the same task with a new worker", async () => {
    const { repoDir, baseCommit } = await initFixtureRepo(PASS_CHECK);
    const { repository, feature } = await setupFeature("retry", repoDir);
    const task = await setupTask(feature.id, "retry-task", [{ resource: "src/a.txt", access: "WRITE" }]);
    const scratch = trackTempPath(await makeTempDir());

    const w1 = await makeWorker();
    const first = await assignTaskToWorker({ taskId: task.id, workerId: w1.id, repositoryId: repository.id, workspaceRoot: join(scratch, "w1") }, db);
    track("workspace", first.workspace.id);
    const failed = await executeTask(
      { taskId: task.id, workerId: w1.id, expectedBaseCommit: baseCommit },
      new FakeWorkerProvider({ failWith: "boom" }),
      db,
    );
    expect(failed.status).toBe("FAILED");
    const dead1 = await db.worker.findUniqueOrThrow({ where: { id: w1.id } });
    expect(dead1.status).toBe("FAILED");
    // M23.1 item 10: terminal failure releases the reservation; status stays terminal.
    expect(dead1.taskId).toBeNull();

    const ready = await transitionTask(task.id, "READY", db);
    expect(ready.status).toBe("READY");
    const w2 = await makeWorker();
    expect(w2.id).not.toBe(w1.id);
    const second = await assignTaskToWorker({ taskId: task.id, workerId: w2.id, repositoryId: repository.id, workspaceRoot: join(scratch, "w2") }, db);
    track("workspace", second.workspace.id);
    const done = await executeTask(
      { taskId: task.id, workerId: w2.id, expectedBaseCommit: baseCommit },
      new FakeWorkerProvider({ files: { "src/a.txt": "a\n" }, commitMessage: "second attempt" }),
      db,
    );
    expect(done.status).toBe("COMPLETED");
    const testRun = await runTests({ taskId: task.id, workdir: second.workspace.path, command: ["node", "check.mjs"] }, db);
    expect(testRun.status).toBe("PASSED");
    const verification = await verifyExecution({ taskId: task.id, workerId: w2.id, expectedBaseCommit: baseCommit, testRunId: testRun.testRunId }, db);
    expect(verification.verdict).toBe("VERIFIED");

    const assigned = await db.event.findMany({ where: { taskId: task.id, type: "WORKER_ASSIGNED" } });
    expect(workerIdsFromEvents(assigned).sort()).toEqual([w1.id, w2.id].sort());
    expect(await db.event.count({ where: { taskId: task.id, type: "TASK_FAILED" } })).toBe(1);
    expect(await db.event.count({ where: { taskId: task.id, type: "TASK_COMPLETED" } })).toBe(1);
    await trackTaskScope(task.id);
  });

  it("records a second failure with evidence intact and no lingering reservation", async () => {
    const { repoDir, baseCommit } = await initFixtureRepo(PASS_CHECK);
    const { repository, feature } = await setupFeature("failtwice", repoDir);
    const task = await setupTask(feature.id, "fail-twice", [{ resource: "src/a.txt", access: "WRITE" }]);
    const scratch = trackTempPath(await makeTempDir());

    for (const attempt of ["first", "second"]) {
      if (attempt === "second") {
        await transitionTask(task.id, "READY", db);
      }
      const worker = await makeWorker();
      const assignment = await assignTaskToWorker(
        { taskId: task.id, workerId: worker.id, repositoryId: repository.id, workspaceRoot: join(scratch, attempt) },
        db,
      );
      track("workspace", assignment.workspace.id);
      const outcome = await executeTask(
        { taskId: task.id, workerId: worker.id, expectedBaseCommit: baseCommit },
        new FakeWorkerProvider({ failWith: `${attempt} failure` }),
        db,
      );
      expect(outcome.status).toBe("FAILED");
      expect((await db.worker.findUniqueOrThrow({ where: { id: worker.id } })).taskId).toBeNull();
    }
    expect(await db.event.count({ where: { taskId: task.id, type: "TASK_FAILED" } })).toBe(2);
    await trackTaskScope(task.id);
  });

  it("rework after verification rejection executes again with a new worker", async () => {
    const { repoDir, baseCommit } = await initFixtureRepo(STRICT_B_CHECK);
    const { repository, feature } = await setupFeature("rework", repoDir);
    const task = await setupTask(feature.id, "rework-task", [{ resource: "src/a.txt", access: "WRITE" }]);
    const scratch = trackTempPath(await makeTempDir());

    const w1 = await makeWorker();
    const first = await assignTaskToWorker({ taskId: task.id, workerId: w1.id, repositoryId: repository.id, workspaceRoot: join(scratch, "w1") }, db);
    track("workspace", first.workspace.id);
    await executeTask(
      { taskId: task.id, workerId: w1.id, expectedBaseCommit: baseCommit },
      new FakeWorkerProvider({ files: { "src/a.txt": "a\n" }, commitMessage: "wrong content" }),
      db,
    );
    const badTests = await runTests({ taskId: task.id, workdir: first.workspace.path, command: ["node", "check.mjs"] }, db);
    expect(badTests.status).toBe("FAILED");
    const rejected = await verifyExecution({ taskId: task.id, workerId: w1.id, expectedBaseCommit: baseCommit, testRunId: badTests.testRunId }, db);
    expect(rejected.verdict).toBe("REJECTED");
    expect((await db.task.findUniqueOrThrow({ where: { id: task.id } })).status).toBe("VERIFICATION");

    // Operator-driven rework through the supported M22 command.
    await runTaskTransitionCommand({ taskId: task.id, to: "FAILED", actor: "op", reason: "wrong content" }, db);
    await runTaskTransitionCommand({ taskId: task.id, to: "READY", actor: "op", reason: "reschedule rework" }, db);

    const w2 = await makeWorker();
    const second = await assignTaskToWorker({ taskId: task.id, workerId: w2.id, repositoryId: repository.id, workspaceRoot: join(scratch, "w2") }, db);
    track("workspace", second.workspace.id);
    expect(second.worker.id).not.toBe(w1.id);
    await executeTask(
      { taskId: task.id, workerId: w2.id, expectedBaseCommit: baseCommit },
      new FakeWorkerProvider({ files: { "src/a.txt": "b\n" }, commitMessage: "right content" }),
      db,
    );
    const goodTests = await runTests({ taskId: task.id, workdir: second.workspace.path, command: ["node", "check.mjs"] }, db);
    expect(goodTests.status).toBe("PASSED");
    const verified = await verifyExecution({ taskId: task.id, workerId: w2.id, expectedBaseCommit: baseCommit, testRunId: goodTests.testRunId }, db);
    expect(verified.verdict).toBe("VERIFIED");
    await trackTaskScope(task.id);
  });

  it("stranded recovery reschedules into a fresh execution", async () => {
    const { repoDir, baseCommit } = await initFixtureRepo(PASS_CHECK);
    const { repository, feature } = await setupFeature("recovexec", repoDir);
    const task = await setupTask(feature.id, "recover-then-run", [{ resource: "src/a.txt", access: "WRITE" }]);
    const scratch = trackTempPath(await makeTempDir());

    const stranded = await makeWorker();
    const assignment = await assignTaskToWorker(
      { taskId: task.id, workerId: stranded.id, repositoryId: repository.id, workspaceRoot: join(scratch, "stranded") },
      db,
    );
    track("workspace", assignment.workspace.id);
    const recovered = await recoverStrandedAssignment({ taskId: task.id, actor: "op" }, db);
    expect(recovered.taskId).toBe(task.id);
    expect((await db.task.findUniqueOrThrow({ where: { id: task.id } })).status).toBe("READY");
    expect((await db.worker.findUniqueOrThrow({ where: { id: stranded.id } })).status).toBe("IDLE");

    const w2 = await makeWorker();
    const second = await assignTaskToWorker({ taskId: task.id, workerId: w2.id, repositoryId: repository.id, workspaceRoot: join(scratch, "w2") }, db);
    track("workspace", second.workspace.id);
    const done = await executeTask(
      { taskId: task.id, workerId: w2.id, expectedBaseCommit: baseCommit },
      new FakeWorkerProvider({ files: { "src/a.txt": "a\n" }, commitMessage: "post-recovery work" }),
      db,
    );
    expect(done.status).toBe("COMPLETED");
    await trackTaskScope(task.id);
  });

  it("releases a legacy stale reservation at assignment time", async () => {
    const { repoDir } = await initFixtureRepo(PASS_CHECK);
    const { repository, feature } = await setupFeature("legacy", repoDir);
    const task = await setupTask(feature.id, "legacy-task", [{ resource: "src/a.txt", access: "WRITE" }]);
    const scratch = trackTempPath(await makeTempDir());

    // Simulate a pre-fix row: terminal worker still reserving a READY task.
    const legacy = await makeWorker();
    await db.worker.update({ where: { id: legacy.id }, data: { status: "COMPLETED", taskId: task.id } });

    const fresh = await makeWorker();
    const assignment = await assignTaskToWorker(
      { taskId: task.id, workerId: fresh.id, repositoryId: repository.id, workspaceRoot: join(scratch, "fresh") },
      db,
    );
    track("workspace", assignment.workspace.id);
    expect(assignment.worker.id).toBe(fresh.id);
    expect((await db.worker.findUniqueOrThrow({ where: { id: legacy.id } })).taskId).toBeNull();
    expect((await db.worker.findUniqueOrThrow({ where: { id: fresh.id } })).taskId).toBe(task.id);
    await trackTaskScope(task.id);
  });

  it("refuses a genuine concurrent assignment with a live-owner message and no leak", async () => {
    const { repoDir } = await initFixtureRepo(PASS_CHECK);
    const { repository, feature } = await setupFeature("race", repoDir);
    const task = await setupTask(feature.id, "race-task", [{ resource: "src/a.txt", access: "WRITE" }]);
    const scratch = trackTempPath(await makeTempDir());
    const wa = await makeWorker();
    const wb = await makeWorker();

    const [ra, rb] = await Promise.allSettled([
      assignTaskToWorker({ taskId: task.id, workerId: wa.id, repositoryId: repository.id, workspaceRoot: join(scratch, "wa") }, db),
      assignTaskToWorker({ taskId: task.id, workerId: wb.id, repositoryId: repository.id, workspaceRoot: join(scratch, "wb") }, db),
    ]);
    const fulfilled = [ra, rb].filter((r) => r.status === "fulfilled");
    const rejected = [ra, rb].filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const loser = (rejected[0] as PromiseRejectedResult).reason as Error & { originalError?: unknown };
    // Either guard may win the race (pre-tx check, in-tx check, or P2002);
    // all genuine-concurrency refusals derive from TaskAssignmentError and
    // name the live owner or the race — never a stale link, never silent.
    expect(loser).toBeInstanceOf(TaskAssignmentError);
    const texts = [loser.message, String((loser.originalError as Error | undefined)?.message ?? "")].join(" | ");
    expect(texts).toMatch(/already assigned|live worker|concurrent assignment race/);

    const winnerId = wa.id === (fulfilled[0] as PromiseFulfilledResult<{ worker: { id: string } }>).value.worker.id ? wa.id : wb.id;
    const loserId = winnerId === wa.id ? wb.id : wa.id;
    expect((await db.task.findUniqueOrThrow({ where: { id: task.id } })).status).toBe("CLAIMED");
    expect((await db.worker.findUniqueOrThrow({ where: { id: winnerId } })).taskId).toBe(task.id);
    const claimed = await db.worker.findMany({ where: { taskId: task.id } });
    expect(claimed.map((w) => w.id)).toEqual([winnerId]);
    const winner = (fulfilled[0] as PromiseFulfilledResult<{ workspace: { id: string } }>).value;
    track("workspace", winner.workspace.id);
    // Loser compensated its worktree: no registration leak under the loser id.
    const listed = await runGit(["worktree", "list", "--porcelain"], { cwd: repoDir });
    expect(listed).not.toContain(loserId);
    await trackTaskScope(task.id);
  });

  it("merge train releases integrated links only after verification and preserves halted links", async () => {
    const { repoDir, baseCommit } = await initFixtureRepo("process.exit(0);\n", true);
    const { repository, feature } = await setupFeature("trainrel", repoDir);
    const scratch = trackTempPath(await makeTempDir());
    const claims = [{ resource: "src/a.txt", access: "WRITE" }] as const;
    const t1 = await setupTask(feature.id, "train-one", [...claims]);
    const t2 = await setupTask(feature.id, "train-two", [...claims]);

    const w1 = await makeWorker();
    const a1 = await assignTaskToWorker({ taskId: t1.id, workerId: w1.id, repositoryId: repository.id, workspaceRoot: join(scratch, "w1") }, db);
    track("workspace", a1.workspace.id);
    await executeTask({ taskId: t1.id, workerId: w1.id, expectedBaseCommit: baseCommit }, new FakeWorkerProvider({ files: { "src/a.txt": "one\n" }, commitMessage: "one" }), db);
    const tr1 = await runTests({ taskId: t1.id, workdir: a1.workspace.path, command: ["node", "check.mjs"] }, db);
    const v1 = await verifyExecution({ taskId: t1.id, workerId: w1.id, expectedBaseCommit: baseCommit, testRunId: tr1.testRunId }, db);
    expect(v1.verdict).toBe("VERIFIED");

    const w2 = await makeWorker();
    const a2 = await assignTaskToWorker({ taskId: t2.id, workerId: w2.id, repositoryId: repository.id, workspaceRoot: join(scratch, "w2") }, db);
    track("workspace", a2.workspace.id);
    await executeTask({ taskId: t2.id, workerId: w2.id, expectedBaseCommit: baseCommit }, new FakeWorkerProvider({ files: { "src/a.txt": "two\n" }, commitMessage: "two" }), db);
    const tr2 = await runTests({ taskId: t2.id, workdir: a2.workspace.path, command: ["node", "check.mjs"] }, db);
    const v2 = await verifyExecution({ taskId: t2.id, workerId: w2.id, expectedBaseCommit: baseCommit, testRunId: tr2.testRunId }, db);
    expect(v2.verdict).toBe("VERIFIED");

    const approval = await createApproval({ featureId: feature.id }, db);
    track("approval", approval.id);
    await decideApproval(approval.id, { decision: "APPROVED", actor: "op" }, db);
    const train = await runMergeTrain(
      {
        approvalId: approval.id,
        repositoryId: repository.id,
        baseCommit,
        trainBranch: `atlas/m23x/${uniqueName("train")}`,
        trainPath: join(scratch, "train"),
        items: [
          { taskId: t1.id, workerId: w1.id, expectedBaseCommit: baseCommit, testRunId: tr1.testRunId, sequence: 1 },
          { taskId: t2.id, workerId: w2.id, expectedBaseCommit: baseCommit, testRunId: tr2.testRunId, sequence: 2 },
        ],
      },
      db,
    );
    expect(train.status).toBe("HALTED");
    expect(train.items.find((i) => i.taskId === t1.id)?.status).toBe("INTEGRATED");
    expect(train.items.find((i) => i.taskId === t2.id)?.status).toBe("CONFLICT");
    // INTEGRATED consumed the live link (after re-verification + merge commit)...
    expect((await db.worker.findUniqueOrThrow({ where: { id: w1.id } })).taskId).toBeNull();
    expect((await db.worker.findUniqueOrThrow({ where: { id: w1.id } })).status).toBe("COMPLETED");
    // ...while the halted item keeps the link its diagnosis/rework needs.
    expect((await db.worker.findUniqueOrThrow({ where: { id: w2.id } })).taskId).toBe(t2.id);
    await trackTaskScope(t1.id);
    await trackTaskScope(t2.id);
  }, 120000);

  it("full CLI loop fails, transitions, and executes the same task again (M23 regression)", async () => {
    const { repoDir } = await initFixtureRepo(PASS_CHECK);
    const { feature } = await setupFeature("cliloop", repoDir);
    const scratch = trackTempPath(await makeTempDir());
    const proposalPath = join(scratch, "proposal.json");
    await writeFile(
      proposalPath,
      JSON.stringify({
        featureId: feature.id,
        tasks: [{ id: "solo", title: "Solo task", claims: [{ resource: "src/a.txt", access: "WRITE" }] }],
        dependencies: [],
      }),
    );
    const planned = await runPlanCommand({ featureId: feature.id, proposal: proposalPath, approve: true, actor: "op" }, db);
    const approvalId = (planned.data as { approval: { id: string } }).approval.id;
    const repositoryId = (await db.repository.findFirstOrThrow({ where: { projectId: feature.projectId } })).id;
    const taskId = (await db.task.findFirstOrThrow({ where: { featureId: feature.id } })).id;
    track("task", taskId);
    const agent = process.execPath;

    const first = await runRunCommand(
      {
        featureId: feature.id,
        repositoryId,
        planApproval: approvalId,
        actor: "op",
        agent,
        agentArg: [AGENT, "--fail", "first attempt fails"],
        approveMerge: true,
        workspaceRoot: join(scratch, "work1"),
        trainPath: join(scratch, "train1"),
      },
      db,
    );
    expect(first.exitCode).not.toBe(0);
    const failedWorker = (await db.event.findFirstOrThrow({ where: { taskId, type: "TASK_FAILED" } }));
    expect(JSON.parse(failedWorker.payload ?? "{}").workerId).toBeDefined();

    await runTaskTransitionCommand({ taskId, to: "READY", actor: "op", reason: "retry after failure" }, db);

    const second = await runRunCommand(
      {
        featureId: feature.id,
        repositoryId,
        planApproval: approvalId,
        actor: "op",
        agent,
        agentArg: [AGENT, "--write", "src/a.txt=a\n", "--commit", "second attempt"],
        approveMerge: true,
        workspaceRoot: join(scratch, "work2"),
        trainPath: join(scratch, "train2"),
      },
      db,
    );
    expect(second.exitCode).toBe(0);
    const data = second.data as { outcomes: Array<{ taskId: string; verification?: { verdict?: string } }>; train?: { status?: string } };
    expect(data.outcomes).toHaveLength(1);
    expect(data.outcomes[0]?.verification?.verdict).toBe("VERIFIED");
    expect(data.train?.status).toBe("COMPLETED");

    // Different workers across attempts; both attempts in history.
    const assigned = await db.event.findMany({ where: { taskId, type: "WORKER_ASSIGNED" } });
    expect(workerIdsFromEvents(assigned)).toHaveLength(2);
    expect(workerIdsFromEvents(assigned)[0]).not.toBe(workerIdsFromEvents(assigned)[1]);
    expect(await db.event.count({ where: { taskId, type: "TASK_FAILED" } })).toBe(1);

    // Historical display stays truthful after releases.
    const shown = await runShowTaskCommand({ taskId }, db);
    const shownWorker = (shown.data as { worker: { id: string; status: string; link?: string } | null }).worker;
    expect(shownWorker?.link).toBe("historical");
    expect(shown.human).toContain("historical");
    const diagnose = await runDiagnoseCommand({ runId: feature.id }, db);
    expect(diagnose.human).toContain("COMPLETED");
    const runShown = await runShowRunCommand({ runId: feature.id }, db);
    expect(runShown.human).toContain("historical");
    const historicalWorkerId = workerIdsFromEvents(assigned)[1] as string;
    const workerShown = await runShowWorkerCommand({ workerId: historicalWorkerId }, db);
    expect(workerShown.human).toContain("historical");

    // Track everything this loop created (released links are invisible to link-based lookups).
    for (const row of await db.worker.findMany({ where: { id: { in: workerIdsFromEvents(assigned) } } })) {
      track("worker", row.id);
    }
    for (const row of await db.workspace.findMany({ where: { workerId: { in: workerIdsFromEvents(assigned) } } })) {
      track("workspace", row.id);
    }
    for (const row of await db.approval.findMany({ where: { featureId: feature.id } })) track("approval", row.id);
    for (const row of await db.commit.findMany({ where: { taskId } })) track("commit", row.id);
    for (const row of await db.artifact.findMany({ where: { taskId } })) track("artifact", row.id);
    for (const row of await db.testRun.findMany({ where: { taskId } })) track("testRun", row.id);
    for (const row of await db.event.findMany({ where: { taskId } })) track("event", row.id);
  }, 180000);
});
