import { z } from "zod";
import { commitShaSchema, idSchema } from "../core/inputs.js";

// ---------- Test execution ----------

export const TestCommandSchema = z.object({
  /** Argv array, executable first. Never a shell string. */
  command: z.array(z.string().min(1, "command argument must not be empty")).min(1).max(50),
  timeoutMs: z.number().int().min(1000).max(3600000).default(120000),
});

export type TestCommand = z.infer<typeof TestCommandSchema>;

export const RunTestsInputSchema = z
  .object({
    taskId: idSchema,
    /** Directory the command runs in (a workspace or train worktree). */
    workdir: z.string().trim().min(1, "workdir must not be empty"),
    /** Explicit command; when omitted, resolved from the repo's package.json. */
    command: z.array(z.string().min(1)).min(1).max(50).optional(),
    name: z.string().trim().min(1).max(300).optional(),
    timeoutMs: z.number().int().min(1000).max(3600000).optional(),
  })
  .strict();

export type RunTestsInput = z.infer<typeof RunTestsInputSchema>;

export type TestExecutionStatus = "PASSED" | "FAILED" | "CANCELLED";

export interface TestExecutionResult {
  readonly testRunId: string;
  readonly status: TestExecutionStatus;
  readonly command: string[];
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

// ---------- Verification ----------

export const VerifyExecutionInputSchema = z
  .object({
    taskId: idSchema,
    workerId: idSchema,
    expectedBaseCommit: commitShaSchema,
    /** Atlas-executed TestRun cited as evidence; must belong to taskId and be PASSED. */
    testRunId: idSchema,
  })
  .strict();

export type VerifyExecutionInput = z.infer<typeof VerifyExecutionInputSchema>;

export type VerificationVerdict = "VERIFIED" | "REJECTED";

export type VerificationReason =
  | "LINK_INVALID"
  | "WORKSPACE_INVALID"
  | "BASE_MISMATCH"
  | "CLAIM_VIOLATION"
  | "TESTS_NOT_PASSED";

export interface VerificationCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface VerificationResult {
  readonly verdict: VerificationVerdict;
  readonly taskId: string;
  readonly workerId: string;
  readonly testRunId: string;
  /** Worktree HEAD observed during verification. */
  readonly commit: string;
  /** Fixed order; every check always present. */
  readonly checks: VerificationCheck[];
  readonly reasons: VerificationReason[];
  readonly changedResources: string[];
  readonly artifactId: string;
}

// ---------- Merge train ----------

const MergeTrainItemSchema = z
  .object({
    taskId: idSchema,
    workerId: idSchema,
    expectedBaseCommit: commitShaSchema,
    testRunId: idSchema,
    /**
     * Optional caller-determined integration position. Items with a sequence
     * integrate first (ascending); items without one keep the legacy
     * taskId-sorted order after them. Lets callers with a stable order
     * (e.g. scheduler waves) get deterministic integration order without
     * depending on random database IDs.
     */
    sequence: z.number().int().min(0).optional(),
  })
  .strict();

export const MergeTrainInputSchema = z
  .object({
    repositoryId: idSchema,
    trainBranch: z.string().trim().min(1, "trainBranch must not be empty").max(255),
    /** Destination for the Atlas-owned integration worktree (left in place). */
    trainPath: z.string().trim().min(1, "trainPath must not be empty"),
    baseCommit: commitShaSchema,
    /** Explicit APPROVED decision authorizing this train run. */
    approvalId: idSchema,
    items: z.array(MergeTrainItemSchema).min(1, "merge train needs at least one item").max(100),
    /** Explicit test command; otherwise resolved per worktree from package.json. */
    testCommand: z.array(z.string().min(1)).min(1).max(50).optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    const seen = new Set<string>();
    for (const item of input.items) {
      if (seen.has(item.taskId)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate train task: ${item.taskId}` });
      }
      seen.add(item.taskId);
    }
  });

export type MergeTrainInput = z.infer<typeof MergeTrainInputSchema>;

export type IntegratedItemStatus =
  | "INTEGRATED"
  | "CONFLICT"
  | "TESTS_FAILED"
  | "VERIFICATION_FAILED"
  | "MERGE_FAILED"
  | "SKIPPED_EMPTY"
  | "NOT_ATTEMPTED";

export interface IntegratedItem {
  readonly taskId: string;
  readonly workerId: string;
  readonly status: IntegratedItemStatus;
  readonly mergeCommit?: string;
  readonly testRunId?: string;
  readonly reason?: string;
  /**
   * Wall-clock ms spent processing this item in the train loop (M19.1:
   * re-verify, merge, cumulative tests, commit). Always set by
   * runMergeTrain; optional so previously constructed items still typecheck.
   */
  readonly durationMs?: number | null;
  /**
   * Worker branch HEAD at merge time (M19.3; durable identity of what was
   * merged or failed to merge). Best-effort: absent when unreadable.
   */
  readonly sourceCommit?: string;
  /**
   * Git-confirmed unmerged paths for CONFLICT items (M19.3; mirrors the
   * reason text structurally). Absent otherwise.
   */
  readonly conflictFiles?: readonly string[];
  /**
   * True when the worker branch contained no changes over the integration
   * base (M19.3; the staged-empty halt). Drives the EMPTY_MERGE triage
   * finding. Absent (never false) otherwise — absence is not evidence.
   */
  readonly emptyMerge?: boolean;
  /** Git exit code for git-command MERGE_FAILED items (M19.3). */
  readonly gitExitCode?: number | null;
  /** Bounded git stderr for git-command MERGE_FAILED items (M19.3). */
  readonly gitStderr?: string;
}

export interface MergeTrainResult {
  readonly status: "COMPLETED" | "HALTED";
  readonly trainBranch: string;
  readonly trainPath: string;
  readonly baseCommit: string;
  readonly finalCommit: string;
  readonly items: IntegratedItem[];
  /**
   * Wall-clock ms for the whole train run (M19.1). Always set by
   * runMergeTrain; optional for compatibility.
   */
  readonly durationMs?: number | null;
  /**
   * Cumulative test command used for the train gates, echoed from input
   * (M19.3). Absent when the caller let each worktree resolve its own.
   */
  readonly testCommand?: readonly string[];
  readonly haltReason?: string;
  readonly approval: {
    readonly id: string;
    readonly actor: string | null;
    readonly decidedAt: Date | null;
  };
}
