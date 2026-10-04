import { z } from "zod";

// Narrow read-only JSON API contract for the React frontend (M26 PoC,
// M27.1 workspace + global lenses).
//
// Shapes are derived from the existing data.ts loaders; this module only
// declares the wire format (Zod schemas) so the server can validate on emit
// and the frontend can validate on receive. No orchestration, no mutations.

export const ApiRunSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  totalTasks: z.number().int().nonnegative(),
  workerCount: z.number().int().nonnegative(),
  verifiedCount: z.number().int().nonnegative(),
  mergeCount: z.number().int().nonnegative(),
});

export type ApiRunSummary = z.infer<typeof ApiRunSummarySchema>;

export const ApiHomeSchema = z.object({
  metrics: z.object({
    projects: z.number().int().nonnegative(),
    runs: z.number().int().nonnegative(),
    tasks: z.number().int().nonnegative(),
    liveWorkers: z.number().int().nonnegative(),
    verified: z.number().int().nonnegative(),
    merges: z.number().int().nonnegative(),
  }),
  activeRuns: z.array(ApiRunSummarySchema),
  recentRuns: z.array(ApiRunSummarySchema),
});

export type ApiHome = z.infer<typeof ApiHomeSchema>;

// IslandScene is already plain JSON (src/ui/island3d/scene.ts); the API
// re-exports its shape by validation at the route boundary.
export const ApiOkSchema = z.object({ ok: z.literal(true) });

const ApiTaskWorkerSchema = z.object({
  id: z.string(),
  status: z.string(),
  link: z.union([z.literal("live"), z.literal("historical")]),
});

export const ApiTaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  dependsOn: z.array(z.string()),
  requiredBy: z.array(z.string()),
  claims: z.array(z.object({ resourceId: z.string(), access: z.string() })),
  worker: ApiTaskWorkerSchema.nullable(),
  testRuns: z.array(z.object({ status: z.string(), exitCode: z.number().int().nullable() })),
  verdict: z.string().nullable(),
  reasons: z.array(z.string()),
});

export type ApiTask = z.infer<typeof ApiTaskSchema>;

export const ApiWorkerSchema = z.object({
  id: z.string(),
  status: z.string(),
  taskId: z.string().nullable(),
  link: z.string(),
  taskTitle: z.string().nullable(),
  taskStatus: z.string().nullable(),
  branch: z.string().nullable(),
  workspacePath: z.string().nullable(),
  testRuns: z.number().int().nonnegative(),
  failures: z.number().int().nonnegative(),
});

export type ApiWorker = z.infer<typeof ApiWorkerSchema>;

export const ApiGlobalWorkerSchema = z.object({
  id: z.string(),
  status: z.string(),
  taskId: z.string().nullable(),
  link: z.string(),
  taskTitle: z.string().nullable(),
  featureId: z.string().nullable(),
  featureTitle: z.string().nullable(),
});

export type ApiGlobalWorker = z.infer<typeof ApiGlobalWorkerSchema>;

export const ApiVerificationSchema = z.object({
  findings: z.array(
    z.object({
      taskId: z.string(),
      title: z.string(),
      status: z.string(),
      phase: z.string(),
      assessment: z.string(),
      verdict: z.string().nullable(),
      reasons: z.array(z.string()),
      testRuns: z.array(z.object({ status: z.string(), exitCode: z.number().int().nullable() })),
      errorCode: z.string().optional(),
    }),
  ),
  completed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});

export type ApiVerification = z.infer<typeof ApiVerificationSchema>;

export const ApiTrainSchema = z.object({
  branches: z.array(
    z.object({
      branch: z.string(),
      status: z.string().nullable(),
      haltReason: z.string().nullable(),
      items: z.array(
        z.object({
          taskId: z.string(),
          title: z.string(),
          sha: z.string(),
          subject: z.string(),
          verdict: z.string().nullable(),
          createdAt: z.string().nullable(),
        }),
      ),
    }),
  ),
});

export type ApiTrain = z.infer<typeof ApiTrainSchema>;

export const ApiEventSchema = z.object({
  type: z.string(),
  taskId: z.string().nullable(),
  actor: z.string().nullable(),
  createdAt: z.string().nullable(),
  summary: z.string().nullable(),
});

export type ApiEvent = z.infer<typeof ApiEventSchema>;

export const ApiActivitySchema = z.array(
  z.object({
    type: z.string(),
    taskId: z.string().nullable(),
    taskTitle: z.string().nullable(),
    featureId: z.string().nullable(),
    featureTitle: z.string().nullable(),
    actor: z.string().nullable(),
    createdAt: z.string().nullable(),
  }),
);

export type ApiActivity = z.infer<typeof ApiActivitySchema>;

export const ApiProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  runCount: z.number().int().nonnegative(),
});

export type ApiProject = z.infer<typeof ApiProjectSchema>;

export const ApiWorkspaceSchema = z.object({
  summary: z.object({
    id: z.string(),
    title: z.string(),
    status: z.string(),
    projectName: z.string(),
    branch: z.string().nullable(),
    totalTasks: z.number().int().nonnegative(),
    activeTasks: z.number().int().nonnegative(),
    failedTasks: z.number().int().nonnegative(),
    workerCount: z.number().int().nonnegative(),
    verifiedCount: z.number().int().nonnegative(),
    mergeCount: z.number().int().nonnegative(),
    haltReason: z.string().nullable(),
  }),
  tasks: z.array(ApiTaskSchema),
  workers: z.array(ApiWorkerSchema),
  verification: ApiVerificationSchema,
  train: ApiTrainSchema,
  events: z.array(ApiEventSchema),
});

export type ApiWorkspace = z.infer<typeof ApiWorkspaceSchema>;
