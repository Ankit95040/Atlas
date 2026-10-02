import type { IslandScene } from "./scene.js";

// Pure visual-transition derivation for the live 3D island (M25.2).
//
// Compares two scene descriptors (previous browser snapshot vs current
// Atlas state) and returns a deterministic transition list. Browser-only
// presentation state in, transition intents out — no DOM, no WebGL, no
// Atlas writes, fully unit-testable. Null previous means first render:
// never animate, show final state immediately.

export type VisualTransitionKind =
  | "WORKER_ENTER"
  | "TASK_STATE_CHANGE"
  | "VERIFICATION_CHANGE"
  | "MERGE_CAR_ENTER"
  | "HALT_CHANGE";

export interface VisualTransition {
  readonly kind: VisualTransitionKind;
  readonly entityId: string;
  readonly from: string;
  readonly to: string;
  readonly priority: number;
}

const PRIORITY: Record<VisualTransitionKind, number> = {
  WORKER_ENTER: 0,
  TASK_STATE_CHANGE: 1,
  VERIFICATION_CHANGE: 2,
  MERGE_CAR_ENTER: 3,
  HALT_CHANGE: 4,
};

export const TRANSITION_MS: Record<VisualTransitionKind, number> = {
  WORKER_ENTER: 300,
  TASK_STATE_CHANGE: 200,
  VERIFICATION_CHANGE: 260,
  MERGE_CAR_ENTER: 400,
  HALT_CHANGE: 600,
};

export function diffIslandScenes(prev: IslandScene | null, next: IslandScene): VisualTransition[] {
  if (prev === null) {
    return [];
  }
  const list: VisualTransition[] = [];
  const prevBuildings = new Map(prev.buildings.map((b) => [b.taskId, b] as const));
  for (const building of next.buildings) {
    const before = prevBuildings.get(building.taskId);
    if (before === undefined) {
      // Brand-new task row: a subtle entry under the task-state budget.
      list.push({ kind: "TASK_STATE_CHANGE", entityId: building.taskId, from: "absent", to: building.status, priority: PRIORITY.TASK_STATE_CHANGE });
    } else if (before.status !== building.status) {
      list.push({ kind: "TASK_STATE_CHANGE", entityId: building.taskId, from: before.status, to: building.status, priority: PRIORITY.TASK_STATE_CHANGE });
    }
    const beforeWorker = before?.worker?.id ?? null;
    const afterWorker = building.worker?.id ?? null;
    if (afterWorker !== null && beforeWorker !== afterWorker) {
      list.push({ kind: "WORKER_ENTER", entityId: afterWorker, from: "absent", to: building.worker?.status ?? "?", priority: PRIORITY.WORKER_ENTER });
    }
    const beforeVerdict = before?.verdict ?? null;
    if (building.verdict !== null && beforeVerdict !== building.verdict) {
      list.push({ kind: "VERIFICATION_CHANGE", entityId: building.taskId, from: beforeVerdict ?? "unevaluated", to: building.verdict, priority: PRIORITY.VERIFICATION_CHANGE });
    }
  }
  const prevShas = new Set(prev.cars.map((c) => c.sha));
  for (const car of next.cars) {
    if (!prevShas.has(car.sha)) {
      list.push({ kind: "MERGE_CAR_ENTER", entityId: car.sha, from: "railyard-entry", to: car.taskId, priority: PRIORITY.MERGE_CAR_ENTER });
    }
  }
  if (next.halt !== null && prev.halt === null) {
    list.push({ kind: "HALT_CHANGE", entityId: "halt", from: "running", to: next.halt.reason, priority: PRIORITY.HALT_CHANGE });
  }
  list.sort((a, b) => a.priority - b.priority || (a.entityId < b.entityId ? -1 : 1));
  return list;
}
