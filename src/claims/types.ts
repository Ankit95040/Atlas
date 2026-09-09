import { z } from "zod";
import { idSchema } from "../core/inputs.js";
import type { ResourceKind } from "../analyzer/types.js";

/**
 * Small access vocabulary. READ is shareable; WRITE is exclusive against any
 * other access on an overlapping resource — including the creation of files
 * that do not exist yet (a WRITE claim may reference a future file).
 */
export type AccessMode = "READ" | "WRITE";

/**
 * Claim target shape. FILE vs DIRECTORY is metadata only: overlap is decided
 * purely by normalized path segments (a repo can never contain both a file
 * and a directory at the same path, so one canonical id is unambiguous).
 */
export type ClaimKind = "FILE" | "DIRECTORY";

export interface NormalizedClaim {
  /** Canonical id: repo-relative POSIX segments, no trailing slash. */
  readonly resourceId: string;
  readonly kind: ClaimKind;
  readonly access: AccessMode;
}

export const ClaimAccessInput = z
  .string()
  .trim()
  .min(1, "claim access must not be empty")
  .transform((value) => value.toUpperCase())
  .pipe(z.enum(["READ", "WRITE"], { errorMap: () => ({ message: "claim access must be READ or WRITE" }) }));

export const ClaimResourceInput = z.string().trim().min(1, "claim resource must not be empty").max(1000);

/**
 * Explicit caller-provided claims (never LLM-inferred in V0.1):
 * `{ taskId, claims: [{ resource: "src/auth/login.ts", access: "WRITE" }] }`.
 * A trailing slash marks a directory claim (`src/auth/`); without one the
 * claim denotes that exact path.
 */
export const CreateTaskClaimsInput = z.object({
  taskId: idSchema,
  claims: z
    .array(z.object({ resource: ClaimResourceInput, access: ClaimAccessInput }))
    .min(1, "at least one claim is required")
    .max(500, "too many claims in one request"),
});

export type CreateTaskClaimsInput = z.infer<typeof CreateTaskClaimsInput>;

/** Conflict flavor from the perspective of set A vs set B. */
export type ConflictKind = "READ_WRITE" | "WRITE_READ" | "WRITE_WRITE";

export interface ConflictDetail {
  readonly resourceA: string;
  readonly resourceB: string;
  readonly accessA: AccessMode;
  readonly accessB: AccessMode;
  readonly kind: ConflictKind;
}

export type ClaimComparison =
  | { readonly status: "NO_CONFLICT"; readonly checkedPairs: number }
  | { readonly status: "CONFLICT"; readonly checkedPairs: number; readonly conflicts: readonly ConflictDetail[] };

export interface EnrichedClaim extends NormalizedClaim {
  /**
   * Resource kind detected in the repository analysis, or null when the
   * resource does not exist yet (only legal for WRITE: future files/dirs).
   */
  readonly detectedKind: ResourceKind | null;
}
