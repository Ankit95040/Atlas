import { z } from "zod";
import { commitShaSchema, idSchema } from "../core/inputs.js";
import type { NormalizedClaim } from "../claims/types.js";

// ---------- Runtime entry (Atlas-side; workspace path always comes from the DB) ----------

export const ExecuteTaskInput = z
  .object({
    taskId: idSchema,
    workerId: idSchema,
    expectedBaseCommit: commitShaSchema,
  })
  .strict();

export type ExecuteTaskInput = z.infer<typeof ExecuteTaskInput>;

// ---------- Provider input (minimum necessary context; no secrets, no env) ----------

export interface WorkerExecutionInput {
  readonly taskId: string;
  readonly workerId: string;
  /** Atlas-assigned workspace path, resolved from the Workspace record. */
  readonly workspacePath: string;
  readonly taskTitle: string;
  readonly taskDescription?: string;
  readonly resourceClaims: readonly NormalizedClaim[];
  /** Base commit the workspace was verified to start from. */
  readonly repositoryCommit: string;
  readonly relevantContext: {
    readonly branch: string | null;
    readonly featureId: string;
  };
}

// ---------- Provider output (untrusted; always schema-validated) ----------

export const ProviderOutputSchema = z
  .object({
    summary: z.string().trim().min(1, "provider summary must not be empty").max(5000),
    notes: z.string().max(5000).optional(),
    /** Provider self-report only — never treated as verification evidence. */
    testsPassed: z.boolean().optional(),
    /** Informational only. Atlas recomputes actual changes from Git itself. */
    filesChanged: z.array(z.string().max(1000)).max(500).optional(),
  })
  .strict();

export type ProviderOutput = z.infer<typeof ProviderOutputSchema>;

// ---------- Execution result (the only success channel) ----------

export type WorkerExecutionStatus =
  | "COMPLETED"
  | "FAILED"
  | "CLAIM_VIOLATION"
  | "INVALID_WORKSPACE"
  | "NOT_AUTHORIZED"
  | "BASE_COMMIT_MISMATCH";

export type ChangedFileChange = "ADDED" | "MODIFIED" | "DELETED" | "RENAMED";

export interface ChangedResource {
  /** Repository-root-relative POSIX path, sorted in result lists. */
  readonly path: string;
  readonly change: ChangedFileChange;
  /** Previous path for renames. */
  readonly oldPath?: string;
}

export interface WorkerExecutionResult {
  readonly taskId: string;
  readonly workerId: string;
  readonly workspaceId?: string;
  readonly status: WorkerExecutionStatus;
  readonly baseCommit?: string;
  readonly finalCommit?: string;
  readonly changedResources: ChangedResource[];
  /** Changed paths not covered by any WRITE claim (sorted, unique). */
  readonly undeclaredResources: string[];
  readonly artifacts?: {
    readonly summaryArtifactId: string;
  };
  readonly error?: string;
  /** Provider's own summary, echoed verbatim. Never verification evidence. */
  readonly providerSummary?: string;
}
