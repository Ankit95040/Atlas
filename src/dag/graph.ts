import { InvariantViolationError, NotFoundError } from "../core/errors.js";
import { DependencyCycleError } from "./errors.js";
import type { DependencyEdge, TaskNode } from "./types.js";

function sortedCopy(values: Iterable<string>): string[] {
  return [...values].sort();
}

/**
 * Deterministic in-memory task dependency graph.
 *
 * Edge `addDependency(taskId, dependsOnTaskId)` means: taskId waits for
 * dependsOnTaskId ("B depends on A"). All traversals iterate explicitly
 * sorted id lists — never raw Map insertion order — so every query is
 * deterministic regardless of insertion order.
 */
export class TaskGraph {
  private readonly tasks = new Map<string, TaskNode>();
  private readonly prerequisites = new Map<string, Set<string>>();
  private readonly dependents = new Map<string, Set<string>>();

  get size(): number {
    return this.tasks.size;
  }

  hasTask(id: string): boolean {
    return this.tasks.has(id);
  }

  addTask(task: TaskNode): void {
    if (this.tasks.has(task.id)) {
      throw new InvariantViolationError(`duplicate task in graph: ${task.id}`);
    }
    this.tasks.set(task.id, task);
    this.prerequisites.set(task.id, new Set());
    this.dependents.set(task.id, new Set());
  }

  removeTask(id: string): void {
    if (!this.tasks.has(id)) {
      throw new NotFoundError("Task", id);
    }
    this.tasks.delete(id);
    this.prerequisites.delete(id);
    this.dependents.delete(id);
    for (const edges of this.prerequisites.values()) {
      edges.delete(id);
    }
    for (const edges of this.dependents.values()) {
      edges.delete(id);
    }
  }

  addDependency(taskId: string, dependsOnTaskId: string): void {
    if (taskId === dependsOnTaskId) {
      throw new InvariantViolationError(`task cannot depend on itself: ${taskId}`);
    }
    const prereqs = this.prerequisites.get(taskId);
    const dependents = this.dependents.get(dependsOnTaskId);
    if (prereqs === undefined) {
      throw new NotFoundError("Task", taskId);
    }
    if (dependents === undefined) {
      throw new NotFoundError("Task", dependsOnTaskId);
    }
    if (prereqs.has(dependsOnTaskId)) {
      throw new InvariantViolationError(`duplicate dependency edge: ${taskId} depends on ${dependsOnTaskId}`);
    }
    prereqs.add(dependsOnTaskId);
    dependents.add(taskId);
  }

  removeDependency(taskId: string, dependsOnTaskId: string): void {
    const prereqs = this.prerequisites.get(taskId);
    if (prereqs === undefined) {
      throw new NotFoundError("Task", taskId);
    }
    if (!prereqs.has(dependsOnTaskId)) {
      throw new NotFoundError("TaskDependency", `${taskId} depends on ${dependsOnTaskId}`);
    }
    prereqs.delete(dependsOnTaskId);
    this.dependents.get(dependsOnTaskId)?.delete(taskId);
  }

  /** Prerequisite ids of a task (what it waits for), sorted. */
  getDependencies(taskId: string): string[] {
    const prereqs = this.prerequisites.get(taskId);
    if (prereqs === undefined) {
      throw new NotFoundError("Task", taskId);
    }
    return sortedCopy(prereqs);
  }

  /** Dependent ids of a task (what waits for it), sorted. */
  getDependents(taskId: string): string[] {
    const dependents = this.dependents.get(taskId);
    if (dependents === undefined) {
      throw new NotFoundError("Task", taskId);
    }
    return sortedCopy(dependents);
  }

  /** All task ids, sorted. */
  taskIds(): string[] {
    return sortedCopy(this.tasks.keys());
  }

  edges(): DependencyEdge[] {
    const edges: DependencyEdge[] = [];
    for (const taskId of this.taskIds()) {
      for (const dependsOnTaskId of this.getDependencies(taskId)) {
        edges.push({ taskId, dependsOnTaskId });
      }
    }
    return edges;
  }

  hasCycle(): boolean {
    return this.findCycle() !== null;
  }

  assertAcyclic(): void {
    const cycle = this.findCycle();
    if (cycle !== null) {
      throw new DependencyCycleError(cycle);
    }
  }

  /**
   * Kahn's algorithm with sorted-id tie-breaking: among all runnable tasks,
   * the smallest id goes first. Throws DependencyCycleError on cycles.
   */
  topologicalOrder(): string[] {
    const remaining = new Map<string, number>();
    for (const id of this.taskIds()) {
      remaining.set(id, this.getDependencies(id).length);
    }
    let ready = this.taskIds().filter((id) => remaining.get(id) === 0);
    const order: string[] = [];
    while (ready.length > 0) {
      ready.sort();
      const id = ready.shift();
      if (id === undefined) {
        break;
      }
      order.push(id);
      for (const dependent of this.getDependents(id)) {
        const count = (remaining.get(dependent) ?? 1) - 1;
        remaining.set(dependent, count);
        if (count === 0) {
          ready.push(dependent);
        }
      }
    }
    if (order.length !== this.tasks.size) {
      // Leftover nodes with unsatisfied in-degree guarantee a cycle exists,
      // so findCycle below cannot return null; the fallback is type plumbing.
      throw new DependencyCycleError(this.findCycle() ?? order);
    }
    return order;
  }

  /**
   * Iterative depth-first search following depends-on edges, visiting nodes
   * and neighbors in sorted order. Returns one cycle path (closed loop,
   * e.g. ["b","c","d","b"]) or null when acyclic.
   */
  findCycle(): string[] | null {
    const WHITE = 0;
    const GRAY = 1;
    const BLACK = 2;
    const color = new Map<string, number>();
    for (const id of this.taskIds()) {
      color.set(id, WHITE);
    }
    for (const start of this.taskIds()) {
      if (color.get(start) !== WHITE) {
        continue;
      }
      const stack: Array<{ node: string; neighbors: string[]; index: number }> = [
        { node: start, neighbors: this.getDependencies(start), index: 0 },
      ];
      color.set(start, GRAY);
      const path: string[] = [start];
      while (stack.length > 0) {
        const frame = stack[stack.length - 1];
        if (frame === undefined) {
          break;
        }
        const next = frame.index < frame.neighbors.length ? frame.neighbors[frame.index] : undefined;
        frame.index += 1;
        if (next === undefined) {
          color.set(frame.node, BLACK);
          stack.pop();
          path.pop();
          continue;
        }
        const neighborColor = color.get(next);
        if (neighborColor === GRAY) {
          return [...path.slice(path.indexOf(next)), next];
        }
        if (neighborColor === WHITE) {
          color.set(next, GRAY);
          path.push(next);
          stack.push({ node: next, neighbors: this.getDependencies(next), index: 0 });
        }
      }
    }
    return null;
  }
}
