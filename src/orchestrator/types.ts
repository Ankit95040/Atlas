import { z } from "zod";
import { commitShaSchema, idSchema } from "../core/inputs.js";

/**
 * Input for the M11 feature wave-run loop. Strict: unknown keys rejected.
 *
 * The loop derives its task set from the feature (plus transitive
 * prerequisites pulled in by the M6 loader, cross-feature included). No
 * rebase, no branch recreation, no merge-to-main: integration happens only
 * through the approval-gated M9 merge train onto `trainBranch`.
 */
export const RunFeatureWaveLoopInputSchema = z
  .object({
    /** Feature whose tasks (and their transitive prerequisites) will run. */
    featureId: idSchema,
    /** Repository the work runs against (must belong to the feature's project). */
    repositoryId: idSchema,
    /** Base commit every worker worktree starts from and is gated on. */
    baseCommit: commitShaSchema,
    /** Root under which isolated worker workspaces are created. */
    workspaceRoot: z.string().trim().min(1, "workspaceRoot must not be empty"),
    /** Dedicated integration branch for the merge train (never main). */
    trainBranch: z.string().trim().min(1, "trainBranch must not be empty").max(255),
    /** Destination for the Atlas-owned train worktree (left in place). */
    trainPath: z.string().trim().min(1, "trainPath must not be empty"),
    /**
     * Actor recorded on the per-task execution approvals and the train
     * approval. Explicit and auditable; M12 wires this to a human decision.
     */
    approvalActor: z.string().trim().min(1, "approvalActor must not be empty").max(200),
    /** Upper bound on wave width; capacity is min(maxConcurrency, idle workers). */
    maxConcurrency: z.number().int().min(1).max(100).default(4),
    /**
     * Existing IDLE worker pool. When omitted, the loop creates one worker
     * per discovered task (workers are single-use: one task per worker).
     */
    workerIds: z.array(idSchema).max(100).optional(),
    /** Explicit test argv for `runTests`; otherwise resolved from package.json. */
    testCommand: z.array(z.string().min(1)).min(1).max(50).optional(),
    /** Safety bound on scheduling rounds; defaults to taskCount + 1. */
    maxWaves: z.number().int().min(1).max(1000).optional(),
  })
  .strict();

export type RunFeatureWaveLoopInput = z.infer<typeof RunFeatureWaveLoopInputSchema>;
