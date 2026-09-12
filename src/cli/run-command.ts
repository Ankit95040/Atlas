import { join } from "node:path";
import type { PrismaClient } from "@prisma/client";
import { getPrismaClient } from "../db/client.js";
import { getCurrentCommit, validateRepository } from "../git/index.js";
import { createApproval, decideApproval } from "../core/service.js";
import { runFeatureWaveLoop } from "../orchestrator/index.js";
import { CommandWorkerProvider } from "../workers/index.js";
import { EXIT_HALTED, EXIT_OK, type CommandOutput } from "./output.js";
import { PLAN_APPROVAL_CONTEXT } from "./plan.js";

export const MERGE_APPROVAL_CONTEXT = "m12-merge";

export interface RunCommandOptions {
  readonly featureId: string;
  readonly repositoryId: string;
  readonly planApproval: string;
  readonly approveMerge?: boolean;
  readonly actor: string;
  readonly agent: string;
  readonly agentArg?: readonly string[];
  readonly agentTimeoutMs?: number;
  readonly agentEnv?: readonly string[];
  readonly base?: string;
  readonly maxConcurrency?: number;
  readonly testCommand?: string;
  readonly testArg?: readonly string[];
  readonly trainBranch?: string;
  readonly trainPath?: string;
  readonly workspaceRoot?: string;
  readonly json?: boolean;
}

function refusal(message: string): Error {
  const error = new Error(message);
  error.name = "RunRefusalError";
  return error;
}

/**
 * `atlas run`: human-approved execution of the M11 wave loop.
 *
 * Order of operations (nothing executes before authorization):
 * 1. Load the referenced plan approval; refuse unless it exists, targets
 *    this feature, carries the plan context, and is APPROVED.
 * 2. Refuse unless `--approve-merge` was passed: without it nothing runs.
 * 3. Create a PENDING merge approval bound to the plan approval, then
 *    decide it APPROVED via the existing API — the flag is only the
 *    mechanism invoking the decision; the persisted row is the record.
 * 4. Invoke `runFeatureWaveLoop` with a `CommandWorkerProvider` factory
 *    built from the `--agent` argv (execFile, no shell, workspace cwd).
 *
 * Exit 0 only when the train COMPLETED with every executed task COMPLETED
 * and VERIFIED; exit 2 (via EXIT_HALTED) for truthful-but-unfavorable
 * outcomes (halted train, failures, violations, rejections).
 */
export async function runRunCommand(
  options: RunCommandOptions,
  db: PrismaClient = getPrismaClient(),
): Promise<CommandOutput> {
  if (options.actor.trim().length === 0) {
    throw refusal("--actor <name> is required: every approval decision records its human author");
  }

  const planApproval = await db.approval.findUnique({ where: { id: options.planApproval } });
  if (planApproval === null) {
    throw refusal(`plan approval not found: ${options.planApproval}`);
  }
  if (planApproval.featureId !== options.featureId) {
    throw refusal(`plan approval ${planApproval.id} targets feature ${planApproval.featureId}, not ${options.featureId}`);
  }
  if (planApproval.context !== PLAN_APPROVAL_CONTEXT) {
    throw refusal(`approval ${planApproval.id} is not a plan approval (context: ${planApproval.context ?? "none"})`);
  }
  if (planApproval.status !== "APPROVED") {
    throw refusal(
      `plan approval ${planApproval.id} is ${planApproval.status}: approve it first with \`atlas plan --approve --actor <name>\`; nothing executed`,
    );
  }

  if (options.approveMerge !== true) {
    throw refusal("merge not authorized: re-run with --approve-merge --actor <name>; nothing executed");
  }

  const repository = await db.repository.findUnique({ where: { id: options.repositoryId } });
  if (repository === null) {
    throw refusal(`repository not found: ${options.repositoryId}`);
  }
  const feature = await db.feature.findUnique({ where: { id: options.featureId } });
  if (feature === null) {
    throw refusal(`feature not found: ${options.featureId}`);
  }
  if (repository.projectId !== feature.projectId) {
    throw refusal(`repository ${repository.id} does not belong to feature ${feature.id}'s project`);
  }

  const repoRoot = await validateRepository(repository.localPath);
  const baseCommit = options.base ?? (await getCurrentCommit(repoRoot));

  const workspaceRoot = options.workspaceRoot ?? join(process.cwd(), ".atlas", "work");
  const stamp = Date.now();
  const trainBranch = options.trainBranch ?? `atlas/cli/${options.featureId}-${stamp}`;
  const trainPath = options.trainPath ?? join(workspaceRoot, `train-${options.featureId}-${stamp}`);

  // The explicit human merge decision, persisted before anything executes.
  const mergeApproval = await createApproval(
    {
      featureId: feature.id,
      context: MERGE_APPROVAL_CONTEXT,
      note: `plan-approval:${planApproval.id} repository:${repository.id} base:${baseCommit}`,
    },
    db,
  );
  await decideApproval(mergeApproval.id, { decision: "APPROVED", actor: options.actor });

  const agentCommand = [options.agent, ...(options.agentArg ?? [])];
  const testCommand = options.testCommand === undefined ? undefined : [options.testCommand, ...(options.testArg ?? [])];
  const result = await runFeatureWaveLoop(
    {
      featureId: feature.id,
      repositoryId: repository.id,
      baseCommit,
      workspaceRoot,
      trainBranch,
      trainPath,
      approvalActor: options.actor,
      maxConcurrency: options.maxConcurrency ?? 4,
      ...(testCommand !== undefined ? { testCommand } : {}),
    },
    {
      createProvider: () =>
        new CommandWorkerProvider({
          command: agentCommand,
          ...(options.agentTimeoutMs !== undefined ? { timeoutMs: options.agentTimeoutMs } : {}),
          ...(options.agentEnv !== undefined ? { envAllowlist: [...options.agentEnv] } : {}),
        }),
    },
    db,
  );

  const allClean =
    result.train?.status === "COMPLETED" &&
    result.outcomes.length > 0 &&
    result.outcomes.every((outcome) => outcome.execution.status === "COMPLETED" && outcome.verification?.verdict === "VERIFIED");
  const exitCode = allClean ? EXIT_OK : EXIT_HALTED;

  const outcomeLines = result.outcomes.map((outcome) => {
    const test = outcome.testRun?.status ?? "NOT_RUN";
    const verdict = outcome.verification?.verdict ?? "NOT_EVALUATED";
    return `  - ${outcome.taskId}: execution=${outcome.execution.status} tests=${test} verification=${verdict}`;
  });
  const trainLine =
    result.train === null
      ? "train: skipped (nothing verified)"
      : `train: ${result.train.status} (branch ${result.train.trainBranch}, items: ${result.train.items.map((item) => `${item.taskId}=${item.status}`).join(", ")})`;
  const human = [
    `atlas run`,
    `feature: ${result.featureId}`,
    `repository: ${result.repositoryId} (base ${result.baseCommit.slice(0, 12)})`,
    `plan approval: ${planApproval.id} (APPROVED)`,
    `merge approval: ${mergeApproval.id} (APPROVED by ${options.actor})`,
    `waves: ${result.waves.map((wave) => `[${wave.join(", ")}]`).join(" ")}`,
    `outcomes (${result.outcomes.length}):`,
    ...outcomeLines,
    trainLine,
  ].join("\n");

  return {
    exitCode,
    human,
    data: {
      ...result,
      planApproval: { id: planApproval.id, status: planApproval.status },
      mergeApproval: { id: mergeApproval.id, status: "APPROVED", actor: options.actor },
    },
  };
}
