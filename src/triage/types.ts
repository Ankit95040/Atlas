import { z } from "zod";
import { commitShaSchema, idSchema } from "../core/inputs.js";

// ---------- Classifications (evidence-backed only; combinable) ----------

export const TriageClassificationSchema = z.enum([
  "CLAIM_CONFLICT",
  "GIT_CONFLICT",
  "EMPTY_MERGE",
  "DEPENDENCY_ORDERING",
  "SEMANTIC_RISK",
  "UNKNOWN",
]);

export type TriageClassification = z.infer<typeof TriageClassificationSchema>;

/** Fixed order for deterministic classification arrays. */
export const CLASSIFICATION_ORDER: readonly TriageClassification[] = [
  "CLAIM_CONFLICT",
  "GIT_CONFLICT",
  "EMPTY_MERGE",
  "DEPENDENCY_ORDERING",
  "SEMANTIC_RISK",
  "UNKNOWN",
] as const;

// ---------- Input (a halted train, described — never re-executed) ----------

const TriageTrainItemSchema = z
  .object({
    taskId: idSchema,
    workerId: idSchema,
    status: z.enum(["INTEGRATED", "CONFLICT", "MERGE_FAILED", "SKIPPED_EMPTY", "TESTS_FAILED", "VERIFICATION_FAILED", "NOT_ATTEMPTED"]),
    testRunId: idSchema.optional(),
    mergeCommit: commitShaSchema.optional(),
    reason: z.string().max(5000).optional(),
    /**
     * Set by the merge train when a worker branch contained no changes over
     * the integration base (M19.3). Drives the EMPTY_MERGE finding; absent
     * everywhere else (absence is not evidence).
     */
    emptyMerge: z.boolean().optional(),
  })
  .strict();

const FAILURE_STATUSES = ["CONFLICT", "MERGE_FAILED", "TESTS_FAILED", "VERIFICATION_FAILED"] as const;

export function isFailureStatus(status: string): boolean {
  return (FAILURE_STATUSES as readonly string[]).includes(status);
}

export const TriageIntegrationHaltInputSchema = z
  .object({
    repositoryId: idSchema,
    baseCommit: commitShaSchema,
    /** Train HEAD at halt: the replay base. Read, never modified. */
    finalCommit: commitShaSchema,
    /** Train items with their terminal statuses (INTEGRATED/CONFLICT/…). */
    items: z.array(TriageTrainItemSchema).min(1).max(100),
    /** Parent dir for the throwaway replay worktree (removed in `finally`). */
    scratchParent: z.string().trim().min(1, "scratchParent must not be empty"),
  })
  .strict();

export type TriageIntegrationHaltInput = z.infer<typeof TriageIntegrationHaltInputSchema>;

// ---------- Findings (all sorted; all JSON-serializable) ----------

const coveringClaimSchema = z
  .object({
    taskId: z.string(),
    resourceId: z.string(),
    access: z.enum(["READ", "WRITE"]),
  })
  .strict();

export const FileOwnershipSchema = z
  .object({
    file: z.string(),
    /** Integrated tasks whose branch demonstrably touched this file. Never guessed. */
    owners: z.array(z.string()),
    /** True when no owner could be proven — report unknown, never invent. */
    unknownOwner: z.boolean(),
    /** Declared claims covering this file, per task. */
    coveringClaims: z.array(coveringClaimSchema),
  })
  .strict();

export type FileOwnership = z.infer<typeof FileOwnershipSchema>;

const conflictDetailSchema = z
  .object({
    resourceA: z.string(),
    resourceB: z.string(),
    accessA: z.enum(["READ", "WRITE"]),
    accessB: z.enum(["READ", "WRITE"]),
    kind: z.enum(["READ_WRITE", "WRITE_READ", "WRITE_WRITE"]),
  })
  .strict();

export const ClaimOverlapSchema = z
  .object({
    taskA: z.string(),
    taskB: z.string(),
    details: z.array(conflictDetailSchema),
  })
  .strict();

export type ClaimOverlap = z.infer<typeof ClaimOverlapSchema>;

export const DependencyLinkSchema = z
  .object({
    taskId: z.string(),
    dependsOnTaskId: z.string(),
    /** Direction relative to the halted task. */
    direction: z.enum(["halted-waits-for-owner", "owner-waits-for-halted"]),
  })
  .strict();

export type DependencyLink = z.infer<typeof DependencyLinkSchema>;

export const SemanticFlagSchema = z
  .object({
    kind: z.enum(["SHARED_WRITE_WITHOUT_TEXTUAL_CONFLICT", "CUMULATIVE_TESTS_FAILED"]),
    detail: z.string(),
    tasks: z.array(z.string()),
    /**
     * Always true: semantic risk is a review signal, never a proven verdict.
     * Atlas must not pretend it knows semantic correctness.
     */
    notProven: z.literal(true),
  })
  .strict();

export type SemanticFlag = z.infer<typeof SemanticFlagSchema>;

// ---------- Recommended actions (fixed vocabulary, never executed) ----------

export const TriageActionSchema = z.enum([
  "review-conflicting-files",
  "revise-claims",
  "revise-one-implementation",
  "review-task-ordering",
  "add-dependency-edge",
  "split-shared-resources",
  "human-review-required",
  "inspect-train-worktree",
  "replan-or-abandon",
]);

export type TriageAction = z.infer<typeof TriageActionSchema>;

// ---------- Report ----------

export const TriageReportSchema = z
  .object({
    repositoryId: z.string(),
    baseCommit: z.string(),
    finalCommit: z.string(),
    haltedTaskId: z.string(),
    haltedStatus: z.string(),
    /** Git-confirmed unmerged paths (empty unless GIT_CONFLICT). */
    conflictFiles: z.array(z.string()),
    ownership: z.array(FileOwnershipSchema),
    claimOverlap: z.array(ClaimOverlapSchema),
    dependencyLinks: z.array(DependencyLinkSchema),
    semanticFlags: z.array(SemanticFlagSchema),
    classifications: z.array(TriageClassificationSchema),
    recommendedActions: z.array(TriageActionSchema),
    evidenceRefs: z
      .object({
        artifactId: z.string(),
        mergeCommits: z.array(z.string()),
      })
      .strict(),
    /** Honest notes: what could not be collected and why. */
    collectionNotes: z.array(z.string()),
  })
  .strict();

export type TriageReport = z.infer<typeof TriageReportSchema>;
