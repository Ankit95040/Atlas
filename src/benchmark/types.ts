import { z } from "zod";

export const BenchmarkStrategySchema = z.enum(["SINGLE_AGENT", "DUMB_PARALLEL", "ATLAS", "ATLAS_EVOLVING"]);
export type BenchmarkStrategy = z.infer<typeof BenchmarkStrategySchema>;

export const ScenarioKindSchema = z.enum([
  "INDEPENDENT_TASKS",
  "SHARED_RESOURCE",
  "DEPENDENCY_CHAIN",
  "MIXED",
  "CROSS_FEATURE_DEPENDENCY",
  "FALSE_PARALLELISM",
]);
export type ScenarioKind = z.infer<typeof ScenarioKindSchema>;

const scenarioKey = z
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

const scenarioFileSchema = z
  .object({
    path: z.string().trim().min(1, "file path must not be empty").max(1000),
    content: z.string().max(100000, "file content is too long"),
  })
  .refine((file) => safeRelativePath(file.path), {
    message: "file path must be repository-relative without traversal",
  });

const scenarioClaimSchema = z.object({
  resource: z.string().trim().min(1, "claim resource must not be empty").max(1000),
  access: z.enum(["READ", "WRITE"]),
});

const scenarioTaskSpecSchema = z.object({
  key: scenarioKey,
  title: z.string().trim().min(1, "task title must not be empty").max(300),
  featureKey: z.string().trim().min(1, "featureKey must not be empty").max(100),
  files: z.array(scenarioFileSchema).min(1, "each task must declare at least one file"),
  claims: z.array(scenarioClaimSchema).min(1, "each task must declare at least one claim"),
  dependsOn: z.array(scenarioKey).default([]),
  simulatedDurationMs: z.number().int().min(0).max(60000),
  simulatedCostUsd: z.number().min(0).max(1000000).optional(),
  /** Scope argument appended to `node check.mjs` for this task's own test run. */
  testScope: z.string().trim().min(1).max(200),
});

const scenarioFeatureSpecSchema = z.object({
  key: z.string().trim().min(1, "featureKey must not be empty").max(100),
  title: z.string().trim().min(1, "feature title must not be empty").max(300),
});

export const BenchmarkScenarioSchema = z
  .object({
    id: scenarioKey,
    name: z.string().trim().min(1, "name must not be empty").max(200),
    description: z.string().trim().min(1, "description must not be empty").max(5000),
    kind: ScenarioKindSchema,
    featureSpec: z.object({
      title: z.string().trim().min(1, "feature title must not be empty").max(300),
      description: z.string().trim().min(1, "feature description must not be empty").max(5000),
    }),
    features: z.array(scenarioFeatureSpecSchema).min(1, "at least one feature is required").max(20),
    files: z.array(scenarioFileSchema).max(200),
    /** Content of check.mjs; invoked as `node check.mjs [scope]`. */
    testScript: z.string().min(1, "test script must not be empty").max(50000),
    tasks: z.array(scenarioTaskSpecSchema).min(1, "at least one task is required").max(100),
    expectedOutcome: z.string().trim().min(1, "expected outcome must not be empty").max(5000),
  })
  .strict()
  .superRefine((scenario, ctx) => {
    const taskKeys = new Set(scenario.tasks.map((task) => task.key));
    if (taskKeys.size !== scenario.tasks.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "duplicate task keys in scenario" });
    }
    const featureKeys = new Set(scenario.features.map((feature) => feature.key));
    if (featureKeys.size !== scenario.features.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "duplicate feature keys in scenario" });
    }
    for (const task of scenario.tasks) {
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
    const basePaths = new Set(scenario.files.map((file) => file.path));
    if (basePaths.size !== scenario.files.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "duplicate base file paths in scenario" });
    }
  });

export type BenchmarkScenario = z.infer<typeof BenchmarkScenarioSchema>;
export type ScenarioTaskSpec = z.infer<typeof scenarioTaskSpecSchema>;

// ---------- Run results (constructed by the harness; validated on JSON round-trip) ----------

const workerExecutionStatusSchema = z.enum([
  "COMPLETED",
  "FAILED",
  "CLAIM_VIOLATION",
  "INVALID_WORKSPACE",
  "NOT_AUTHORIZED",
  "BASE_COMMIT_MISMATCH",
]);

const taskRunRecordSchema = z.object({
  key: z.string(),
  taskId: z.string(),
  workerId: z.string(),
  status: workerExecutionStatusSchema,
  workerMs: z.number(),
  verification: z.enum(["VERIFIED", "REJECTED", "NOT_EVALUATED"]),
  testStatus: z.enum(["PASSED", "FAILED", "CANCELLED", "NOT_RUN"]),
  undeclaredResources: z.array(z.string()),
});

const schedulingRecordSchema = z.object({
  waves: z.array(z.array(z.string())),
  conflicts: z.array(z.tuple([z.string(), z.string()])),
  blocked: z.array(z.object({ key: z.string(), reason: z.string() })),
});

const integrationRecordSchema = z.object({
  status: z.enum(["COMPLETED", "HALTED", "SKIPPED"]),
  mergeCommits: z.array(z.string()),
  conflicts: z.array(z.string()),
  items: z.array(
    z.object({
      key: z.string(),
      status: z.enum(["INTEGRATED", "CONFLICT", "TESTS_FAILED", "VERIFICATION_FAILED", "MERGE_FAILED", "NOT_ATTEMPTED"]),
    }),
  ),
  /** Effective merge-train processing order: keys in sequence-used order (stable, deterministic). */
  order: z.array(z.string()),
});

const codeStatsSchema = z.object({
  filesTouched: z.number().int().min(0),
  linesAdded: z.number().int().min(0),
  linesRemoved: z.number().int().min(0),
});

const strategyMetricsSchema = z.object({
  peakConcurrency: z.number().int().min(0),
  taskCount: z.number().int().min(0),
  workerCount: z.number().int().min(0),
  failures: z.number().int().min(0),
  violations: z.number().int().min(0),
  rework: z.number().int().min(0),
  codeStats: codeStatsSchema,
});

const evidenceRecordSchema = z.object({
  artifactIds: z.array(z.string()),
  testRunIds: z.array(z.string()),
  commitShas: z.array(z.string()),
  trainBranch: z.string().nullable(),
  /** Mirrors integration.order for evidence completeness; always sorted in run order, not commit SHA order. */
  integrationOrder: z.array(z.string()),
});

export const BenchmarkRunResultSchema = z
  .object({
    scenarioId: z.string(),
    runId: z.string(),
    strategy: BenchmarkStrategySchema,
    startedAt: z.string(),
    finishedAt: z.string(),
    wallClockMs: z.number(),
    baseCommit: z.string(),
    tasks: z.array(taskRunRecordSchema),
    scheduling: schedulingRecordSchema.nullable(),
    integration: integrationRecordSchema.nullable(),
    metrics: strategyMetricsSchema,
    evidence: evidenceRecordSchema,
    provenance: z.literal("fake-provider"),
  })
  .strict();

export type BenchmarkRunResult = z.infer<typeof BenchmarkRunResultSchema>;

// ---------- Comparison (pure derivation over run results) ----------

export const DerivedComparisonSchema = z
  .object({
    speedupVsSingle: z.number().nullable(),
    costDeltaVsSingle: z.number().nullable(),
    failureRate: z.number(),
    conflictRate: z.number(),
    reworkRate: z.number(),
  })
  .strict();

export type DerivedComparison = z.infer<typeof DerivedComparisonSchema>;

export const AssessmentCodeSchema = z.enum([
  "ATLAS_SERIALIZED",
  "SINGLE_AGENT_FASTER",
  "SLOWER_DESPITE_PARALLEL",
  "COSTLIER_WITHOUT_GAIN",
  "DUMB_CONFLICTED",
  "ALL_INTEGRATED",
]);
export type AssessmentCode = z.infer<typeof AssessmentCodeSchema>;

export const AssessmentFindingSchema = z
  .object({ code: AssessmentCodeSchema, detail: z.string() })
  .strict();
export type AssessmentFinding = z.infer<typeof AssessmentFindingSchema>;

export const BenchmarkComparisonSchema = z
  .object({
    scenarioId: z.string(),
    runs: z.object({
      SINGLE_AGENT: BenchmarkRunResultSchema.optional(),
      DUMB_PARALLEL: BenchmarkRunResultSchema.optional(),
      ATLAS: BenchmarkRunResultSchema.optional(),
    }),
    derived: DerivedComparisonSchema,
    assessment: z.array(AssessmentFindingSchema),
  })
  .strict();

export type BenchmarkComparison = z.infer<typeof BenchmarkComparisonSchema>;
