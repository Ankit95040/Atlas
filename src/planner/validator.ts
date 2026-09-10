import { TaskStatus } from "@prisma/client";
import type { RepositoryAnalysis } from "../analyzer/types.js";
import { deduplicateClaims, normalizeClaimInput } from "../claims/normalize.js";
import { validateClaimsAgainstAnalysis } from "../claims/service.js";
import { TaskGraph } from "../dag/graph.js";
import {
  PlannerProposalSchema,
  type ValidatedDependency,
  type ValidatedPlannerPlan,
  type ValidatedTask,
} from "./types.js";

export interface ValidateProposalOptions {
  /**
   * Optional repository analysis for resource-existence checks. WRITE claims
   * may name future resources; READ claims must match the map. When omitted,
   * paths are still normalized and structurally validated, but existence is
   * not checked.
   */
  readonly analysis?: RepositoryAnalysis;
}

function compareIds(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

/**
 * Deterministic validation boundary: UNTRUSTED proposal → validated plan.
 *
 * 1. Strict Zod shape check (aggregates every structural/adversarial defect:
 *    missing fields, extra keys, bad ids, empty titles, duplicate tasks,
 *    dangling/self/duplicate dependency edges).
 * 2. M5 claim normalization per task (throws InvalidResourceClaimError on
 *    bad paths or access modes), deduplicated and sorted.
 * 3. M6 TaskGraph cycle detection over the proposed edges (throws
 *    DependencyCycleError). Cross-feature-style edges are not restricted:
 *    proposal tasks carry no shared-feature constraint.
 * 4. Optional M5 resource-existence check against a repository analysis.
 *
 * Pure and deterministic: same proposal (+ same analysis) → equivalent plan.
 * Resource conflicts are deliberately NOT converted into dependency edges —
 * the M6 scheduler reports them as SERIALIZED_RESOURCE_CONFLICT instead.
 */
export function validatePlannerProposal(
  raw: unknown,
  options: ValidateProposalOptions = {},
): ValidatedPlannerPlan {
  const proposal = PlannerProposalSchema.parse(raw);

  const tasks: ValidatedTask[] = proposal.tasks.map((task) => {
    const claims = deduplicateClaims(task.claims.map((claim) => normalizeClaimInput(claim.resource, claim.access)));
    return {
      id: task.id,
      title: task.title,
      claims,
      ...(task.description !== undefined ? { description: task.description } : {}),
      ...(task.featureId !== undefined ? { featureId: task.featureId } : {}),
    };
  });
  tasks.sort((a, b) => compareIds(a.id, b.id));

  const graph = new TaskGraph();
  for (const task of tasks) {
    graph.addTask({ id: task.id, status: TaskStatus.PENDING, claims: task.claims });
  }
  const dependencies: ValidatedDependency[] = proposal.dependencies
    .map((edge) => ({ taskId: edge.taskId, dependsOnTaskId: edge.dependsOnTaskId }))
    .sort((a, b) => compareIds(a.taskId, b.taskId) || compareIds(a.dependsOnTaskId, b.dependsOnTaskId));
  for (const edge of dependencies) {
    graph.addDependency(edge.taskId, edge.dependsOnTaskId);
  }
  graph.assertAcyclic();

  if (options.analysis !== undefined) {
    for (const task of tasks) {
      validateClaimsAgainstAnalysis(task.claims, options.analysis);
    }
  }

  return {
    kind: "ValidatedPlannerPlan" as const,
    featureId: proposal.featureId,
    tasks,
    dependencies,
    ...(proposal.rationale !== undefined ? { rationale: proposal.rationale } : {}),
    ...(proposal.metadata !== undefined ? { metadata: proposal.metadata } : {}),
  };
}
