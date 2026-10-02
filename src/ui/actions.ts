import type { PrismaClient } from "@prisma/client";
import { getPrismaClient } from "../db/client.js";
import { decideApproval } from "../core/service.js";
import { PLAN_APPROVAL_CONTEXT } from "../cli/plan.js";

// Operator plan approval for the dashboard (M24.3).
//
// Reuses the exact service boundary the CLI uses: decideApproval enforces
// exists/PENDING/actor, and this action replicates the CLI's feature +
// context scoping (run-command refuses approvals that do not target the
// feature with the plan context). Like the CLI, approving emits no event —
// the APPROVED row is the record. Stale-safe: deciding an already-decided
// approval throws InvalidTransitionError instead of double-applying.

export interface ApprovePlanActionInput {
  readonly featureId: string;
  readonly approvalId: string;
  readonly actor?: string;
}

export interface ApprovePlanActionResult {
  readonly approvalId: string;
  readonly previousStatus: string;
  readonly resultingStatus: string;
  readonly actor: string;
}

function actionError(message: string): Error {
  const error = new Error(message);
  error.name = "PlanApprovalActionError";
  return error;
}

export async function approvePlanAction(
  input: ApprovePlanActionInput,
  db: PrismaClient = getPrismaClient(),
): Promise<ApprovePlanActionResult> {
  const actor = input.actor?.trim() ?? "";
  if (actor.length === 0) {
    throw actionError("approval requires an actor: approvals are never silent");
  }
  const approval = await db.approval.findUnique({ where: { id: input.approvalId } });
  if (approval === null) {
    throw actionError(`plan approval not found: ${input.approvalId}`);
  }
  if (approval.featureId !== input.featureId) {
    throw actionError(
      `plan approval ${approval.id} targets feature ${approval.featureId ?? "none"}, not ${input.featureId}`,
    );
  }
  if (approval.context !== PLAN_APPROVAL_CONTEXT) {
    throw actionError(`approval ${approval.id} is not a plan approval (context: ${approval.context ?? "none"})`);
  }
  if (approval.status !== "PENDING") {
    throw actionError(`plan approval ${approval.id} is ${approval.status}: only PENDING plans can be approved here`);
  }
  const decided = await decideApproval(approval.id, { decision: "APPROVED", actor }, db);
  return { approvalId: decided.id, previousStatus: approval.status, resultingStatus: decided.status, actor };
}

export async function loadApprovablePlan(
  db: PrismaClient,
  featureId: string,
  approvalId: string,
): Promise<{ id: string; status: string; context: string | null; note: string | null; featureId: string | null }> {
  const approval = await db.approval.findUnique({ where: { id: approvalId } });
  if (approval === null || approval.featureId !== featureId) {
    throw actionError(`plan approval not found for this run: ${approvalId}`);
  }
  return {
    id: approval.id,
    status: approval.status,
    context: approval.context,
    note: approval.note,
    featureId: approval.featureId,
  };
}
