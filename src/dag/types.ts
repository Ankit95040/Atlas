import { z } from "zod";
import { TaskStatus, WorkerStatus } from "@prisma/client";
import { idSchema } from "../core/inputs.js";
import type { ConflictDetail, NormalizedClaim } from "../claims/types.js";

// ---------- Reason codes (machine-readable, stable) ----------

export type ScheduleReason =
  | "PARALLEL_ELIGIBLE"
  | "BLOCKED_BY_DEPENDENCY"
  | "TASK_NOT_READY"
  | "SERIALIZED_RESOURCE_CONFLICT"
  | "WORKER_UNAVAILABLE";

// ---------- Scheduler input (pure data; Zod-validated at the boundary) ----------

const claimSchema = z.object({
  resourceId: z.string().min(1),
  kind: z.enum(["FILE", "DIRECTORY"]),
  access: z.enum(["READ", "WRITE"]),
});

const taskSchema = z.object({
  id: idSchema,
  status: z.nativeEnum(TaskStatus),
  claims: z.array(claimSchema).default([]),
});

const workerSchema = z.object({
  id: idSchema,
  status: z.nativeEnum(WorkerStatus),
});

function uniqueIds(items: readonly { id: string }[]): boolean {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) {
      return false;
    }
    seen.add(item.id);
  }
  return true;
}

export const SchedulerInputSchema = z.object({
  tasks: z.array(taskSchema).refine(uniqueIds, { message: "duplicate task ids in scheduler input" }),
  dependencies: z
    .array(z.object({ taskId: idSchema, dependsOnTaskId: idSchema }))
    .default([])
    .refine(
      (edges) => edges.every((edge) => edge.taskId !== edge.dependsOnTaskId),
      { message: "a task cannot depend on itself" },
    ),
  workers: z
    .array(workerSchema)
    .default([])
    .refine(uniqueIds, { message: "duplicate worker ids in scheduler input" }),
  maxConcurrency: z.number().int().min(1, "maxConcurrency must be >= 1"),
});

export type SchedulerInput = z.infer<typeof SchedulerInputSchema>;

export interface TaskNode {
  readonly id: string;
  readonly status: TaskStatus;
  readonly claims: readonly NormalizedClaim[];
}

export interface DependencyEdge {
  /** Task that waits. */
  readonly taskId: string;
  /** Prerequisite that must complete first. */
  readonly dependsOnTaskId: string;
}

export interface WorkerNode {
  readonly id: string;
  readonly status: WorkerStatus;
}

// ---------- Execution plan (machine-readable output) ----------

export interface ExecutionGroup {
  /** One wave: these tasks may run concurrently. Sorted by task id. */
  readonly tasks: string[];
  readonly reason: Extract<ScheduleReason, "PARALLEL_ELIGIBLE">;
}

export interface BlockedTaskEntry {
  readonly taskId: string;
  readonly reason: Exclude<ScheduleReason, "PARALLEL_ELIGIBLE" | "SERIALIZED_RESOURCE_CONFLICT">;
  /** Uncompleted prerequisite ids (sorted). Empty unless BLOCKED_BY_DEPENDENCY. */
  readonly blockedBy: string[];
  readonly detail?: string;
}

export interface ResourceConflictEntry {
  /** Sorted so taskA < taskB; one entry per conflicting pair. */
  readonly taskA: string;
  readonly taskB: string;
  readonly reason: Extract<ScheduleReason, "SERIALIZED_RESOURCE_CONFLICT">;
  readonly details: readonly ConflictDetail[];
}

export interface ExecutionPlan {
  /** Ordered waves; later waves run after earlier ones complete. */
  readonly groups: ExecutionGroup[];
  /** Sorted by taskId. */
  readonly blockedTasks: BlockedTaskEntry[];
  /** Sorted by (taskA, taskB); only pairs where both tasks are scheduled. */
  readonly resourceConflicts: ResourceConflictEntry[];
  /** Echo of the (deduplicated, sorted) dependency edges the plan used. */
  readonly dependencies: DependencyEdge[];
  /** Sorted ids of IDLE workers counted toward capacity. */
  readonly availableWorkers: string[];
  readonly capacity: number;
}
