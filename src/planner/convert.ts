import { TaskStatus, type WorkerStatus } from "@prisma/client";
import type { SchedulerInput } from "../dag/types.js";
import type { ValidatedPlannerPlan } from "./types.js";

export interface SchedulerConversionOptions {
  /** Workers M6 may consider; only IDLE workers count toward capacity. */
  readonly workers: ReadonlyArray<{ readonly id: string; readonly status: WorkerStatus }>;
  readonly maxConcurrency: number;
}

/**
 * Convert a VALIDATED plan into M6 scheduler input. Accepts only
 * ValidatedPlannerPlan — a raw PlannerProposal cannot reach the scheduler,
 * which the compiler enforces. Proposed tasks enter as PENDING (the Atlas
 * lifecycle default for unstarted work); M6 remains the sole authority on
 * readiness, cycles, conflicts, capacity, and parallel-vs-serial decisions.
 */
export function toSchedulerInput(
  plan: ValidatedPlannerPlan,
  options: SchedulerConversionOptions,
): SchedulerInput {
  return {
    tasks: plan.tasks.map((task) => ({ id: task.id, status: TaskStatus.PENDING, claims: [...task.claims] })),
    dependencies: plan.dependencies.map((edge) => ({ taskId: edge.taskId, dependsOnTaskId: edge.dependsOnTaskId })),
    workers: options.workers.map((worker) => ({ id: worker.id, status: worker.status })),
    maxConcurrency: options.maxConcurrency,
  };
}
