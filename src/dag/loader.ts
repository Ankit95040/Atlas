import type { PrismaClient } from "@prisma/client";
import { getPrismaClient } from "../db/client.js";
import { NotFoundError } from "../core/errors.js";
import { readTaskClaims } from "../claims/service.js";
import type { DependencyEdge, SchedulerInput } from "./types.js";

export interface LoadSchedulerInputOptions {
  /** Seed tasks; direct and transitive prerequisites are pulled in automatically. */
  readonly taskIds: readonly string[];
  readonly workerIds: readonly string[];
  readonly maxConcurrency: number;
}

/**
 * Load orchestration state from Prisma into pure scheduler input.
 * Follows prerequisite edges transitively (cross-feature included) so every
 * referenced task is present with its status and claims; missing seeds fail
 * with NotFoundError. Malformed claim JSON fails deterministically via
 * readTaskClaims. No planning happens here — pass the result to planSchedule.
 */
export async function loadSchedulerInput(
  options: LoadSchedulerInputOptions,
  db: PrismaClient = getPrismaClient(),
): Promise<SchedulerInput> {
  const seen = new Set<string>();
  const queue = [...options.taskIds];
  const edges: DependencyEdge[] = [];
  const tasks: SchedulerInput["tasks"] = [];

  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const task = await db.task.findUnique({ where: { id } });
    if (task === null) {
      throw new NotFoundError("Task", id);
    }
    tasks.push({ id: task.id, status: task.status, claims: readTaskClaims(task.resourceClaims) });
    const rows = await db.taskDependency.findMany({ where: { taskId: id } });
    for (const row of rows) {
      edges.push({ taskId: row.taskId, dependsOnTaskId: row.dependsOnTaskId });
      if (!seen.has(row.dependsOnTaskId)) {
        queue.push(row.dependsOnTaskId);
      }
    }
  }

  const workers: SchedulerInput["workers"] = [];
  if (options.workerIds.length > 0) {
    const rows = await db.worker.findMany({ where: { id: { in: [...options.workerIds] } } });
    const found = new Set(rows.map((row) => row.id));
    const missing = [...options.workerIds].filter((id) => !found.has(id)).sort();
    if (missing.length > 0 && missing[0] !== undefined) {
      throw new NotFoundError("Worker", missing[0]);
    }
    for (const row of rows) {
      workers.push({ id: row.id, status: row.status });
    }
  }

  return { tasks, dependencies: edges, workers, maxConcurrency: options.maxConcurrency };
}
