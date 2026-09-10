import type { PrismaClient } from "@prisma/client";
import { getPrismaClient } from "../db/client.js";
import { NotFoundError } from "../core/errors.js";
import {
  assertValidBranchName,
  createWorktree,
  getCurrentCommit,
  getWorktree,
  isClean,
  runGit,
  validateRepository,
} from "../git/index.js";
import { recordArtifact, recordCommit } from "../core/service.js";
import { runTests } from "./tests.js";
import { MergeTrainNotApprovedError } from "./errors.js";
import { MergeTrainInputSchema, type IntegratedItem, type MergeTrainResult } from "./types.js";
import { verifyExecution } from "./verify.js";

const TRAIN_USER_NAME = "Atlas Merge Train";
const TRAIN_USER_EMAIL = "atlas-merge-train@atlas.test";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function unmergedPaths(trainPath: string): Promise<string[]> {
  const result = await runGit(["diff", "--name-only", "--diff-filter=U"], { cwd: trainPath });
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .sort();
}

async function abortMerge(trainPath: string): Promise<void> {
  try {
    await runGit(["merge", "--abort"], { cwd: trainPath });
  } catch {
    // Best effort: the worktree may not be in a merging state.
  }
}

async function recordIntegration(
  db: PrismaClient,
  args: { repositoryId: string; taskId: string; trainBranch: string; trainPath: string; sha: string; subject: string },
): Promise<void> {
  await recordCommit(
    {
      repositoryId: args.repositoryId,
      sha: args.sha,
      branch: args.trainBranch,
      subject: args.subject,
      taskId: args.taskId,
    },
    db,
  );
  await recordArtifact(
    {
      taskId: args.taskId,
      type: "COMMIT",
      label: `merge-train task=${args.taskId} branch=${args.trainBranch}`,
      location: args.trainPath,
      contentHash: args.sha,
    },
    db,
  );
}

/**
 * Ordered merge train over verified worker results. Flow per item, in
 * sorted task-id order:
 *
 *   re-verify the work (workspace, base ancestry, claims, cited tests)
 *   → require a committed-clean worker worktree (merges only move commits)
 *   → merge the worker branch into the train branch, no fast-forward
 *   → on conflict: abort, record CONFLICT, halt
 *   → run the configured tests cumulatively in the train worktree
 *   → on failure: abort, record TESTS_FAILED with the test run, halt
 *   → on pass: commit the merge, record Commit + Artifact rows
 *
 * Only reads worker worktrees — never checks out, resets, or otherwise
 * touches them. Main is never merged into (or even checked out); the train
 * branch is a separate integration line awaiting human approval. The train
 * worktree is Atlas-owned and intentionally left in place as the reviewable
 * result. An explicit APPROVED decision is required up front; without it the
 * train refuses to start.
 */
export async function runMergeTrain(
  raw: unknown,
  db: PrismaClient = getPrismaClient(),
): Promise<MergeTrainResult> {
  const input = MergeTrainInputSchema.parse(raw);
  assertValidBranchName(input.trainBranch);

  const approval = await db.approval.findUnique({ where: { id: input.approvalId } });
  if (approval === null) {
    throw new NotFoundError("Approval", input.approvalId);
  }
  if (approval.status !== "APPROVED") {
    throw new MergeTrainNotApprovedError(
      `merge train requires an explicit APPROVED decision (approval ${approval.id} is ${approval.status})`,
    );
  }

  const repository = await db.repository.findUnique({ where: { id: input.repositoryId } });
  if (repository === null) {
    throw new NotFoundError("Repository", input.repositoryId);
  }
  const root = await validateRepository(repository.localPath);

  const items = [...input.items].sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));
  const worktree = await createWorktree({
    repoPath: root,
    path: input.trainPath,
    branch: input.trainBranch,
    base: input.baseCommit,
  });

  const integrated: IntegratedItem[] = [];
  let haltReason: string | undefined;

  for (const item of items) {
    const verification = await verifyExecution(
      {
        taskId: item.taskId,
        workerId: item.workerId,
        expectedBaseCommit: item.expectedBaseCommit,
        testRunId: item.testRunId,
      },
      db,
    );
    if (verification.verdict !== "VERIFIED") {
      integrated.push({
        taskId: item.taskId,
        workerId: item.workerId,
        status: "VERIFICATION_FAILED",
        reason: verification.reasons.join("; "),
      });
      haltReason = `task ${item.taskId}: verification failed (${verification.reasons.join("; ")})`;
      break;
    }

    const worker = await db.worker.findUniqueOrThrow({ where: { id: item.workerId }, include: { workspace: true } });
    const workerPath = worker.workspace?.path;
    if (workerPath === undefined || !(await isClean(workerPath))) {
      integrated.push({
        taskId: item.taskId,
        workerId: item.workerId,
        status: "VERIFICATION_FAILED",
        reason: "worker workspace has uncommitted changes; merges only move commits",
      });
      haltReason = `task ${item.taskId}: worker workspace has uncommitted changes`;
      break;
    }
    const workerInfo = await getWorktree(root, workerPath);
    if (workerInfo.branch === null) {
      integrated.push({
        taskId: item.taskId,
        workerId: item.workerId,
        status: "VERIFICATION_FAILED",
        reason: "worker worktree is detached; nothing mergeable to name",
      });
      haltReason = `task ${item.taskId}: worker worktree is detached`;
      break;
    }

    try {
      await runGit(["merge", "--no-ff", "--no-commit", workerInfo.branch], { cwd: worktree.path });
    } catch (error) {
      const conflicted = await unmergedPaths(worktree.path).catch(() => [] as string[]);
      await abortMerge(worktree.path);
      if (conflicted.length > 0) {
        integrated.push({
          taskId: item.taskId,
          workerId: item.workerId,
          status: "CONFLICT",
          reason: `merge conflicts in: ${conflicted.join(", ")}`,
        });
        haltReason = `task ${item.taskId}: merge conflicts in ${conflicted.join(", ")}`;
      } else {
        integrated.push({
          taskId: item.taskId,
          workerId: item.workerId,
          status: "MERGE_FAILED",
          reason: `merge failed: ${errorMessage(error)}`,
        });
        haltReason = `task ${item.taskId}: merge failed`;
      }
      break;
    }

    let testRunId: string;
    try {
      const testResult = await runTests(
        {
          taskId: item.taskId,
          workdir: worktree.path,
          ...(input.testCommand !== undefined ? { command: [...input.testCommand] } : {}),
        },
        db,
      );
      testRunId = testResult.testRunId;
      if (testResult.status !== "PASSED") {
        await abortMerge(worktree.path);
        integrated.push({
          taskId: item.taskId,
          workerId: item.workerId,
          status: "TESTS_FAILED",
          testRunId,
          reason: `cumulative tests ${testResult.status.toLowerCase()} (exit ${testResult.exitCode})`,
        });
        haltReason = `task ${item.taskId}: cumulative tests ${testResult.status.toLowerCase()}`;
        break;
      }
    } catch (error) {
      await abortMerge(worktree.path);
      integrated.push({
        taskId: item.taskId,
        workerId: item.workerId,
        status: "TESTS_FAILED",
        reason: `cumulative tests could not run: ${errorMessage(error)}`,
      });
      haltReason = `task ${item.taskId}: cumulative tests could not run`;
      break;
    }

    const subject = `atlas-train: integrate task ${item.taskId} from ${workerInfo.branch}`;
    await runGit(
      [
        "-c",
        `user.name=${TRAIN_USER_NAME}`,
        "-c",
        `user.email=${TRAIN_USER_EMAIL}`,
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-m",
        subject,
      ],
      { cwd: worktree.path },
    );
    const mergeCommit = await getCurrentCommit(worktree.path);
    await recordIntegration(db, {
      repositoryId: repository.id,
      taskId: item.taskId,
      trainBranch: input.trainBranch,
      trainPath: worktree.path,
      sha: mergeCommit,
      subject,
    });
    integrated.push({ taskId: item.taskId, workerId: item.workerId, status: "INTEGRATED", mergeCommit, testRunId });
  }

  for (const item of items) {
    if (!integrated.some((done) => done.taskId === item.taskId)) {
      integrated.push({ taskId: item.taskId, workerId: item.workerId, status: "NOT_ATTEMPTED" });
    }
  }
  integrated.sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));

  return {
    status: haltReason === undefined ? "COMPLETED" : "HALTED",
    trainBranch: input.trainBranch,
    trainPath: worktree.path,
    baseCommit: input.baseCommit,
    finalCommit: await getCurrentCommit(worktree.path),
    items: integrated,
    ...(haltReason !== undefined ? { haltReason } : {}),
    approval: { id: approval.id, actor: approval.actor, decidedAt: approval.decidedAt },
  };
}
