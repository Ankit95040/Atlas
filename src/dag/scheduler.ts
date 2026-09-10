import { TaskStatus, WorkerStatus } from "@prisma/client";
import { compareClaimSets } from "../claims/conflicts.js";
import type { NormalizedClaim } from "../claims/types.js";
import { TaskGraph } from "./graph.js";
import {
  SchedulerInputSchema,
  type BlockedTaskEntry,
  type DependencyEdge,
  type ExecutionPlan,
} from "./types.js";

/**
 * Task states the scheduler considers startable. Anything else is either
 * already active (CLAIMED, IN_PROGRESS, BLOCKED, VERIFICATION), terminal
 * (COMPLETED, CANCELLED), or failed — FAILED is never silently reinterpreted
 * as runnable. Note this is intentionally broader than worker assignment
 * (which additionally requires READY): the scheduler answers
 * dependency-readiness, assignment answers dispatch-eligibility.
 */
const ELIGIBLE_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set([TaskStatus.PENDING, TaskStatus.READY]);

function sortedClaims(claims: readonly NormalizedClaim[]): NormalizedClaim[] {
  return [...claims].sort((a, b) => {
    if (a.resourceId !== b.resourceId) {
      return a.resourceId < b.resourceId ? -1 : 1;
    }
    return a.access < b.access ? -1 : 1;
  });
}

function compareEdge(a: DependencyEdge, b: DependencyEdge): number {
  if (a.taskId !== b.taskId) {
    return a.taskId < b.taskId ? -1 : 1;
  }
  if (a.dependsOnTaskId !== b.dependsOnTaskId) {
    return a.dependsOnTaskId < b.dependsOnTaskId ? -1 : 1;
  }
  return 0;
}

/**
 * Deterministic greedy scheduler (pure: no Prisma, no I/O).
 *
 * 1. Dependency-ready tasks = eligible state + every prerequisite COMPLETED.
 * 2. Candidates considered in sorted task-id order.
 * 3. First-fit packing into waves bounded by
 *    capacity = min(maxConcurrency, available workers).
 * 4. A task joins the first wave with room where none of its claims conflict
 *    (M5 engine) with tasks already in that wave.
 * 5. All conflicting pairs among scheduled tasks are reported so the reason
 *    for serialization is explicit — never as fake TaskDependency edges.
 *
 * Same input (tasks, edges, claims, workers, concurrency) always yields the
 * same plan. The plan says what *could* run; it assigns nothing.
 */
export function planSchedule(raw: unknown): ExecutionPlan {
  const input = SchedulerInputSchema.parse(raw);

  const graph = new TaskGraph();
  for (const task of input.tasks) {
    graph.addTask({ id: task.id, status: task.status, claims: task.claims });
  }
  const seenEdges = new Set<string>();
  const dependencies: DependencyEdge[] = [];
  for (const edge of input.dependencies) {
    const key = `${edge.taskId} -> ${edge.dependsOnTaskId}`;
    if (!seenEdges.has(key)) {
      seenEdges.add(key);
      graph.addDependency(edge.taskId, edge.dependsOnTaskId);
      dependencies.push({ taskId: edge.taskId, dependsOnTaskId: edge.dependsOnTaskId });
    }
  }
  dependencies.sort(compareEdge);
  graph.assertAcyclic();

  const claimsOf = new Map(input.tasks.map((task) => [task.id, sortedClaims(task.claims)] as const));
  const statusOf = new Map(input.tasks.map((task) => [task.id, task.status] as const));
  const sortedIds = graph.taskIds();

  const availableWorkers = input.workers
    .filter((worker) => worker.status === WorkerStatus.IDLE)
    .map((worker) => worker.id)
    .sort();
  const capacity = Math.min(input.maxConcurrency, availableWorkers.length);

  const readyIds: string[] = [];
  const blockedTasks: BlockedTaskEntry[] = [];
  for (const id of sortedIds) {
    const status = statusOf.get(id);
    if (status === undefined || !ELIGIBLE_TASK_STATUSES.has(status)) {
      blockedTasks.push({
        taskId: id,
        reason: "TASK_NOT_READY",
        blockedBy: [],
        detail: `status ${status} is not eligible to run`,
      });
      continue;
    }
    const uncompleted = graph
      .getDependencies(id)
      .filter((prereq) => statusOf.get(prereq) !== TaskStatus.COMPLETED);
    if (uncompleted.length > 0) {
      blockedTasks.push({ taskId: id, reason: "BLOCKED_BY_DEPENDENCY", blockedBy: uncompleted });
      continue;
    }
    if (capacity === 0) {
      blockedTasks.push({
        taskId: id,
        reason: "WORKER_UNAVAILABLE",
        blockedBy: [],
        detail: `no scheduling capacity (available workers: ${availableWorkers.length}, maxConcurrency: ${input.maxConcurrency})`,
      });
      continue;
    }
    readyIds.push(id);
  }

  const groups: { tasks: string[]; reason: "PARALLEL_ELIGIBLE" }[] = [];
  for (const id of readyIds) {
    const claims = claimsOf.get(id) ?? [];
    let placed = false;
    for (const group of groups) {
      if (group.tasks.length >= capacity) {
        continue;
      }
      const compatible = group.tasks.every(
        (other) => compareClaimSets(claims, claimsOf.get(other) ?? []).status === "NO_CONFLICT",
      );
      if (compatible) {
        group.tasks.push(id);
        placed = true;
        break;
      }
    }
    if (!placed) {
      groups.push({ tasks: [id], reason: "PARALLEL_ELIGIBLE" });
    }
  }

  const resourceConflicts: ExecutionPlan["resourceConflicts"] = [];
  for (let i = 0; i < readyIds.length; i += 1) {
    const taskA = readyIds[i];
    if (taskA === undefined) {
      continue;
    }
    for (let j = i + 1; j < readyIds.length; j += 1) {
      const taskB = readyIds[j];
      if (taskB === undefined) {
        continue;
      }
      const comparison = compareClaimSets(claimsOf.get(taskA) ?? [], claimsOf.get(taskB) ?? []);
      if (comparison.status === "CONFLICT") {
        resourceConflicts.push({
          taskA,
          taskB,
          reason: "SERIALIZED_RESOURCE_CONFLICT",
          details: comparison.conflicts,
        });
      }
    }
  }

  return { groups, blockedTasks, resourceConflicts, dependencies, availableWorkers, capacity };
}
