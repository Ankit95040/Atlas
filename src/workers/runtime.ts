import { realpath } from "node:fs/promises";
import type { PrismaClient, Task, Worker, Workspace } from "@prisma/client";
import { getPrismaClient } from "../db/client.js";
import { InvariantViolationError, NotFoundError } from "../core/errors.js";
import { recordArtifact, recordEvent, releaseWorkerAssignment, transitionTask, transitionWorker } from "../core/service.js";
import { TASK_TRANSITIONS, WORKER_TRANSITIONS, assertTransition } from "../core/transitions.js";
import { resourceOverlaps } from "../claims/conflicts.js";
import type { NormalizedClaim } from "../claims/types.js";
import { getTaskClaims } from "../claims/service.js";
import { getCurrentCommit, getRepositoryRoot, getWorktree } from "../git/index.js";
import { getWorktreeChanges } from "../git/diff.js";
import { CommandFailureError } from "./command-provider.js";
import type { WorkerProvider } from "./provider.js";
import {
  ExecuteTaskInput,
  ProviderOutputSchema,
  type ChangedResource,
  type CommandFailureKind,
  type WorkerExecutionInput,
  type WorkerExecutionResult,
} from "./types.js";
interface ExecutionContext {
  readonly task: Task;
  readonly worker: Worker;
  readonly workspace: Workspace;
  readonly realPath: string;
  readonly branch: string | null;
  readonly baseCommit: string;
  readonly declared: readonly NormalizedClaim[];
}

interface TerminalOutcome {
  readonly status: Extract<
    WorkerExecutionResult["status"],
    "COMPLETED" | "COMPLETED_EMPTY" | "FAILED" | "CLAIM_VIOLATION"
  >;
  readonly workerTo: "COMPLETED" | "FAILED";
  readonly taskTo: "VERIFICATION" | "COMPLETED_EMPTY" | "FAILED";
  readonly error?: string;
  readonly errorCode?: CommandFailureKind;
  readonly providerSummary?: string;
}

/**
 * Controlled worker execution boundary. Flow:
 *
 * gates (approval → states → workspace → base commit, nothing persisted)
 *   → atomic slot acquisition (task CLAIMED→IN_PROGRESS, worker ASSIGNED→RUNNING)
 *   → TASK_STARTED event → provider executes inside the assigned worktree
 *   → Git diff (never provider self-report) → claim enforcement
 *   → terminal states + summary artifact → structured result
 *
 * Fail-closed throughout: unexpected infra errors propagate; every
 * operational outcome returns a WorkerExecutionResult. No merging, no
 * assignment, no Git writes — the worktree stays isolated.
 */
export async function executeTask(
  raw: unknown,
  provider: WorkerProvider,
  db: PrismaClient = getPrismaClient(),
): Promise<WorkerExecutionResult> {
  const input = ExecuteTaskInput.parse(raw);

  const task = await db.task.findUnique({ where: { id: input.taskId } });
  if (task === null) {
    throw new NotFoundError("Task", input.taskId);
  }
  const worker = await db.worker.findUnique({ where: { id: input.workerId }, include: { workspace: true } });
  if (worker === null) {
    throw new NotFoundError("Worker", input.workerId);
  }
  const base = { taskId: task.id, workerId: worker.id, changedResources: [], undeclaredResources: [] };

  // Approval gate: only an explicit APPROVED decision authorizes execution.
  // A raw proposal, a PENDING approval, or a rejection never qualifies.
  const approval = await db.approval.findFirst({ where: { taskId: task.id, status: "APPROVED" } });
  if (approval === null) {
    return { ...base, status: "NOT_AUTHORIZED", error: `task ${task.id} has no approved execution` };
  }

  // State gate (first line of concurrency defense; re-checked in the tx).
  if (task.status !== "CLAIMED" || worker.status !== "ASSIGNED" || worker.taskId !== task.id) {
    return {
      ...base,
      status: "FAILED",
      error: `task ${task.id} / worker ${worker.id} not in executable state (task=${task.status}, worker=${worker.status})`,
    };
  }

  // Workspace gate: the DB record is authoritative; provider paths are ignored.
  const workspace = worker.workspace;
  if (workspace === null || workspace.workerId !== worker.id) {
    return { ...base, status: "INVALID_WORKSPACE", error: `worker ${worker.id} has no linked workspace` };
  }
  let realPath: string;
  try {
    realPath = await realpath(workspace.path);
  } catch {
    return { ...base, status: "INVALID_WORKSPACE", error: `workspace path is missing: ${workspace.path}` };
  }
  let branch: string | null;
  try {
    const root = await getRepositoryRoot(realPath);
    const info = await getWorktree(root, realPath);
    if (info.isMain) {
      return {
        ...base,
        status: "INVALID_WORKSPACE",
        error: "main repository worktree cannot be used as a worker workspace",
      };
    }
    const infoReal = await realpath(info.path);
    if (infoReal !== realPath) {
      return { ...base, status: "INVALID_WORKSPACE", error: "workspace path does not match registered worktree" };
    }
    if (workspace.branch !== null && info.branch !== null && workspace.branch !== info.branch) {
      return { ...base, status: "INVALID_WORKSPACE", error: "workspace branch does not match worktree branch" };
    }
    branch = info.branch;
  } catch (error) {
    return {
      ...base,
      status: "INVALID_WORKSPACE",
      error: `workspace is not a registered worktree: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  // Base-commit gate: never operate against an unexpected repository base.
  let actualHead: string;
  try {
    actualHead = await getCurrentCommit(realPath);
  } catch (error) {
    return {
      ...base,
      status: "FAILED",
      error: `cannot read workspace HEAD: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (actualHead !== input.expectedBaseCommit) {
    return {
      ...base,
      status: "BASE_COMMIT_MISMATCH",
      error: `workspace HEAD ${actualHead} does not match expected base ${input.expectedBaseCommit}`,
    };
  }

  // Atomic slot acquisition: re-read under the transaction so exactly one
  // concurrent execution can proceed; the loser observes changed state.
  try {
    await db.$transaction(async (tx) => {
      const freshTask = await tx.task.findUnique({ where: { id: task.id } });
      const freshWorker = await tx.worker.findUnique({ where: { id: worker.id } });
      if (freshTask?.status !== "CLAIMED" || freshWorker?.status !== "ASSIGNED" || freshWorker?.taskId !== task.id) {
        throw new InvariantViolationError(`execution slot no longer available for task ${task.id}`);
      }
      assertTransition("Worker", freshWorker.status, "RUNNING", WORKER_TRANSITIONS);
      await tx.worker.update({ where: { id: worker.id }, data: { status: "RUNNING" } });
      assertTransition("Task", freshTask.status, "IN_PROGRESS", TASK_TRANSITIONS);
      await tx.task.update({ where: { id: task.id }, data: { status: "IN_PROGRESS" } });
    });
  } catch (error) {
    if (error instanceof InvariantViolationError) {
      return { ...base, status: "FAILED", error: error.message };
    }
    throw error;
  }

  const feature = await db.feature.findUnique({ where: { id: task.featureId } });
  if (feature === null) {
    throw new NotFoundError("Feature", task.featureId);
  }
  await recordEvent(
    {
      type: "TASK_STARTED",
      projectId: feature.projectId,
      featureId: task.featureId,
      taskId: task.id,
      actor: "worker-runtime",
      payload: { workerId: worker.id, workspaceId: workspace.id, baseCommit: actualHead },
    },
    db,
  );

  // Declared claims come from Atlas state, never from the provider.
  const declared = await getTaskClaims(task.id, db);
  const providerInput: WorkerExecutionInput = {
    taskId: task.id,
    workerId: worker.id,
    workspacePath: realPath,
    taskTitle: task.title,
    ...(task.description !== null ? { taskDescription: task.description } : {}),
    resourceClaims: declared,
    repositoryCommit: actualHead,
    relevantContext: { branch, featureId: task.featureId },
  };

  let rawOutput: unknown;
  try {
    rawOutput = await provider.execute(providerInput);
  } catch (error) {
    // Structured spawn evidence travels alongside the message (M19.2);
    // non-command failures carry no code, exactly as before.
    if (error instanceof CommandFailureError) {
      return failExecution(db, terminalContext(task, worker, workspace, actualHead), errorMessage(error), error.kind);
    }
    return failExecution(db, terminalContext(task, worker, workspace, actualHead), errorMessage(error));
  }
  const parsed = ProviderOutputSchema.safeParse(rawOutput);
  if (!parsed.success) {
    return failExecution(
      db,
      terminalContext(task, worker, workspace, actualHead),
      `provider returned malformed output: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
    );
  }

  // Inspect actual changes from Git itself. Provider self-reports are ignored.
  let changes: Awaited<ReturnType<typeof getWorktreeChanges>>;
  try {
    changes = await getWorktreeChanges(realPath, input.expectedBaseCommit);
  } catch (error) {
    return failExecution(db, terminalContext(task, worker, workspace, actualHead), `diff inspection failed: ${errorMessage(error)}`);
  }
  let finalCommit: string;
  try {
    finalCommit = await getCurrentCommit(realPath);
  } catch (error) {
    return failExecution(db, terminalContext(task, worker, workspace, actualHead), `cannot read final HEAD: ${errorMessage(error)}`);
  }

  const changedResources: ChangedResource[] = changes.map((change) => ({
    path: change.path,
    change: change.change,
    ...(change.oldPath !== undefined ? { oldPath: change.oldPath } : {}),
  }));
  const candidates = new Set<string>();
  for (const change of changes) {
    candidates.add(change.path);
    if (change.oldPath !== undefined) {
      candidates.add(change.oldPath);
    }
  }
  // M9 hook: Atlas-executed verification (tests, judges) will run here
  // against realPath before completion. Provider test self-reports
  // (output.testsPassed) are metadata only — never evidence.
  void parsed.data.testsPassed;
  const undeclared = [...candidates]
    .filter((path) => !declared.some((claim) => claim.access === "WRITE" && resourceOverlaps(path, claim.resourceId)))
    .sort();

  if (undeclared.length > 0) {
    return finishExecution(db, terminalContext(task, worker, workspace, actualHead, finalCommit, changedResources, undeclared), {
      status: "CLAIM_VIOLATION",
      workerTo: "FAILED",
      taskTo: "FAILED",
      error: `undeclared resource modifications: ${undeclared.join(", ")}`,
      providerSummary: parsed.data.summary,
    });
  }
  // M19.4 Policy 3: valid execution hygiene with an empty effective diff is
  // a distinct observed outcome (COMPLETED_EMPTY), neither ordinary success
  // (COMPLETED, which claims a contribution) nor failure. The worker did its
  // job (workerTo COMPLETED); the task carries no contribution.
  if (changedResources.length === 0) {
    return finishExecution(db, terminalContext(task, worker, workspace, actualHead, finalCommit, changedResources, undeclared), {
      status: "COMPLETED_EMPTY",
      workerTo: "COMPLETED",
      taskTo: "COMPLETED_EMPTY",
      providerSummary: parsed.data.summary,
    });
  }
  return finishExecution(db, terminalContext(task, worker, workspace, actualHead, finalCommit, changedResources, undeclared), {
    status: "COMPLETED",
    workerTo: "COMPLETED",
    taskTo: "VERIFICATION",
    providerSummary: parsed.data.summary,
  });
}

interface TerminalContext {
  readonly task: Task;
  readonly worker: Worker;
  readonly workspace: Workspace;
  readonly baseCommit: string;
  readonly finalCommit: string;
  readonly changedResources: ChangedResource[];
  readonly undeclared: string[];
}

function terminalContext(
  task: Task,
  worker: Worker,
  workspace: Workspace,
  baseCommit: string,
  finalCommit?: string,
  changedResources: ChangedResource[] = [],
  undeclared: string[] = [],
): TerminalContext {
  return {
    task,
    worker,
    workspace,
    baseCommit,
    finalCommit: finalCommit ?? baseCommit,
    changedResources,
    undeclared,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function failExecution(
  db: PrismaClient,
  ctx: TerminalContext,
  error: string,
  errorCode?: CommandFailureKind,
): Promise<WorkerExecutionResult> {
  return finishExecution(db, ctx, {
    status: "FAILED",
    workerTo: "FAILED",
    taskTo: "FAILED",
    error,
    ...(errorCode !== undefined ? { errorCode } : {}),
  });
}

/**
 * Persist terminal outcome: summary artifact first (evidence preserved even
 * if a later step fails), then explicit state transitions. States only ever
 * move forward from RUNNING/IN_PROGRESS — nothing is silently completed.
 */
async function finishExecution(
  db: PrismaClient,
  ctx: TerminalContext,
  outcome: {
    status: "COMPLETED" | "COMPLETED_EMPTY" | "FAILED" | "CLAIM_VIOLATION";
    workerTo: "COMPLETED" | "FAILED";
    taskTo: "VERIFICATION" | "COMPLETED_EMPTY" | "FAILED";
    error?: string;
    errorCode?: CommandFailureKind;
    providerSummary?: string;
  },
): Promise<WorkerExecutionResult> {
  // M19.5 lifecycle: the authoritative task outcome. COMPLETED_EMPTY records
  // as TASK_COMPLETED with the distinct outcome (valid hygiene, no
  // contribution); FAILED and CLAIM_VIOLATION record as TASK_FAILED.
  // M20.3 persistence: failures additionally carry the structured error code
  // (when the failure came from the command boundary), a bounded error
  // summary, and the execution phase — the diagnostic evidence base runs and
  // `atlas diagnose` read back, so a dead worker's cause survives its process.
  const failed = outcome.status === "FAILED" || outcome.status === "CLAIM_VIOLATION";
  await recordEvent(
    {
      type: failed ? "TASK_FAILED" : "TASK_COMPLETED",
      featureId: ctx.task.featureId,
      taskId: ctx.task.id,
      actor: "atlas-worker-runtime",
      payload: {
        outcome: outcome.status,
        workerId: ctx.worker.id,
        // Phase is unconditional on failure events: finishExecution only runs
        // for terminal execution outcomes, so a TASK_FAILED row always means
        // the worker-execution phase ended in failure.
        ...(failed ? { phase: "worker-execution" as const } : {}),
        ...(outcome.errorCode !== undefined ? { errorCode: outcome.errorCode } : {}),
        ...(outcome.error !== undefined ? { error: outcome.error.slice(0, 2000) } : {}),
      },
    },
    db,
  );
  const artifact = await recordArtifact(
    {
      taskId: ctx.task.id,
      type: "ANALYSIS_REPORT",
      label: `worker-execution task=${ctx.task.id} worker=${ctx.worker.id} status=${outcome.status}`,
      location: ctx.workspace.path,
    },
    db,
  );
  if (outcome.workerTo === "COMPLETED") {
    await transitionWorker(ctx.worker.id, "VERIFYING", db);
    await transitionWorker(ctx.worker.id, "COMPLETED", db);
  } else {
    await transitionWorker(ctx.worker.id, "FAILED", db);
  }
  await transitionTask(ctx.task.id, outcome.taskTo, db);
  if (outcome.taskTo === "FAILED") {
    // M23.1: the task is no longer worker-owned and the worker is terminal,
    // so the current-assignment link is released here, atomically with the
    // failure recording. The worker stays FAILED (historically terminal, not
    // reusable); history survives via TASK_FAILED payloads, artifacts, and
    // events. VERIFICATION and COMPLETED_EMPTY outcomes keep the link: the
    // merge train re-verifies through it before integrating.
    await releaseWorkerAssignment(ctx.worker.id, db);
  }
  return {
    taskId: ctx.task.id,
    workerId: ctx.worker.id,
    workspaceId: ctx.workspace.id,
    status: outcome.status,
    baseCommit: ctx.baseCommit,
    finalCommit: ctx.finalCommit,
    changedResources: ctx.changedResources,
    undeclaredResources: ctx.undeclared,
    artifacts: { summaryArtifactId: artifact.id },
    ...(outcome.error !== undefined ? { error: outcome.error } : {}),
    ...(outcome.errorCode !== undefined ? { errorCode: outcome.errorCode } : {}),
    ...(outcome.providerSummary !== undefined ? { providerSummary: outcome.providerSummary } : {}),
  };
}
