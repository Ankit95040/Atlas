// Execution routing classifier, SHADOW MODE ONLY (M29.2).
//
// Decides, from observable planned structure alone, whether a feature run
// would be served by single-agent execution or needs orchestration. Pure
// function: no DB, no I/O, no model calls, no thresholds learned from
// anywhere. Every decision carries its reasons; thresholds that lack
// calibration evidence are marked PROVISIONAL in the reason text.
//
// Shadow contract: callers may RECORD the recommendation (run output,
// reports) but must never change execution behavior on it. Enabling
// requires the Phase 4 adoption gate, which has not passed.

export type RouteDecision = "SINGLE_AGENT" | "ORCHESTRATED" | "REQUIRES_REVIEW";

export interface RouteReason {
  /** Stable rule identifier for aggregation (e.g. "single-task"). */
  readonly rule: string;
  /**
   * Human-readable justification, including the evidence it cites and a
   * PROVISIONAL tag wherever a threshold lacks calibration data.
   */
  readonly detail: string;
}

export interface RouteRecommendation {
  readonly route: RouteDecision;
  readonly reasons: RouteReason[];
}

export interface RoutableTask {
  readonly id: string;
  readonly claims: ReadonlyArray<{ readonly resourceId: string; readonly access: string }>;
}

export interface RoutableEdge {
  readonly taskId: string;
  readonly dependsOnTaskId: string;
}

/**
 * Maximum task count for the small-independent-set rule. PROVISIONAL:
 * measured evidence covers 2–3 task sets only (M28.6/M29.0); larger sets
 * fall through to ORCHESTRATED until calibrated.
 */
export const SMALL_INDEPENDENT_SET_MAX = 3;

function sharedWriteResources(
  tasks: ReadonlyArray<RoutableTask>,
): Array<{ resource: string; taskIds: string[] }> {
  const writers = new Map<string, string[]>();
  for (const task of tasks) {
    for (const claim of task.claims) {
      if (claim.access === "WRITE") {
        const list = writers.get(claim.resourceId) ?? [];
        list.push(task.id);
        writers.set(claim.resourceId, list);
      }
    }
  }
  return [...writers.entries()]
    .filter(([, ids]) => new Set(ids).size > 1)
    .map(([resource, ids]) => ({ resource, taskIds: [...new Set(ids)].sort() }))
    .sort((a, b) => (a.resource < b.resource ? -1 : 1));
}

export function recommendRoute(
  tasks: ReadonlyArray<RoutableTask>,
  dependencies: ReadonlyArray<RoutableEdge>,
): RouteRecommendation {
  if (tasks.length === 0) {
    return {
      route: "REQUIRES_REVIEW",
      reasons: [{ rule: "empty-run", detail: "no tasks to route; nothing to execute" }],
    };
  }
  const unclaimed = tasks.filter((t) => t.claims.length === 0).map((t) => t.id);
  if (unclaimed.length > 0) {
    return {
      route: "REQUIRES_REVIEW",
      reasons: [
        {
          rule: "unclaimed-tasks",
          detail: `tasks without claims cannot be assessed for write conflicts: ${unclaimed.sort().join(", ")}`,
        },
      ],
    };
  }
  const shared = sharedWriteResources(tasks);
  if (shared.length > 0) {
    return {
      route: "REQUIRES_REVIEW",
      reasons: shared.map((s) => ({
        rule: "shared-write",
        detail: `shared WRITE on ${s.resource} by ${s.taskIds.length} tasks (${s.taskIds.join(", ")}): integration-conflict risk per M29.0 classes 3–4; needs human scoping`,
      })),
    };
  }
  if (tasks.length === 1) {
    return {
      route: "SINGLE_AGENT",
      reasons: [{ rule: "single-task", detail: "one work unit: coordination is impossible, orchestration adds only overhead" }],
    };
  }
  if (dependencies.length === 0 && tasks.length <= SMALL_INDEPENDENT_SET_MAX) {
    return {
      route: "SINGLE_AGENT",
      reasons: [
        {
          rule: "small-independent-set",
          detail: `${tasks.length} tasks, no dependencies, disjoint writes (PROVISIONAL threshold ≤${SMALL_INDEPENDENT_SET_MAX}: measured evidence covers 2–3 task sets; M29.0 found single-agent sufficient for tested conditions)`,
        },
      ],
    };
  }
  const depthNote =
    dependencies.length === 0
      ? `${tasks.length} independent tasks exceed the provisional small-set bound`
      : `${dependencies.length} dependenc${dependencies.length === 1 ? "y" : "ies"} impose execution order`;
  return {
    route: "ORCHESTRATED",
    reasons: [{ rule: "coordination-present", detail: `${depthNote}: scheduling and ordered integration are structurally justified` }],
  };
}
