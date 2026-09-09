import { ResourceClaimConflictError } from "./errors.js";
import type { ClaimComparison, ConflictDetail, NormalizedClaim } from "./types.js";

/**
 * Segment-wise overlap: one id is the other, or a proper ancestor of it.
 * `src/auth` overlaps `src/auth/login.ts` in both directions, but never
 * `src/authentication/login.ts` — naive string-prefix matching would get that
 * wrong, so segments are compared one by one.
 */
export function resourceOverlaps(a: string, b: string): boolean {
  const left = a.split("/");
  const right = b.split("/");
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function conflictKind(accessA: NormalizedClaim["access"], accessB: NormalizedClaim["access"]): ConflictDetail["kind"] {
  if (accessA === "WRITE" && accessB === "WRITE") {
    return "WRITE_WRITE";
  }
  return accessA === "READ" ? "READ_WRITE" : "WRITE_READ";
}

/**
 * Deterministic pairwise comparison. READ+READ on an overlap is sharing, not
 * a conflict; any WRITE involved is a conflict. Result order follows input
 * order; checking two empty sets is NO_CONFLICT with zero pairs.
 */
export function compareClaimSets(
  a: readonly NormalizedClaim[],
  b: readonly NormalizedClaim[],
): ClaimComparison {
  const conflicts: ConflictDetail[] = [];
  for (const claimA of a) {
    for (const claimB of b) {
      if (!resourceOverlaps(claimA.resourceId, claimB.resourceId)) {
        continue;
      }
      if (claimA.access === "READ" && claimB.access === "READ") {
        continue;
      }
      conflicts.push({
        resourceA: claimA.resourceId,
        resourceB: claimB.resourceId,
        accessA: claimA.access,
        accessB: claimB.access,
        kind: conflictKind(claimA.access, claimB.access),
      });
    }
  }
  const checkedPairs = a.length * b.length;
  if (conflicts.length === 0) {
    return { status: "NO_CONFLICT", checkedPairs };
  }
  return { status: "CONFLICT", checkedPairs, conflicts };
}

/** Strict variant for callers that want a thrown conflict instead of data. */
export function assertNoConflict(a: readonly NormalizedClaim[], b: readonly NormalizedClaim[]): void {
  const comparison = compareClaimSets(a, b);
  if (comparison.status === "CONFLICT") {
    throw new ResourceClaimConflictError(comparison.conflicts);
  }
}
