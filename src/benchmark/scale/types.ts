import { z } from "zod";
import { commitShaSchema } from "../../core/inputs.js";
import { BenchmarkStrategySchema } from "../types.js";

// ---------- Token estimator (Amendment A.2, TOKEN_ESTIMATOR_VERSION = 1) ----------

/** Versioned token estimator constant. Increment when the estimation formula changes. */
export const TOKEN_ESTIMATOR_VERSION = 1 as const;

// ---------- Setup contract (Amendment A.3) ----------

/** Default timeout for the entire setup phase (Amendment A.3). */
export const SCALE_SETUP_TIMEOUT_MS = 600_000 as const;

/** Version evidence captured at setup time for reproducibility. */
export const ScaleSetupEvidenceSchema = z
  .object({
    snapshotRef: z.string().trim().min(1).max(200),
    lockfileSha256: z.string().trim().max(200).nullable().default(null),
    nodeVersion: z.string().trim().min(1).max(100),
    runnerVersion: z.string().trim().max(100).nullable().default(null),
    setupWallTimeMs: z.number().int().min(0),
    networkUsedAtSetup: z.boolean(),
  })
  .strict();

export type ScaleSetupEvidence = z.infer<typeof ScaleSetupEvidenceSchema>;

// ---------- M18 complexity levels (design §1) ----------

export const ScaleComplexityLevelSchema = z.enum(["SMALL", "MEDIUM", "LARGE", "XL"]);

export type ScaleComplexityLevel = z.infer<typeof ScaleComplexityLevelSchema>;

export const ScaleStratumSchema = z.enum(["SYNTHETIC", "REAL_DERIVED"]);

export type ScaleStratum = z.infer<typeof ScaleStratumSchema>;

/** Repeats per arm per level (design §1.2). Tapered because per-run cost grows superlinearly. */
export const M18_LEVEL_REPEATS: Record<ScaleComplexityLevel, number> = {
  SMALL: 8,
  MEDIUM: 8,
  LARGE: 6,
  XL: 6,
};

/** Worker timeout per level in ms (design §5.4). Identical across arms within a level. */
export const M18_LEVEL_TIMEOUTS_MS: Record<ScaleComplexityLevel, number> = {
  SMALL: 600_000,
  MEDIUM: 600_000,
  LARGE: 900_000,
  XL: 1_200_000,
};

/** Task-count band per level (design §1.3). */
export const M18_LEVEL_TASK_BANDS: Record<ScaleComplexityLevel, { readonly min: number; readonly max: number }> = {
  SMALL: { min: 2, max: 4 },
  MEDIUM: { min: 5, max: 8 },
  LARGE: { min: 8, max: 15 },
  XL: { min: 15, max: 25 },
};

/** RealWorkloadKind value carried when an M18 workload is converted for the frozen M17 arms. */
export const M18_LEVEL_KINDS = {
  SMALL: "REALISTIC_INDEPENDENT",
  MEDIUM: "REALISTIC_DEPENDENCY_CHAIN",
  LARGE: "REALISTIC_SHARED_RESOURCE",
  XL: "REALISTIC_INTEGRATION_CONFLICT",
} as const;

// ---------- Behavioral probes (design §7) ----------

const scaleKey = z
  .string()
  .trim()
  .min(1, "key must not be empty")
  .max(100, "key is too long")
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, "key must be alphanumeric with dashes/underscores");

function safeRelativePath(path: string): boolean {
  if (path.length === 0 || path.length > 1000) {
    return false;
  }
  if (path.startsWith("/") || path.includes("\\")) {
    return false;
  }
  return path
    .split("/")
    .every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

const scaleFileSchema = z
  .object({
    path: z.string().trim().min(1, "file path must not be empty").max(1000),
    content: z.string().max(100000, "file content is too long"),
  })
  .refine((file) => safeRelativePath(file.path), {
    message: "file path must be repository-relative without traversal",
  });

const scaleClaimSchema = z.object({
  resource: z.string().trim().min(1, "claim resource must not be empty").max(1000),
  access: z.enum(["READ", "WRITE"]),
});

/**
 * One behavioral probe: a minimal argv command (never a shell string)
 * exercising the task's contract against a worktree. Exit 0 means the
 * contribution is present and operative; anything else means it is not.
 * Typically ["node", "-e", "<one-liner>"] with cwd set to the train head.
 */
export const ScaleProbeSchema = z
  .object({
    name: z.string().trim().min(1, "probe name must not be empty").max(200),
    command: z.array(z.string().min(1, "probe argv element must not be empty")).min(1).max(50),
    timeoutMs: z.number().int().min(100).max(600000).default(30000),
  })
  .strict();

export type ScaleProbe = z.infer<typeof ScaleProbeSchema>;

const scaleTaskSpecSchema = z.object({
  key: scaleKey,
  title: z.string().trim().min(1, "task title must not be empty").max(300),
  /** Human-authored brief with an exact behavioral contract (design §3.1, §3.6). */
  description: z.string().trim().min(1, "task description must not be empty").max(5000),
  featureKey: z.string().trim().min(1, "featureKey must not be empty").max(100),
  claims: z.array(scaleClaimSchema).min(1, "each task must declare at least one claim"),
  dependsOn: z.array(scaleKey).default([]),
  /** ≥1 pre-registered behavioral probe (design §7). Prompts never see these. */
  probes: z.array(ScaleProbeSchema).min(1, "each task must declare at least one behavioral probe"),
});

const scaleFeatureSpecSchema = z.object({
  key: z.string().trim().min(1, "featureKey must not be empty").max(100),
  title: z.string().trim().min(1, "feature title must not be empty").max(300),
});

/**
 * Real-repo snapshot overlay (design §2, Stratum B). The snapshot tree is
 * copied first; baseFiles/testFiles are then written over it (trim/overlay,
 * recorded here). sourceDir is validated at fixture-build time, never fetched
 * over the network: vendoring is a human step outside the harness.
 */
const scaleSnapshotSchema = z
  .object({
    sourceDir: z.string().trim().min(1, "snapshot sourceDir must not be empty").max(2000),
    ref: z.string().trim().min(1, "snapshot ref must not be empty").max(200),
    note: z.string().trim().min(1, "snapshot note must not be empty").max(2000),
  })
  .strict();

/** Decomposition authorship + review attestation (design §4.5). A confound, disclosed not hidden. */
const scaleDecompositionSchema = z
  .object({
    author: z.string().trim().min(1, "decomposition author must not be empty").max(200),
    reviewer: z.string().trim().min(1, "decomposition reviewer must not be empty").max(200),
    reviewedAt: z.string().trim().min(1).max(100).optional(),
    schedulerBandNote: z.string().trim().min(1).max(2000).optional(),
    /** Fraction of model context the SA union would consume (design §3.5); null when unmeasured. */
    contextFraction: z.number().min(0).max(1).nullable().default(null),
    contextFractionMethod: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();

export const ScaleWorkloadSpecSchema = z
  .object({
    id: scaleKey,
    name: z.string().trim().min(1, "name must not be empty").max(200),
    description: z.string().trim().min(1, "description must not be empty").max(5000),
    level: ScaleComplexityLevelSchema,
    stratum: ScaleStratumSchema,
    featureSpec: z.object({
      title: z.string().trim().min(1, "feature title must not be empty").max(300),
      description: z.string().trim().min(1, "feature description must not be empty").max(5000),
    }),
    features: z.array(scaleFeatureSpecSchema).min(1, "at least one feature is required").max(20),
    /** Base repository files committed before any strategy runs (after snapshot overlay, if any). */
    baseFiles: z.array(scaleFileSchema).max(500),
    /** Committed test suite; every strategy is verified against the same bar. */
    testFiles: z.array(scaleFileSchema).min(1, "at least one test file is required").max(500),
    /** Explicit test argv, e.g. ["node", "--test"]. Never invented per strategy. */
    testCommand: z.array(z.string().min(1)).min(1).max(50),
    /**
     * Donor regression command for Stratum B (design §6.3). Absent in
     * Stratum A, where the regression gate passes vacuously (recorded null).
     */
    regressionCommand: z.array(z.string().min(1)).min(1).max(50).optional(),
    snapshot: scaleSnapshotSchema.optional(),
    /** Commands run once per materialized fixture, before either arm (Amendment A.3). */
    setupCommands: z.array(z.array(z.string().min(1)).min(1).max(50)).max(10).default([]),
    /** Timeout for the entire setup phase in ms (Amendment A.3). */
    setupTimeoutMs: z.number().int().min(1000).max(3600000).default(SCALE_SETUP_TIMEOUT_MS),
    tasks: z.array(scaleTaskSpecSchema).min(2, "M18 workloads need at least two tasks").max(25),
    decomposition: scaleDecompositionSchema,
    expectedOutcome: z.string().trim().min(1, "expected outcome must not be empty").max(5000),
  })
  .strict()
  .superRefine((workload, ctx) => {
    const taskKeys = new Set(workload.tasks.map((task) => task.key));
    if (taskKeys.size !== workload.tasks.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "duplicate task keys in workload" });
    }
    const featureKeys = new Set(workload.features.map((feature) => feature.key));
    if (featureKeys.size !== workload.features.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "duplicate feature keys in workload" });
    }
    for (const task of workload.tasks) {
      if (!featureKeys.has(task.featureKey)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `task ${task.key} references unknown feature ${task.featureKey}` });
      }
      for (const dep of task.dependsOn) {
        if (!taskKeys.has(dep)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `task ${task.key} depends on unknown task ${dep}` });
        }
        if (dep === task.key) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `task ${task.key} cannot depend on itself` });
        }
      }
    }
    const basePaths = new Set([...workload.baseFiles, ...workload.testFiles].map((file) => file.path));
    if (basePaths.size !== workload.baseFiles.length + workload.testFiles.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "duplicate base/test file paths in workload" });
    }
    if (workload.stratum === "REAL_DERIVED" && workload.snapshot === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "REAL_DERIVED workloads must declare a snapshot overlay" });
    }
  });

export type ScaleWorkloadSpec = z.infer<typeof ScaleWorkloadSpecSchema>;
export type ScaleWorkloadTaskSpec = z.infer<typeof scaleTaskSpecSchema>;

// ---------- Contribution survival (design §7) ----------

export const ScaleSurvivalStatusSchema = z.enum([
  "SURVIVED",
  "OVERWRITTEN",
  "REVERTED",
  "NEVER_MERGED",
  "SURVIVED_WITH_REIMPLEMENTATION",
]);

export type ScaleSurvivalStatus = z.infer<typeof ScaleSurvivalStatusSchema>;

export const ScaleTaskSurvivalSchema = z
  .object({
    key: z.string(),
    status: ScaleSurvivalStatusSchema,
    probePassed: z.boolean(),
    diffNonEmpty: z.boolean(),
    attributed: z.boolean(),
    detail: z.string().max(2000),
    /** True when ALL probes for this task already pass on the pristine baseline. */
    baselinePassed: z.boolean().optional().default(false),
  })
  .strict();

export type ScaleTaskSurvival = z.infer<typeof ScaleTaskSurvivalSchema>;

// ---------- Run results ----------

const scaleTaskRecordSchema = z.object({
  key: z.string(),
  taskId: z.string(),
  workerId: z.string(),
    status: z.enum(["COMPLETED", "COMPLETED_EMPTY", "FAILED", "CLAIM_VIOLATION", "INVALID_WORKSPACE", "NOT_AUTHORIZED", "BASE_COMMIT_MISMATCH"]),
    workerMs: z.number().nullable(),
  verification: z.enum(["VERIFIED", "REJECTED", "NOT_EVALUATED"]),
  testStatus: z.enum(["PASSED", "FAILED", "CANCELLED", "NOT_RUN"]),
  /**
   * Provider/runtime error text when the task failed (truncated). Recorded so
   * provider-caused failures (rate limits, timeouts) stay distinguishable
   * from worker-caused failures without re-running anything.
   */
  error: z.string().max(2000).nullable().default(null),
  /**
   * Structured command failure kind (M19.2), set when the failure came from
   * the spawn boundary itself. Lets classification use producer-known
   * evidence instead of inferring from stderr text. Null for all other
   * failure sources and for records predating the field.
   */
  errorCode: z.string().max(50).nullable().default(null),
});

const scaleSchedulingRecordSchema = z.object({
  waves: z.array(z.array(z.string())),
  conflicts: z.array(z.tuple([z.string(), z.string()])),
  blocked: z.array(z.object({ key: z.string(), reason: z.string() })),
});

const scaleIntegrationRecordSchema = z.object({
  status: z.enum(["COMPLETED", "HALTED", "SKIPPED"]),
  conflicts: z.array(z.string()),
  items: z.array(
    z.object({
      key: z.string(),
      status: z.enum(["INTEGRATED", "CONFLICT", "TESTS_FAILED", "VERIFICATION_FAILED", "MERGE_FAILED", "SKIPPED_EMPTY", "NOT_ATTEMPTED"]),
      /** Merge halt/contribution reason (M19.3); absent when unrecorded. */
      reason: z.string().max(5000).nullable().optional(),
      /** Resulting merge commit for INTEGRATED items (M19.3). */
      mergeCommit: z.string().max(200).nullable().optional(),
      /** Cited cumulative test run (M19.3). */
      testRunId: z.string().max(200).nullable().optional(),
      /** Per-item processing time ms (M19.1 continuity, M19.3 propagation). */
      durationMs: z.number().int().min(0).nullable().optional(),
      /** Git-confirmed unmerged paths for CONFLICT items (M19.3). */
      conflictFiles: z.array(z.string().max(1000)).max(100).nullable().optional(),
      /** True for staged-empty halts; drives EMPTY_MERGE visibility (M19.3). */
      emptyMerge: z.boolean().nullable().optional(),
      /** Git exit code for git-command MERGE_FAILED items (M19.3). */
      gitExitCode: z.number().int().nullable().optional(),
      /** Bounded git stderr for git-command MERGE_FAILED items (M19.3). */
      gitStderr: z.string().max(2000).nullable().optional(),
      /** Worker branch HEAD at merge time (M19.3). */
      sourceCommit: z.string().max(200).nullable().optional(),
    }),
  ),
  order: z.array(z.string()),
});

const scaleAgentProvenanceSchema = z
  .object({
    provider: z.string(),
    executable: z.string(),
    model: z.string().nullable(),
    version: z.string().nullable(),
    temperature: z.number().nullable(),
  })
  .strict();

const scaleUsageRecordSchema = z
  .object({
    // Same M8/M11 boundary as M17: provider stdout is dropped, so usage stays
    // unknown unless the harness ever observes it. Never estimated.
    tokens: z.number().int().min(0).nullable(),
    costUsd: z.number().min(0).nullable(),
  })
  .strict();

const scaleSuccessPredicatesSchema = z
  .object({
    /** §6.1: every intended task completed, tested, verified. */
    workerCompletion: z.boolean(),
    /** §6.2: feature test command passes at the final train head. */
    featureCorrectness: z.boolean(),
    /** §6.3: donor regression passes at the train head (vacuously true when absent). */
    regression: z.boolean(),
    /** §6.4: every intended contribution survives (SURVIVED or REIMPLEMENTATION). */
    survival: z.boolean(),
    /** §6.5: harness counter, always 0 in-harness (field exists for protocol logging). */
    noIntervention: z.boolean(),
  })
  .strict();

export const ScaleRunResultSchema = z
  .object({
    workloadId: z.string(),
    level: ScaleComplexityLevelSchema,
    runId: z.string(),
    repeatIndex: z.number().int().min(0),
    strategy: BenchmarkStrategySchema,
    startedAt: z.string(),
    finishedAt: z.string(),
    wallClockMs: z.number(),
    baseCommit: z.string(),
    /** Train-head commit the survival probes ran against; null when no train exists. */
    trainHead: z.string().nullable(),
    /** Worker timeout actually applied (level constant per design §5.4). */
    workerTimeoutMs: z.number().int().min(0),
    agent: scaleAgentProvenanceSchema,
    decomposition: z.literal("human-authored"),
    tasks: z.array(scaleTaskRecordSchema),
    scheduling: scaleSchedulingRecordSchema.nullable(),
    integration: scaleIntegrationRecordSchema.nullable(),
    triageClassifications: z.array(z.string()),
    waveBases: z.array(commitShaSchema).nullable().optional(),
    survival: z.array(ScaleTaskSurvivalSchema),
    /** SURVIVED(+REIMPLEMENTATION) / intended tasks; null only when no tasks were intended. */
    survivalRate: z.number().min(0).max(1).nullable(),
    featureTestsPassed: z.boolean().nullable(),
    /** Null when the workload declares no regression command (advisory in Stratum A). */
    regressionPassed: z.boolean().nullable(),
    /** Counters-only instrumentation: harness performs zero interventions; kept for protocol. */
    humanInterventions: z.number().int().min(0),
    failureClassification: z
      .enum(["NONE", "PROVIDER_FAILURE", "WORKER_FAILURE", "VERIFICATION_FAILURE", "INTEGRATION_FAILURE", "SETUP_FAILURE", "UNKNOWN"])
      .default("NONE"),
    metrics: z.object({
      peakConcurrency: z.number().int().min(0),
      waves: z.number().int().min(0),
      taskCount: z.number().int().min(0),
      workerCount: z.number().int().min(0),
      failures: z.number().int().min(0),
      violations: z.number().int().min(0),
      rework: z.number().int().min(0),
      codeStats: z.object({
        filesTouched: z.number().int().min(0),
        linesAdded: z.number().int().min(0),
        linesRemoved: z.number().int().min(0),
      }),
      workerMsTotal: z.number().nullable(),
    }),
    usage: scaleUsageRecordSchema,
    /** Context measurement (Amendment A.2): descriptive/exploratory, never an admission gate. */
    context: z
      .object({
        estimatorVersion: z.literal(1),
        modelCapacityTokens: z.number().int().min(0),
        repoTokens: z.number().int().min(0),
        taskRelevantTokens: z.number().int().min(0),
        promptTokensMax: z.number().int().min(0),
        promptTokensMean: z.number().min(0),
        utilizationMax: z.number().min(0),
      })
      .strict(),
    evidence: z.object({
      artifactIds: z.array(z.string()),
      testRunIds: z.array(z.string()),
      commitShas: z.array(z.string()),
      trainBranch: z.string().nullable(),
      featureTestRunId: z.string().nullable(),
      regressionTestRunId: z.string().nullable(),
    }),
    successPredicates: scaleSuccessPredicatesSchema,
    /** SUCCESS iff every §6 sub-predicate holds. */
    success: z.boolean(),
  })
  .strict()
  .superRefine((run, ctx) => {
    const expected =
      run.successPredicates.workerCompletion &&
      run.successPredicates.featureCorrectness &&
      run.successPredicates.regression &&
      run.successPredicates.survival &&
      run.successPredicates.noIntervention;
    if (run.success !== expected) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "success must equal the conjunction of successPredicates" });
    }
  });

export type ScaleRunResult = z.infer<typeof ScaleRunResultSchema>;

// ---------- Comparison + persisted experiment state ----------

export const ScaleStrategySummarySchema = z
  .object({
    strategy: BenchmarkStrategySchema,
    totalRuns: z.number().int().min(0),
    successfulRuns: z.number().int().min(0),
    successRate: z.number(),
    medianSuccessfulWallClockMs: z.number().nullable(),
    /** Mean survivalRate over runs that reached survival evaluation; null when none did. */
    meanSurvivalRate: z.number().nullable(),
    runIds: z.array(z.string()),
  })
  .strict();

export type ScaleStrategySummary = z.infer<typeof ScaleStrategySummarySchema>;

export const ScaleComparisonSchema = z
  .object({
    workloadId: z.string(),
    level: ScaleComplexityLevelSchema,
    minSuccessfulRuns: z.number().int().min(1),
    summaries: z.array(ScaleStrategySummarySchema).min(1),
    runs: z.array(ScaleRunResultSchema),
  })
  .strict();

export type ScaleComparison = z.infer<typeof ScaleComparisonSchema>;

/** Per-run resumable experiment state (design §10.2). One entry per workload. */
export const ScaleExperimentStateSchema = z
  .object({
    version: z.literal(1),
    updatedAt: z.string(),
    workloads: z.record(z.string(), ScaleComparisonSchema),
    meta: z
      .object({
        head: z.string().optional(),
        date: z.string().optional(),
        note: z.string().max(2000).optional(),
        setupEvidence: ScaleSetupEvidenceSchema.nullable().default(null),
      })
      .default({}),
  })
  .strict();

export type ScaleExperimentState = z.infer<typeof ScaleExperimentStateSchema>;
