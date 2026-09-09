import { z } from "zod";
import { resourceClaimSchema, type ResourceClaim } from "./inputs.js";
import { InvariantViolationError } from "./errors.js";

const COMMIT_SHA_PATTERN = /^[0-9a-fA-F]{7,40}$/;

export function isCommitSha(value: string): boolean {
  return COMMIT_SHA_PATTERN.test(value.trim());
}

export function assertCommitSha(value: string): void {
  if (!isCommitSha(value)) {
    throw new InvariantViolationError("sha must be a Git SHA-like hex string (7-40 chars)");
  }
}

export function serializeResourceClaims(claims: ResourceClaim[]): string {
  return JSON.stringify(claims);
}

/** Parse the JSON-encoded resourceClaims column back into validated claims. */
export function parseResourceClaims(value: string): ResourceClaim[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new InvariantViolationError("task resourceClaims is not valid JSON");
  }
  return z.array(resourceClaimSchema).parse(parsed);
}

export function serializeMetadata(payload: Record<string, unknown> | undefined): string | undefined {
  if (payload === undefined) {
    return undefined;
  }
  return JSON.stringify(payload);
}

export function assertNoSelfDependency(taskId: string, dependsOnTaskId: string): void {
  if (taskId === dependsOnTaskId) {
    throw new InvariantViolationError("a task cannot depend on itself");
  }
}

/** Dependencies are valid only within a single feature's task graph. */
export function assertSameFeature(featureIdA: string, featureIdB: string): void {
  if (featureIdA !== featureIdB) {
    throw new InvariantViolationError("task dependencies must stay within the same feature");
  }
}

/**
 * Drop undefined-valued keys before Prisma writes. Under
 * exactOptionalPropertyTypes Zod inputs carry `prop?: T | undefined` while
 * Prisma expects absent-or-null; for Prisma, absent ≡ undefined, so stripping
 * is semantics-preserving and keeps the boundary in one place.
 */
export function stripUndefined<T extends object>(data: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out as { [K in keyof T]: Exclude<T[K], undefined> };
}
