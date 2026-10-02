import { z } from "zod";

// Narrow read-only JSON API contract for the React frontend (M26 PoC).
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
