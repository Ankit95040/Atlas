import { z } from "zod";
import { BenchmarkStrategySchema } from "../types.js";

// ---------- Real agent configuration (provider-agnostic) ----------

export const RealAgentConfigSchema = z
  .object({
    /** Human label for the agent under test, e.g. "fixture-cli". Recorded as provenance. */
    provider: z.string().trim().min(1, "provider must not be empty").max(100),
    /** Executable invoked via CommandWorkerProvider (argv-only, never a shell). */
    executable: z.string().min(1, "executable must not be empty").max(1000),
    /** Base argv placed before the rendered task prompt. Same for every strategy. */
    argv: z.array(z.string().min(1)).max(40).default([]),
    /** Optional flag inserted before the prompt element, e.g. "--prompt". */
    promptFlag: z.string().min(1).max(50).optional(),
    timeoutMs: z.number().int().min(1000).max(3600000).default(120000),
    envAllowlist: z.array(z.string().min(1)).max(100).default([]),
    /** Recorded provenance where the provider exposes it; unknown/null otherwise. */
    model: z.string().max(200).nullable().default(null),
    version: z.string().max(200).nullable().default(null),
    temperature: z.number().nullable().default(null),
  })
  .strict();

export type RealAgentConfig = z.infer<typeof RealAgentConfigSchema>;

// ---------- Human-authored workloads (controlled decomposition) ----------

export const RealWorkloadKindSchema = z.enum([
  "REALISTIC_INDEPENDENT",
  "REALISTIC_SHARED_RESOURCE",
  "REALISTIC_DEPENDENCY_CHAIN",
  "REALISTIC_MIXED",
  "REALISTIC_FALSE_PARALLELISM",
  "REALISTIC_INTEGRATION_CONFLICT",
]);

export type RealWorkloadKind = z.infer<typeof RealWorkloadKindSchema>;

const workloadKey = z
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

const workloadFileSchema = z
  .object({
    path: z.string().trim().min(1, "file path must not be empty").max(1000),
    content: z.string().max(100000, "file content is too long"),
  })
  .refine((file) => safeRelativePath(file.path), {
    message: "file path must be repository-relative without traversal",
  });

const workloadClaimSchema = z.object({
  resource: z.string().trim().min(1, "claim resource must not be empty").max(1000),
  access: z.enum(["READ", "WRITE"]),
});

const workloadTaskSpecSchema = z.object({
  key: workloadKey,
  title: z.string().trim().min(1, "task title must not be empty").max(300),
  /** Human-authored brief the shared prompt renderer turns into agent instructions. */
  description: z.string().trim().min(1, "task description must not be empty").max(5000),
  featureKey: z.string().trim().min(1, "featureKey must not be empty").max(100),
  claims: z.array(workloadClaimSchema).min(1, "each task must declare at least one claim"),
  dependsOn: z.array(workloadKey).default([]),
});

const workloadFeatureSpecSchema = z.object({
  key: z.string().trim().min(1, "featureKey must not be empty").max(100),
  title: z.string().trim().min(1, "feature title must not be empty").max(300),
});

export const RealWorkloadSpecSchema = z
  .object({
    id: workloadKey,
    name: z.string().trim().min(1, "name must not be empty").max(200),
    description: z.string().trim().min(1, "description must not be empty").max(5000),
    kind: RealWorkloadKindSchema,
    featureSpec: z.object({
      title: z.string().trim().min(1, "feature title must not be empty").max(300),
      description: z.string().trim().min(1, "feature description must not be empty").max(5000),
    }),
    features: z.array(workloadFeatureSpecSchema).min(1, "at least one feature is required").max(20),
    /** Base repository files committed before any strategy runs. */
    baseFiles: z.array(workloadFileSchema).max(200),
    /** Committed test suite; every strategy is verified against the same bar. */
    testFiles: z.array(workloadFileSchema).min(1, "at least one test file is required").max(200),
    /** Explicit test argv, e.g. ["node", "--test"]. Never invented per strategy. */
    testCommand: z.array(z.string().min(1)).min(1).max(50),
    tasks: z.array(workloadTaskSpecSchema).min(1, "at least one task is required").max(100),
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
  });

export type RealWorkloadSpec = z.infer<typeof RealWorkloadSpecSchema>;
export type RealWorkloadTaskSpec = z.infer<typeof workloadTaskSpecSchema>;

// ---------- Run results (observed first, derived never invented) ----------

const realTaskRecordSchema = z.object({
  key: z.string(),
  taskId: z.string(),
  workerId: z.string(),
  status: z.enum(["COMPLETED", "FAILED", "CLAIM_VIOLATION", "INVALID_WORKSPACE", "NOT_AUTHORIZED", "BASE_COMMIT_MISMATCH"]),
  /** Null for arms whose loop does not expose per-task timing (ATLAS). Never estimated. */
  workerMs: z.number().nullable(),
  verification: z.enum(["VERIFIED", "REJECTED", "NOT_EVALUATED"]),
  testStatus: z.enum(["PASSED", "FAILED", "CANCELLED", "NOT_RUN"]),
});

const realSchedulingRecordSchema = z.object({
  waves: z.array(z.array(z.string())),
  conflicts: z.array(z.tuple([z.string(), z.string()])),
  blocked: z.array(z.object({ key: z.string(), reason: z.string() })),
});

const realIntegrationRecordSchema = z.object({
  status: z.enum(["COMPLETED", "HALTED", "SKIPPED"]),
  conflicts: z.array(z.string()),
  items: z.array(
    z.object({
      key: z.string(),
      status: z.enum(["INTEGRATED", "CONFLICT", "TESTS_FAILED", "VERIFICATION_FAILED", "MERGE_FAILED", "NOT_ATTEMPTED"]),
    }),
  ),
  order: z.array(z.string()),
});

const agentProvenanceSchema = z
  .object({
    provider: z.string(),
    executable: z.string(),
    model: z.string().nullable(),
    version: z.string().nullable(),
    temperature: z.number().nullable(),
  })
  .strict();

const usageRecordSchema = z
  .object({
    /**
     * Tokens/cost only when the agent CLI exposes them through a channel
     * Atlas can observe. The M8/M11 boundary drops provider stdout, so with
     * CommandWorkerProvider this is null: reported unknown, never estimated
     * from wall-clock time.
     */
    tokens: z.number().int().min(0).nullable(),
    costUsd: z.number().min(0).nullable(),
  })
  .strict();

export const RealRunResultSchema = z
  .object({
    workloadId: z.string(),
    runId: z.string(),
    repeatIndex: z.number().int().min(0),
    strategy: BenchmarkStrategySchema,
    startedAt: z.string(),
    finishedAt: z.string(),
    wallClockMs: z.number(),
    baseCommit: z.string(),
    agent: agentProvenanceSchema,
    /** Decomposition source, always controlled in M14: never planner-generated. */
    decomposition: z.literal("human-authored"),
    tasks: z.array(realTaskRecordSchema),
    scheduling: realSchedulingRecordSchema.nullable(),
    integration: realIntegrationRecordSchema.nullable(),
    /** M13 triage classifications observed on HALTED trains; empty otherwise. */
    triageClassifications: z.array(z.string()),
    metrics: z.object({
      peakConcurrency: z.number().int().min(0),
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
      /** Null when any task timing is unknown; never estimated from wall-clock. */
      workerMsTotal: z.number().nullable(),
    }),
    usage: usageRecordSchema,
    evidence: z.object({
      artifactIds: z.array(z.string()),
      testRunIds: z.array(z.string()),
      commitShas: z.array(z.string()),
      trainBranch: z.string().nullable(),
    }),
    /** SUCCESS iff every intended task completed, verified, and integrated. */
    success: z.boolean(),
  })
  .strict();

export type RealRunResult = z.infer<typeof RealRunResultSchema>;

// ---------- Comparison (individual runs kept; aggregates separate) ----------

export const RealStrategySummarySchema = z
  .object({
    strategy: BenchmarkStrategySchema,
    totalRuns: z.number().int().min(0),
    successfulRuns: z.number().int().min(0),
    successRate: z.number(),
    /** Median over successful runs only; null when below the minimum count. Never fabricated. */
    medianSuccessfulWallClockMs: z.number().nullable(),
    runIds: z.array(z.string()),
  })
  .strict();

export type RealStrategySummary = z.infer<typeof RealStrategySummarySchema>;

export const RealBenchmarkComparisonSchema = z
  .object({
    workloadId: z.string(),
    minSuccessfulRuns: z.number().int().min(1),
    summaries: z.array(RealStrategySummarySchema).min(1),
    runs: z.array(RealRunResultSchema),
  })
  .strict();

export type RealBenchmarkComparison = z.infer<typeof RealBenchmarkComparisonSchema>;
