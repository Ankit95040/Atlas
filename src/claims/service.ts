import type { PrismaClient } from "@prisma/client";
import { getPrismaClient } from "../db/client.js";
import { NotFoundError } from "../core/errors.js";
import type { RepositoryAnalysis } from "../analyzer/types.js";
import { compareClaimSets } from "./conflicts.js";
import { InvalidResourceClaimError } from "./errors.js";
import { deduplicateClaims, normalizeClaimInput } from "./normalize.js";
import {
  CreateTaskClaimsInput,
  type ClaimComparison,
  type EnrichedClaim,
  type NormalizedClaim,
} from "./types.js";

// ---------- Persistence ----------
//
// Decision (spec Part 5): NO new Prisma table. The Milestone 2
// `Task.resourceClaims` JSON column remains the single store — a second table
// would be a competing source of truth, and V0.1 has no indexed-query
// consumer (no scheduler yet). New writes keep M2's `{path, mode}` shape with
// uppercase modes; the reader below accepts legacy lowercase rows too, so
// nothing written by Milestone 2 becomes unreadable. If the scheduler later
// needs indexed claim queries, promote this to a table then.

interface StoredClaimRow {
  readonly path: string;
  readonly mode: string;
}

function isStoredClaimRow(value: unknown): value is StoredClaimRow {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return typeof row["path"] === "string" && typeof row["mode"] === "string";
}

/** Parse stored JSON (legacy lowercase or current uppercase) into normalized claims. */
export function readTaskClaims(stored: string): NormalizedClaim[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored) as unknown;
  } catch {
    throw new InvalidResourceClaimError("task resource claims are not valid JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new InvalidResourceClaimError("task resource claims must be a JSON array");
  }
  const claims: NormalizedClaim[] = [];
  for (const item of parsed) {
    if (!isStoredClaimRow(item)) {
      throw new InvalidResourceClaimError("task resource claims must be {path, mode} objects");
    }
    claims.push(normalizeClaimInput(item.path, item.mode));
  }
  return deduplicateClaims(claims);
}

export async function getTaskClaims(taskId: string, db: PrismaClient = getPrismaClient()): Promise<NormalizedClaim[]> {
  const task = await db.task.findUnique({ where: { id: taskId } });
  if (task === null) {
    throw new NotFoundError("Task", taskId);
  }
  return readTaskClaims(task.resourceClaims);
}

/**
 * Explicit claim submission (never inferred): validate → normalize →
 * deduplicate → persist, replacing the task's claim set. Same input always
 * produces byte-identical stored JSON (fully idempotent).
 */
export async function createTaskClaims(raw: unknown, db: PrismaClient = getPrismaClient()): Promise<NormalizedClaim[]> {
  const input = CreateTaskClaimsInput.parse(raw);
  const task = await db.task.findUnique({ where: { id: input.taskId } });
  if (task === null) {
    throw new NotFoundError("Task", input.taskId);
  }
  const claims = deduplicateClaims(
    input.claims.map((claim) => normalizeClaimInput(claim.resource, claim.access)),
  );
  const stored = JSON.stringify(claims.map((claim) => ({ path: claim.resourceId, mode: claim.access })));
  await db.task.update({ where: { id: task.id }, data: { resourceClaims: stored } });
  return claims;
}

/** Load two tasks' claim sets and compare them deterministically. */
export async function checkTaskPair(
  taskIdA: string,
  taskIdB: string,
  db: PrismaClient = getPrismaClient(),
): Promise<ClaimComparison> {
  const [claimsA, claimsB] = await Promise.all([getTaskClaims(taskIdA, db), getTaskClaims(taskIdB, db)]);
  return compareClaimSets(claimsA, claimsB);
}

// ---------- Claim vs analysis validation ----------

/**
 * A claim is valid against an analysis when it names a resource in the map
 * (enriched with the detected kind), or — for WRITE only — a well-formed
 * future resource such as a file the task will create. READ of an absent
 * resource is rejected: you cannot read what does not exist.
 */
export function validateClaimsAgainstAnalysis(
  claims: readonly NormalizedClaim[],
  analysis: RepositoryAnalysis,
): EnrichedClaim[] {
  const kinds = new Map(analysis.resources.map((resource) => [resource.id, resource.kind]));
  return claims.map((claim) => {
    const detectedKind = kinds.get(claim.resourceId) ?? null;
    if (detectedKind === null && claim.access === "READ") {
      throw new InvalidResourceClaimError(
        `claim ${claim.resourceId} (READ) matches no resource in analysis ${analysis.analyzedCommit}`,
      );
    }
    return { ...claim, detectedKind };
  });
}
