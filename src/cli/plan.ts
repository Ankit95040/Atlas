import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { WorkerStatus, type PrismaClient } from "@prisma/client";
import { getPrismaClient } from "../db/client.js";
import {
  createApproval,
  createTask,
  createTaskDependency,
  decideApproval,
  recordEvent,
  transitionTask,
} from "../core/service.js";
import { createTaskClaims } from "../claims/index.js";
import { planSchedule } from "../dag/index.js";
import { toSchedulerInput, validatePlannerProposal, type ValidatedPlannerPlan } from "../planner/index.js";
import { recommendRoute } from "../planner/routing.js";
import { EXIT_OK, type CommandOutput } from "./output.js";

export const PLAN_APPROVAL_CONTEXT = "m12-plan";

export interface PlanCommandOptions {
  readonly featureId: string;
  readonly proposal: string;
  readonly approve?: boolean;
  readonly actor?: string;
  readonly maxConcurrency?: number;
  readonly json?: boolean;
}

interface PlanApprovalRef {
  readonly id: string;
  readonly status: string;
}

function proposalHash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function approvalNoteFor(hash: string): string {
  return `${PLAN_APPROVAL_CONTEXT} sha256:${hash}`;
}

async function findPlanApproval(
  db: PrismaClient,
  featureId: string,
  hash: string,
): Promise<PlanApprovalRef | null> {
  const rows = await db.approval.findMany({ where: { featureId }, orderBy: { createdAt: "asc" } });
  for (const row of rows) {
    if (row.context === PLAN_APPROVAL_CONTEXT && row.note === approvalNoteFor(hash)) {
      return { id: row.id, status: row.status };
    }
  }
  return null;
}

function usageError(message: string): Error {
  const error = new Error(message);
  error.name = "PlanUsageError";
  return error;
}

/**
 * `atlas plan`: read an untrusted proposal JSON file, validate it
 * deterministically (M7), persist tasks/claims/dependencies once, print a
 * scheduler preview, and record plan approval via the existing Approval API.
 *
 * Never executes workers, never merges. Persistence happens exactly once per
 * (feature, proposal-hash): re-running with the same file re-displays the
 * existing approval instead of duplicating tasks. Approving (`--approve
 * --actor`) re-validates the file first so the decided approval always
 * corresponds to the displayed proposal.
 */
export async function runPlanCommand(
  options: PlanCommandOptions,
  db: PrismaClient = getPrismaClient(),
): Promise<CommandOutput> {
  const maxConcurrency = options.maxConcurrency ?? 4;

  let rawBytes: Buffer;
  try {
    rawBytes = await readFile(options.proposal);
  } catch {
    throw usageError(`cannot read proposal file: ${options.proposal}`);
  }
  const hash = proposalHash(rawBytes);

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBytes.toString("utf8"));
  } catch {
    throw usageError(`proposal file is not valid JSON: ${options.proposal}`);
  }

  const feature = await db.feature.findUnique({ where: { id: options.featureId } });
  if (feature === null) {
    throw usageError(`feature not found: ${options.featureId}`);
  }

  let validated: ValidatedPlannerPlan;
  try {
    validated = validatePlannerProposal(parsed);
  } catch (error) {
    throw usageError(`proposal rejected: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (validated.featureId !== options.featureId) {
    throw usageError(
      `proposal targets feature ${validated.featureId} but --feature is ${options.featureId}: refusing to apply another feature's plan`,
    );
  }

  const existing = await findPlanApproval(db, feature.id, hash);
  let approvalId: string;
  let approvalStatus: string;
  let persistedTaskIds: string[];
  let alreadyApproved = false;

  if (existing !== null) {
    // Same feature + same proposal bytes: reuse, never duplicate tasks.
    approvalId = existing.id;
    approvalStatus = existing.status;
    if (options.approve === true) {
      if (existing.status === "APPROVED") {
        alreadyApproved = true;
      } else {
        if (options.actor === undefined || options.actor.trim().length === 0) {
          throw usageError("--approve requires --actor <name>: approvals are never silent");
        }
        const decided = await decideApproval(existing.id, { decision: "APPROVED", actor: options.actor });
        approvalStatus = decided.status;
      }
    }
    const rows = await db.task.findMany({ where: { featureId: feature.id }, select: { id: true }, orderBy: { id: "asc" } });
    persistedTaskIds = rows.map((row) => row.id);
  } else {
    const featureTasks = await db.task.findMany({ where: { featureId: feature.id }, select: { id: true } });
    if (featureTasks.length > 0) {
      throw usageError(
        `feature ${feature.id} already has ${featureTasks.length} task(s) and no plan approval matches this proposal (sha256:${hash.slice(0, 12)}…): create a new feature instead of silently diverging`,
      );
    }
    const proposalIdToTaskId = new Map<string, string>();
    for (const task of validated.tasks) {
      const created = await createTask(
        {
          featureId: feature.id,
          title: task.title,
          ...(task.description !== undefined ? { description: task.description } : {}),
        },
        db,
      );
      await transitionTask(created.id, "READY", db);
      await createTaskClaims(
        {
          taskId: created.id,
          claims: task.claims.map((claim) => ({ resource: claim.resourceId, access: claim.access })),
        },
        db,
      );
      proposalIdToTaskId.set(task.id, created.id);
    }
    for (const edge of validated.dependencies) {
      const taskId = proposalIdToTaskId.get(edge.taskId);
      const dependsOnTaskId = proposalIdToTaskId.get(edge.dependsOnTaskId);
      if (taskId === undefined || dependsOnTaskId === undefined) {
        throw usageError(`validated dependency references unknown task after persist: ${edge.taskId} → ${edge.dependsOnTaskId}`);
      }
      await createTaskDependency({ taskId, dependsOnTaskId }, db);
    }
    persistedTaskIds = validated.tasks.map((task) => proposalIdToTaskId.get(task.id) as string);

    // M19.5 lifecycle: a new plan was persisted (reuse path above emits
    // nothing — re-running the same proposal is not a new plan).
    await recordEvent(
      {
        type: "PLAN_CREATED",
        featureId: feature.id,
        actor: options.actor ?? "atlas-cli-plan",
        payload: { tasks: persistedTaskIds.length, proposalSha256: hash.slice(0, 12) },
      },
      db,
    );

    const created = await createApproval(
      { featureId: feature.id, context: PLAN_APPROVAL_CONTEXT, note: approvalNoteFor(hash) },
      db,
    );
    approvalId = created.id;
    approvalStatus = created.status;
    if (options.approve === true) {
      if (options.actor === undefined || options.actor.trim().length === 0) {
        throw usageError("--approve requires --actor <name>: approvals are never silent");
      }
      const decided = await decideApproval(created.id, { decision: "APPROVED", actor: options.actor });
      approvalStatus = decided.status;
    }
  }

  // Preview only: hypothetical workers feed the real scheduler for display.
  // Nothing is created, assigned, or executed.
  const previewWorkers = Array.from({ length: maxConcurrency }, (_, index) => ({
    id: `preview-worker-${index + 1}`,
    status: WorkerStatus.IDLE,
  }));
  const preview = planSchedule(toSchedulerInput(validated, { workers: previewWorkers, maxConcurrency }));

  const taskLines = validated.tasks.map((task) => {
    const claims = task.claims.map((claim) => `${claim.access} ${claim.resourceId}`).join(", ");
    return `  - ${task.id} "${task.title}" [${claims.length === 0 ? "no claims" : claims}]`;
  });
  const depLines = validated.dependencies.map((edge) => `  - ${edge.taskId} depends on ${edge.dependsOnTaskId}`);
  const waveLines = preview.groups.map((group, index) => `  wave ${index + 1}: ${group.tasks.join(", ")}`);
  const conflictLines = preview.resourceConflicts.map(
    (conflict) => `  - ${conflict.taskA} <-> ${conflict.taskB} (${conflict.details.map((detail) => detail.kind).join(", ")})`,
  );
  const blockedLines = preview.blockedTasks.map((entry) => `  - ${entry.taskId}: ${entry.reason}`);
  // Advisory execution-strategy recommendation (M29.3 Phase 1/3): computed
  // over the validated proposal, recorded for human review. It never
  // changes what plan persists or approves; the approval below covers the
  // exact task list shown, whatever its shape. Approving a shape that
  // diverges from the recommendation IS the auditable override: the
  // recommendation, the approval actor/timestamp, and the run-time actual
  // are all recorded separately.
  const routingRecommendation = recommendRoute(validated.tasks, validated.dependencies);
  const human = [
    `atlas plan`,
    `feature: ${feature.id}`,
    `proposal: ${options.proposal} (sha256:${hash.slice(0, 12)}…)`,
    `tasks (${validated.tasks.length}):`,
    ...taskLines,
    `dependencies (${validated.dependencies.length}):`,
    ...(depLines.length > 0 ? depLines : ["  (none)"]),
    `schedule preview (${maxConcurrency} hypothetical workers, display only):`,
    ...(waveLines.length > 0 ? waveLines : ["  (nothing schedulable)"]),
    ...(conflictLines.length > 0 ? ["resource conflicts:", ...conflictLines] : []),
    ...(blockedLines.length > 0 ? ["blocked:", ...blockedLines] : []),
    alreadyApproved
      ? `plan approval: ${approvalId} (already APPROVED)`
      : `plan approval: ${approvalId} (${approvalStatus})`,
    `routing (advisory): recommended=${routingRecommendation.route} :: ${routingRecommendation.reasons.map((r) => r.detail).join(" | ")}`,
  ].join("\n");

  return {
    exitCode: EXIT_OK,
    human,
    data: {
      featureId: feature.id,
      proposalHash: hash,
      approval: { id: approvalId, status: approvalStatus },
      routingRecommendation,
      tasks: validated.tasks.map((task) => ({
        id: task.id,
        title: task.title,
        claims: task.claims,
        dependsOn: validated.dependencies.filter((edge) => edge.taskId === task.id).map((edge) => edge.dependsOnTaskId),
      })),
      persistedTaskIds,
      preview: { waves: preview.groups.map((group) => group.tasks), conflicts: preview.resourceConflicts, blocked: preview.blockedTasks },
    },
  };
}
