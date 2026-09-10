import { realpath } from "node:fs/promises";
import type { PrismaClient } from "@prisma/client";
import { getPrismaClient } from "../db/client.js";
import { NotFoundError } from "../core/errors.js";
import { recordArtifact } from "../core/service.js";
import { getTaskClaims } from "../claims/service.js";
import { resourceOverlaps } from "../claims/conflicts.js";
import { getCurrentCommit, getRepositoryRoot, getWorktree, runGit } from "../git/index.js";
import { getWorktreeChanges } from "../git/diff.js";
import {
  VerifyExecutionInputSchema,
  type VerificationCheck,
  type VerificationReason,
  type VerificationResult,
} from "./types.js";

const CHECK_NAMES = ["links-valid", "workspace-registered", "base-ancestor", "claims-hold", "tests-passed"] as const;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Independently evaluate completed worker output. Re-derives everything from
 * Atlas state (links, claims) and Git truth (registration, ancestry, diff)
 * instead of trusting the execution result; cites one Atlas-executed TestRun
 * as test evidence. Deterministic: fixed check order, sorted paths, no LLM.
 * Returns a verdict for every outcome — only malformed input throws (Zod).
 */
export async function verifyExecution(
  raw: unknown,
  db: PrismaClient = getPrismaClient(),
): Promise<VerificationResult> {
  const input = VerifyExecutionInputSchema.parse(raw);
  const checks: VerificationCheck[] = [];
  const reasons: VerificationReason[] = [];
  const record = (name: string, passed: boolean, detail: string): void => {
    checks.push({ name, passed, detail });
  };
  const skipRemaining = (fromIndex: number, detail: string): void => {
    for (let index = fromIndex; index < CHECK_NAMES.length; index += 1) {
      const name = CHECK_NAMES[index];
      if (name !== undefined) {
        record(name, false, detail);
      }
    }
  };
  const finish = async (
    verdict: VerificationResult["verdict"],
    commit: string,
    changedResources: string[],
    workspacePath: string,
  ): Promise<VerificationResult> => {
    const artifact = await recordArtifact(
      {
        taskId: input.taskId,
        type: "ANALYSIS_REPORT",
        label: `verification task=${input.taskId} verdict=${verdict}`,
        location: workspacePath,
      },
      db,
    );
    return {
      verdict,
      taskId: input.taskId,
      workerId: input.workerId,
      testRunId: input.testRunId,
      commit,
      checks,
      reasons,
      changedResources,
      artifactId: artifact.id,
    };
  };
  const reject = async (
    reason: VerificationReason,
    commit: string,
    changedResources: string[],
    workspacePath: string,
    failedCheckIndex: number,
  ): Promise<VerificationResult> => {
    reasons.push(reason);
    skipRemaining(failedCheckIndex + 1, `skipped: ${reason}`);
    return finish("REJECTED", commit, changedResources, workspacePath);
  };

  // 1. Links: entities exist and worker → task → workspace form one chain.
  // Missing rows throw (M4/M8 convention) — verdicts evaluate present state.
  const task = await db.task.findUnique({ where: { id: input.taskId } });
  if (task === null) {
    throw new NotFoundError("Task", input.taskId);
  }
  const worker = await db.worker.findUnique({ where: { id: input.workerId }, include: { workspace: true } });
  if (worker === null) {
    throw new NotFoundError("Worker", input.workerId);
  }
  if (worker.taskId !== task.id || worker.workspace === null) {
    record("links-valid", false, "worker/task/workspace link is broken");
    return reject("LINK_INVALID", "", [], input.workerId, 0);
  }
  if (worker.workspace.workerId !== worker.id) {
    record("links-valid", false, "workspace is linked to a different worker");
    return reject("LINK_INVALID", "", [], input.workerId, 0);
  }
  record("links-valid", true, "worker → task → workspace chain is intact");
  const workspace = worker.workspace;

  // 2. Workspace: registered worktree, never main, branch matches the record.
  let realPath = workspace.path;
  let head = "";
  try {
    realPath = await realpath(workspace.path);
    const root = await getRepositoryRoot(realPath);
    const info = await getWorktree(root, realPath);
    if (info.isMain) {
      throw new Error("main repository worktree cannot be verified as worker output");
    }
    const infoReal = await realpath(info.path);
    if (infoReal !== realPath) {
      throw new Error("workspace path does not match registered worktree");
    }
    if (workspace.branch !== null && info.branch !== null && workspace.branch !== info.branch) {
      throw new Error("workspace branch does not match worktree branch");
    }
    head = await getCurrentCommit(realPath);
  } catch (error) {
    record("workspace-registered", false, errorMessage(error));
    return reject("WORKSPACE_INVALID", head, [], realPath, 1);
  }
  record("workspace-registered", true, `registered worktree at ${head.slice(0, 12)}`);

  // 3. Base ancestry: the work must be built on the expected base commit.
  try {
    await runGit(["merge-base", "--is-ancestor", input.expectedBaseCommit, head], { cwd: realPath });
  } catch {
    record("base-ancestor", false, `${input.expectedBaseCommit.slice(0, 12)} is not an ancestor of ${head.slice(0, 12)}`);
    return reject("BASE_MISMATCH", head, [], realPath, 2);
  }
  record("base-ancestor", true, "work is built on the expected base commit");

  // 4. Claims: every actual modification covered by a WRITE claim (M5 semantics).
  let changedResources: string[];
  try {
    const changes = await getWorktreeChanges(realPath, input.expectedBaseCommit);
    const paths = new Set<string>();
    for (const change of changes) {
      paths.add(change.path);
      if (change.oldPath !== undefined) {
        paths.add(change.oldPath);
      }
    }
    changedResources = [...paths].sort();
  } catch (error) {
    record("claims-hold", false, `diff inspection failed: ${errorMessage(error)}`);
    return reject("WORKSPACE_INVALID", head, [], realPath, 3);
  }
  const declared = await getTaskClaims(task.id, db);
  const undeclared = changedResources.filter(
    (path) => !declared.some((claim) => claim.access === "WRITE" && resourceOverlaps(path, claim.resourceId)),
  );
  if (undeclared.length > 0) {
    record("claims-hold", false, `undeclared modifications: ${undeclared.join(", ")}`);
    return reject("CLAIM_VIOLATION", head, changedResources, realPath, 3);
  }
  record(
    "claims-hold",
    true,
    changedResources.length === 0 ? "no modifications" : `${changedResources.length} modification(s) covered by WRITE claims`,
  );

  // 5. Tests: one cited Atlas-executed run, belonging to this task, PASSED with exit 0.
  const testRun = await db.testRun.findUnique({ where: { id: input.testRunId } });
  if (testRun === null) {
    throw new NotFoundError("TestRun", input.testRunId);
  }
  if (testRun.taskId !== task.id || testRun.status !== "PASSED" || testRun.exitCode !== 0) {
    record(
      "tests-passed",
      false,
      `test run ${testRun.id} is not passing evidence (task=${testRun.taskId}, status=${testRun.status}, exit=${testRun.exitCode})`,
    );
    return reject("TESTS_NOT_PASSED", head, changedResources, realPath, 4);
  }
  record("tests-passed", true, `test run ${testRun.id} passed with exit code 0`);

  return finish("VERIFIED", head, changedResources, realPath);
}
