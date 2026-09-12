import { mkdir, writeFile } from "node:fs/promises";
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
import { CommandWorkerProvider } from "../src/workers/index.js";
import { runFeatureWaveLoop } from "../src/orchestrator/index.js";
import { TriageError, triageIntegrationHalt } from "../src/triage/index.js";
import { track, uniqueName } from "./domain-helpers.js";
import { makeTempDir } from "./git-helpers.js";

const db = getPrismaClient();
const AGENT = fileURLToPath(new URL("./fixtures/script-agent.mjs", import.meta.url));

interface TaskDef {
  readonly key: string;
  readonly claims: ReadonlyArray<{ resource: string; access: "READ" | "WRITE" }>;
  readonly dependsOn?: readonly string[];
}

interface TriageFixture {
  readonly featureId: string;
  readonly repositoryId: string;
  readonly repoDir: string;
  readonly baseCommit: string;
  readonly taskIds: Map<string, string>;
  readonly scratchRoot: string;
}

function allowedCheck(allowed: Record<string, string[]>): string {
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
  if (!allowed.includes(actual)) { console.error("unexpected " + rel); process.exit(1); }
}
${cases}
process.exit(0);
`;
}

const EXCLUSIVE_CHECK = `import { existsSync, readFileSync } from "node:fs";
const hasA = existsSync("src/a.txt") && readFileSync("src/a.txt", "utf8") === "a\\n";
const hasB = existsSync("src/b.txt") && readFileSync("src/b.txt", "utf8") === "b\\n";
if (hasA && hasB) { console.error("both present"); process.exit(1); }
process.exit(0);
`;

async function initFixtureRepo(baseFiles: Record<string, string>, check: string): Promise<{ repoDir: string; baseCommit: string }> {
  const dir = await makeTempDir();
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "m13-fixture", scripts: { test: "node check.mjs" } }));
  await writeFile(join(dir, "check.mjs"), check);
  for (const [rel, content] of Object.entries(baseFiles)) {
    const absolute = join(dir, rel);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
  await runGit(["init", "-b", "main"], { cwd: dir });
  await runGit(["config", "user.email", "m13-test@example.invalid"], { cwd: dir });
  await runGit(["config", "user.name", "M13 Test"], { cwd: dir });
  await runGit(["add", "-A"], { cwd: dir });
  await runGit(["-c", "commit.gpgsign=false", "commit", "-m", "m13 fixture"], { cwd: dir });
  return { repoDir: dir, baseCommit: await getCurrentCommit(dir) };
}

async function setupTriageFeature(repoDir: string, defs: TaskDef[]): Promise<Omit<TriageFixture, "repoDir" | "baseCommit">> {
  const project = await createProject({ name: uniqueName("m13-triage"), description: "triage test" }, db);
  track("project", project.id);
  const repository = await createRepository({ projectId: project.id, name: "main", localPath: repoDir }, db);
  track("repository", repository.id);
  const feature = await createFeature({ projectId: project.id, title: "triage feature" }, db);
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
      const edge = await createTaskDependency(
        { taskId: taskIds.get(def.key) as string, dependsOnTaskId: taskIds.get(dep) as string },
        db,
      );
      track("taskDependency", edge.id);
    }
  }
  return { featureId: feature.id, repositoryId: repository.id, taskIds, scratchRoot: await makeTempDir() };
}

function providersFor(taskIds: Map<string, string>, behaviors: Record<string, { args: string[]; timeoutMs?: number }>) {
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

interface LoopArgs {
  readonly fixture: TriageFixture;
  readonly baseCommit: string;
  readonly behaviors: Record<string, { args: string[] }>;
}

async function runHaltedLoop({ fixture, baseCommit, behaviors }: LoopArgs) {
  return runFeatureWaveLoop(
    {
      featureId: fixture.featureId,
      repositoryId: fixture.repositoryId,
      baseCommit,
      workspaceRoot: fixture.scratchRoot,
      trainBranch: `atlas/m13/${uniqueName("train")}`,
      trainPath: join(fixture.scratchRoot, "train"),
      approvalActor: "m13-test",
      testCommand: ["node", "check.mjs"],
      maxConcurrency: 4,
    },
    { createProvider: providersFor(fixture.taskIds, behaviors), track },
    db,
  );
}

async function branchSha(repoDir: string, branch: string): Promise<string> {
  const result = await runGit(["rev-parse", branch], { cwd: repoDir });
  return result.stdout.trim();
}

async function workerBranch(repoDir: string, workerId: string): Promise<string> {
  const worker = await db.worker.findUniqueOrThrow({ where: { id: workerId }, include: { workspace: true } });
  const branch = worker.workspace?.branch;
  if (branch === undefined || branch === null) {
    throw new Error(`worker ${workerId} has no branch`);
  }
  void repoDir;
  return branch;
}

describe("integration triage", () => {
  it("turns a shared-write halt into CLAIM_CONFLICT + GIT_CONFLICT evidence", async () => {
    const { repoDir, baseCommit } = await initFixtureRepo(
      { "shared/counter.txt": "count: 0\n" },
      allowedCheck({ "shared/counter.txt": ["count: 0\n", "count: 0\nupdated: alpha\n", "count: 0\nupdated: beta\n"] }),
    );
    const fixture = await setupTriageFeature(repoDir, [
      { key: "alpha", claims: [{ resource: "shared/counter.txt", access: "WRITE" }] },
      { key: "beta", claims: [{ resource: "shared/counter.txt", access: "WRITE" }] },
    ]);

    const result = await runHaltedLoop({
      fixture,
      baseCommit,
      behaviors: {
        alpha: { args: ["--write", "shared/counter.txt=count: 0\nupdated: alpha\n", "--commit", "alpha"] },
        beta: { args: ["--write", "shared/counter.txt=count: 0\nupdated: beta\n", "--commit", "beta"] },
      },
    });

    // Full M11 wave loop still reports HALTED when integration fails.
    expect(result.train?.status).toBe("HALTED");
    const triage = result.triage;
    expect(triage).not.toBeNull();
    expect(triage?.classifications).toEqual(["CLAIM_CONFLICT", "GIT_CONFLICT"]);
    expect(triage?.conflictFiles).toEqual(["shared/counter.txt"]);
    expect(triage?.haltedTaskId).toBeDefined();
    // Ownership is proven from branch diffs: exactly one earlier owner.
    expect(triage?.ownership).toHaveLength(1);
    expect(triage?.ownership[0]?.owners).toHaveLength(1);
    expect(triage?.ownership[0]?.unknownOwner).toBe(false);
    // Declared claims cover the conflict file on both sides.
    const covering = triage?.ownership[0]?.coveringClaims ?? [];
    expect(covering.length).toBeGreaterThanOrEqual(2);
    // Claim overlap details name the overlapping resources.
    expect(triage?.claimOverlap).toHaveLength(1);
    expect(triage?.claimOverlap[0]?.details[0]?.kind).toBe("WRITE_WRITE");
    // Actions stay advisory vocabulary.
    expect(triage?.recommendedActions).toContain("review-conflicting-files");
    expect(triage?.recommendedActions).toContain("revise-claims");
    // Evidence artifact persisted; main untouched.
    const artifact = await db.artifact.findUniqueOrThrow({ where: { id: triage?.evidenceRefs.artifactId as string } });
    expect(artifact.type).toBe("ANALYSIS_REPORT");
    expect(await getCurrentCommit(repoDir)).toBe(baseCommit);
  }, 180000);

  it("is deterministic and leaves main, branches, and train worktree unchanged", async () => {
    const { repoDir, baseCommit } = await initFixtureRepo(
      { "shared/counter.txt": "count: 0\n" },
      allowedCheck({ "shared/counter.txt": ["count: 0\n", "count: 0\nupdated: alpha\n", "count: 0\nupdated: beta\n"] }),
    );
    const fixture = await setupTriageFeature(repoDir, [
      { key: "alpha", claims: [{ resource: "shared/counter.txt", access: "WRITE" }] },
      { key: "beta", claims: [{ resource: "shared/counter.txt", access: "WRITE" }] },
    ]);

    const result = await runHaltedLoop({
      fixture,
      baseCommit,
      behaviors: {
        alpha: { args: ["--write", "shared/counter.txt=count: 0\nupdated: alpha\n", "--commit", "alpha"] },
        beta: { args: ["--write", "shared/counter.txt=count: 0\nupdated: beta\n", "--commit", "beta"] },
      },
    });
    expect(result.train?.status).toBe("HALTED");
    const first = result.triage as NonNullable<typeof result.triage>;
    const trainPath = result.train?.trainPath as string;
    const trainFinal = result.train?.finalCommit as string;

    const branches = new Map<string, string>();
    for (const outcome of result.outcomes) {
      branches.set(outcome.taskId, await branchSha(repoDir, await workerBranch(repoDir, outcome.workerId)));
    }

    // Repeated identical triage produces identical output (modulo artifact id).
    const second = await triageIntegrationHalt(
      {
        repositoryId: fixture.repositoryId,
        baseCommit,
        finalCommit: trainFinal,
        items: (result.train?.items ?? []).map((item) => ({
          taskId: item.taskId,
          workerId: item.workerId,
          status: item.status,
          ...(item.testRunId !== undefined ? { testRunId: item.testRunId } : {}),
          ...(item.mergeCommit !== undefined ? { mergeCommit: item.mergeCommit } : {}),
          ...(item.reason !== undefined ? { reason: item.reason } : {}),
        })),
        scratchParent: await makeTempDir(),
      },
      db,
    );
    track("artifact", second.evidenceRefs.artifactId);
    const { evidenceRefs: _a, ...firstRest } = first as unknown as Record<string, unknown>;
    const { evidenceRefs: _b, ...secondRest } = second as unknown as Record<string, unknown>;
    void _a;
    void _b;
    expect(secondRest).toEqual(firstRest);
    expect(second.evidenceRefs.mergeCommits).toEqual(first.evidenceRefs.mergeCommits);

    // Nothing moved: worker branches, main, and the train worktree.
    for (const outcome of result.outcomes) {
      expect(await branchSha(repoDir, await workerBranch(repoDir, outcome.workerId))).toBe(branches.get(outcome.taskId));
    }
    expect(await getCurrentCommit(repoDir)).toBe(baseCommit);
    expect(await getCurrentCommit(trainPath)).toBe(trainFinal);
    expect(await isClean(trainPath)).toBe(true);

    // Throwaway replay resources are gone.
    const worktrees = await runGit(["worktree", "list", "--porcelain"], { cwd: repoDir });
    expect(worktrees.stdout).not.toContain("replay-");
    const triageBranches = await runGit(["branch", "--list", "atlas/triage/*"], { cwd: repoDir });
    expect(triageBranches.stdout.trim()).toBe("");
  }, 240000);

  it("reports dependency direction between colliding tasks", async () => {
    const { repoDir, baseCommit } = await initFixtureRepo(
      { "src/f.txt": "base\n" },
      allowedCheck({ "src/f.txt": ["base\n", "a\n", "b\n"] }),
    );
    const fixture = await setupTriageFeature(repoDir, [
      { key: "a", claims: [{ resource: "src/f.txt", access: "WRITE" }] },
      { key: "b", claims: [{ resource: "src/f.txt", access: "WRITE" }], dependsOn: ["a"] },
    ]);

    const result = await runHaltedLoop({
      fixture,
      baseCommit,
      behaviors: {
        a: { args: ["--write", "src/f.txt=a\n", "--commit", "a"] },
        b: { args: ["--write", "src/f.txt=b\n", "--commit", "b"] },
      },
    });

    expect(result.waves).toHaveLength(2);
    expect(result.train?.status).toBe("HALTED");
    const triage = result.triage as NonNullable<typeof result.triage>;
    const halted = triage.haltedTaskId;
    const other = [fixture.taskIds.get("a"), fixture.taskIds.get("b")].find((id) => id !== halted) as string;
    expect(triage.classifications).toContain("DEPENDENCY_ORDERING");
    expect(triage.dependencyLinks).toContainEqual({ taskId: halted, dependsOnTaskId: other, direction: "halted-waits-for-owner" });
  }, 180000);

  it("reports UNKNOWN rather than inventing ownership", async () => {
    const { repoDir, baseCommit } = await initFixtureRepo(
      { "shared/counter.txt": "count: 0\n" },
      allowedCheck({ "shared/counter.txt": ["count: 0\n", "count: 0\nupdated: alpha\n", "count: 0\nupdated: beta\n"] }),
    );
    const fixture = await setupTriageFeature(repoDir, [
      { key: "alpha", claims: [{ resource: "shared/counter.txt", access: "WRITE" }] },
      { key: "beta", claims: [{ resource: "shared/counter.txt", access: "WRITE" }] },
    ]);

    const result = await runHaltedLoop({
      fixture,
      baseCommit,
      behaviors: {
        alpha: { args: ["--write", "shared/counter.txt=count: 0\nupdated: alpha\n", "--commit", "alpha"] },
        beta: { args: ["--write", "shared/counter.txt=count: 0\nupdated: beta\n", "--commit", "beta"] },
      },
    });
    expect(result.train?.status).toBe("HALTED");
    const triage = result.triage as NonNullable<typeof result.triage>;
    const ownerId = triage.ownership[0]?.owners[0] as string;
    const ownerWorker = await db.worker.findFirstOrThrow({ where: { taskId: ownerId } });

    // Simulate lost provenance: the owner's worker link is gone. Triage must
    // report unknown ownership, not attribute the file to someone else.
    await db.workspace.deleteMany({ where: { workerId: ownerWorker.id } });
    await db.worker.deleteMany({ where: { id: ownerWorker.id } });

    const retried = await triageIntegrationHalt(
      {
        repositoryId: fixture.repositoryId,
        baseCommit,
        finalCommit: result.train?.finalCommit as string,
        items: (result.train?.items ?? []).map((item) => ({
          taskId: item.taskId,
          workerId: item.workerId,
          status: item.status,
          ...(item.testRunId !== undefined ? { testRunId: item.testRunId } : {}),
          ...(item.mergeCommit !== undefined ? { mergeCommit: item.mergeCommit } : {}),
          ...(item.reason !== undefined ? { reason: item.reason } : {}),
        })),
        scratchParent: await makeTempDir(),
      },
      db,
    );
    track("artifact", retried.evidenceRefs.artifactId);
    expect(retried.conflictFiles).toEqual(["shared/counter.txt"]);
    expect(retried.ownership[0]?.owners).toEqual([]);
    expect(retried.ownership[0]?.unknownOwner).toBe(true);
    expect(retried.classifications).toContain("GIT_CONFLICT");
    expect(retried.classifications).toContain("UNKNOWN");
  }, 240000);

  it("flags cumulative test interaction as unproven semantic risk", async () => {
    const { repoDir, baseCommit } = await initFixtureRepo({}, EXCLUSIVE_CHECK);
    const fixture = await setupTriageFeature(repoDir, [
      { key: "a", claims: [{ resource: "src/a.txt", access: "WRITE" }] },
      { key: "b", claims: [{ resource: "src/b.txt", access: "WRITE" }] },
    ]);

    const result = await runHaltedLoop({
      fixture,
      baseCommit,
      behaviors: {
        a: { args: ["--write", "src/a.txt=a\n", "--commit", "a"] },
        b: { args: ["--write", "src/b.txt=b\n", "--commit", "b"] },
      },
    });

    expect(result.train?.status).toBe("HALTED");
    const triage = result.triage as NonNullable<typeof result.triage>;
    // Disjoint claims, no textual conflict: neither claim nor Git finding.
    expect(triage.classifications).not.toContain("GIT_CONFLICT");
    expect(triage.classifications).not.toContain("CLAIM_CONFLICT");
    expect(triage.classifications).toContain("SEMANTIC_RISK");
    const flag = triage.semanticFlags.find((entry) => entry.kind === "CUMULATIVE_TESTS_FAILED");
    expect(flag?.notProven).toBe(true);
    expect(flag?.detail ?? "").toContain("unproven");
  }, 180000);

  it("fails loudly on bad input instead of masking the halt", async () => {
    const { baseCommit } = await initFixtureRepo({}, EXCLUSIVE_CHECK);
    await expect(
      triageIntegrationHalt(
        {
          repositoryId: "no-such-repo",
          baseCommit,
          finalCommit: baseCommit,
          items: [{ taskId: "t", workerId: "w", status: "CONFLICT" }],
          scratchParent: await makeTempDir(),
        },
        db,
      ),
    ).rejects.toThrow(TriageError);
    const { repoDir } = await initFixtureRepo({}, EXCLUSIVE_CHECK);
    const fixture = await setupTriageFeature(repoDir, [
      { key: "a", claims: [{ resource: "src/a.txt", access: "WRITE" }] },
    ]);
    await expect(
      triageIntegrationHalt(
        {
          repositoryId: fixture.repositoryId,
          baseCommit,
          finalCommit: baseCommit,
          items: [{ taskId: fixture.taskIds.get("a") as string, workerId: "w", status: "INTEGRATED" }],
          scratchParent: await makeTempDir(),
        },
        db,
      ),
    ).rejects.toThrow(TriageError);
  }, 120000);
});
