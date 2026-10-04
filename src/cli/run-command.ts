import { dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PrismaClient } from "@prisma/client";
import { getPrismaClient } from "../db/client.js";
import { getCurrentCommit, validateRepository } from "../git/index.js";
import { createApproval, decideApproval, recordEvent } from "../core/service.js";
import { getTaskClaims } from "../claims/service.js";
import { recommendRoute, type RouteRecommendation } from "../planner/routing.js";
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
 * Shadow routing recommendation for a completed run (M29.2 Phase 2).
 * Loads the run's tasks, claims, and dependency edges and classifies them
 * with the pure `recommendRoute` function. Read-only; failures degrade to
 * a REQUIRES_REVIEW recommendation rather than failing the run output.
 */
export async function recommendRunRoute(
  db: PrismaClient,
  featureId: string,
): Promise<RouteRecommendation & { taskCount: number }> {
  try {
    const [tasks, edges] = await Promise.all([
      db.task.findMany({ where: { featureId }, select: { id: true } }),
      db.taskDependency.findMany({ where: { task: { featureId } }, select: { taskId: true, dependsOnTaskId: true } }),
    ]);
    const withClaims = await Promise.all(
      tasks.map(async (t) => ({ id: t.id, claims: await getTaskClaims(t.id, db) })),
    );
    return { ...recommendRoute(withClaims, edges), taskCount: tasks.length };
  } catch {
    return {
      route: "REQUIRES_REVIEW",
      reasons: [{ rule: "recommendation-unavailable", detail: "routing inputs could not be loaded; no recommendation recorded" }],
      taskCount: 0,
    };
  }
}

/**
 * Actual executed strategy, derived — never flagged (M29.3 Phase 3).
 * A run over exactly one persisted task cannot coordinate by construction,
 * so its effective strategy is single-agent; anything larger ran the
 * orchestrated wave loop. This describes the approved plan's shape, not a
 * runtime mode switch: execution mechanics are identical either way.
 */
export function deriveActualStrategy(taskCount: number): "SINGLE_AGENT" | "ORCHESTRATED" {
  return taskCount === 1 ? "SINGLE_AGENT" : "ORCHESTRATED";
}

/**
 * Locate the Atlas checkout this CLI binary runs from, or null when it
 * cannot be established (packaged installs, relocated layouts). Positive
 * identification only: package.json named `atlas` plus the Prisma schema
 * that ships with the checkout. Never guesses.
 */
export function findAtlasCheckout(): string | null {
  try {
    const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
    const pkgRaw = existsSync(join(root, "package.json"))
      ? (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name?: unknown })
      : null;
    if (pkgRaw?.name !== "atlas" || !existsSync(join(root, "prisma", "schema.prisma"))) {
      return null;
    }
    return root;
  } catch {
    return null;
  }
}

/**
 * Resolve the default worker workspace root with the M28.4 safety guard.
 *
 * An explicit `--workspace-root` is always honored verbatim: the operator
 * chose it deliberately, including inside the Atlas checkout itself
 * (dogfooding stays possible). Only the silent cwd-derived default is
 * guarded: when it lands inside the positively identified Atlas checkout,
 * the operator almost certainly meant a target repository and invoked the
 * command from the wrong directory. The error names the escape hatches
 * instead of guessing intent.
 */
export function resolveWorkspaceRoot(options: { workspaceRoot?: string }, cwd: string = process.cwd()): string {
  if (options.workspaceRoot !== undefined) {
    return options.workspaceRoot;
  }
  const root = join(cwd, ".atlas", "work");
  const checkout = findAtlasCheckout();
  if (checkout !== null && (root === checkout || root.startsWith(`${checkout}/`))) {
    throw refusal(
      `default workspace root ${root} is inside the Atlas checkout (${checkout}): ` +
        `run from the target repository directory instead, or pass an explicit ` +
        `--workspace-root <dir outside the checkout> (and --train-path if set). ` +
        `Nothing was created; no workspaces, worktrees, or branches were touched.`,
    );
  }
  return root;
}

export interface RunTimingSummary {
  /** Wall-clock ms of the wave-loop invocation (M28.2). */
  readonly totalElapsedMs: number;
  /** Sums over per-task/round spans; each is 0 when its phase never ran. */
  readonly schedulingMs: number;
  readonly assignMs: number;
  readonly workerMs: number;
  readonly testMs: number;
  readonly verificationMs: number;
  /** Null when no integration ran (train skipped). Never invented. */
  readonly trainMs: number | null;
  /** Human-readable list of unavailable measurements and why. */
  readonly missing: string[];
}

type WaveLoopResult = Awaited<ReturnType<typeof runFeatureWaveLoop>>;

/**
 * Roll per-task/per-round spans into one run-level summary (M28.2).
 * Pure reporting: no orchestration input, no state writes. Absent phases
 * are named in `missing`, never zero-filled silently — a zero means the
 * phase ran in under a millisecond, `missing` means it did not run.
 */
export function buildTimingSummary(result: WaveLoopResult, totalElapsedMs: number): RunTimingSummary {
  const sum = (values: Array<number | null | undefined> | readonly number[] | undefined): number =>
    (values ?? []).reduce<number>((acc, v) => acc + (v ?? 0), 0);
  const trainMs = result.trainMs ?? null;
  const testMs = sum(result.outcomes.map((o) => o.testRun?.durationMs));
  const missing: string[] = [];
  if (result.train === null) {
    missing.push("train (skipped: nothing verified)");
  } else if (trainMs === null) {
    missing.push("train (ran, but no span recorded)");
  }
  if (result.outcomes.every((o) => o.testRun === null)) {
    missing.push("tests (no test run executed)");
  }
  if (result.outcomes.every((o) => o.verificationMs == null)) {
    missing.push("verification (no verification executed)");
  }
  return {
    totalElapsedMs,
    schedulingMs: sum(result.schedulingMs),
    assignMs: sum(result.outcomes.map((o) => o.assignMs)),
    workerMs: sum(result.outcomes.map((o) => o.workerMs)),
    testMs,
    verificationMs: sum(result.outcomes.map((o) => o.verificationMs)),
    trainMs,
    missing,
  };
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

  const workspaceRoot = resolveWorkspaceRoot({ ...(options.workspaceRoot !== undefined ? { workspaceRoot: options.workspaceRoot } : {}) });
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
  const loopStart = Date.now();
  let result: Awaited<ReturnType<typeof runFeatureWaveLoop>>;
  try {
    result = await runFeatureWaveLoop(
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
            ...(options.agentTimeoutMs !== undefined ? { timeoutMs: Number(options.agentTimeoutMs) } : {}),
            ...(options.agentEnv !== undefined ? { envAllowlist: [...options.agentEnv] } : {}),
          }),
      },
      db,
    );
  } catch (error) {
    // M19.5 lifecycle: the run itself crashed (per-task failures live in
    // outcomes, not here). Rethrow unchanged: exit-code behavior is identical.
    await recordEvent(
      {
        type: "RUN_FAILED",
        featureId: feature.id,
        actor: options.actor,
        payload: { error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) },
      },
      db,
    );
    throw error;
  }

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
  const timing = buildTimingSummary(result, Date.now() - loopStart);
  const timingLines = [
    `timing: total=${timing.totalElapsedMs}ms scheduling=${timing.schedulingMs}ms assign=${timing.assignMs}ms worker=${timing.workerMs}ms tests=${timing.testMs}ms verify=${timing.verificationMs}ms train=${timing.trainMs === null ? "n/a" : `${timing.trainMs}ms`}`,
    ...(timing.missing.length === 0 ? [] : [`timing missing: ${timing.missing.join("; ")}`]),
  ];
  // Shadow routing recommendation (M29.2): recorded for evidence, never
  // acted upon. Actual execution is always the orchestrated wave loop in
  // this milestone; enabling requires the Phase 4 adoption gate.
  // M29.3: actual strategy is derived from the approved plan's shape
  // (single persisted task = no coordination possible). Divergence
  // between recommended and actual, with the plan approval actor and
  // timestamp, IS the auditable override record — no new approval system.
  const routingRecommendation = await recommendRunRoute(db, result.featureId);
  const actualRoute = deriveActualStrategy(routingRecommendation.taskCount);
  const { taskCount: _taskCount, ...routingAdvisory } = routingRecommendation;
  const routingLine = `routing (shadow): recommended=${routingRecommendation.route} actual=${actualRoute} :: ${routingRecommendation.reasons.map((r) => r.detail).join(" | ")}`;
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
    ...timingLines,
    routingLine,
  ].join("\n");

  return {
    exitCode,
    human,
    data: {
      ...result,
      planApproval: { id: planApproval.id, status: planApproval.status },
      mergeApproval: { id: mergeApproval.id, status: "APPROVED", actor: options.actor },
      timing,
      routingRecommendation: { ...routingAdvisory, actualRoute },
    },
  };
}
