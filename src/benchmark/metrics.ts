import type {
  AssessmentCode,
  AssessmentFinding,
  BenchmarkComparison,
  BenchmarkRunResult,
  BenchmarkStrategy,
  DerivedComparison,
} from "./types.js";

function isCompletedStatus(status: string): boolean {
  return status === "COMPLETED";
}

function strategyCost(run: BenchmarkRunResult, costs: Map<string, number>): number | null {
  let total = 0;
  for (const task of run.tasks) {
    const cost = costs.get(task.key);
    if (cost === undefined) {
      return null;
    }
    total += cost;
  }
  return total;
}

/**
 * Derive comparison metrics from raw run observations. Every rate is defined
 * over directly recorded evidence:
 * - failureRate: executed tasks whose worker status is not COMPLETED, over
 *   all executed tasks. (Claim violations count as failures: the work did
 *   not complete.)
 * - conflictRate: Git-confirmed CONFLICT integrations over all train items
 *   attempted. Resource-claim conflicts are scheduler input, never counted
 *   here — the three conflict concepts stay distinct.
 * - reworkRate: tasks needing redo (CONFLICT items plus items never attempted
 *   after a halt) over all tasks across compared runs.
 * Baselines that need SINGLE_AGENT or declared costs come from
 * deriveBaselineDeltas; missing inputs yield null, never NaN.
 */
export function deriveComparison(runs: Partial<Record<BenchmarkStrategy, BenchmarkRunResult>>): DerivedComparison {
  const present = Object.values(runs).filter((run): run is BenchmarkRunResult => run !== undefined);

  let failedTasks = 0;
  let totalTasks = 0;
  let conflictItems = 0;
  let trainItems = 0;
  let reworkTasks = 0;
  for (const run of present) {
    for (const task of run.tasks) {
      totalTasks += 1;
      if (!isCompletedStatus(task.status)) {
        failedTasks += 1;
      }
    }
    if (run.integration !== null) {
      for (const item of run.integration.items) {
        trainItems += 1;
        if (item.status === "CONFLICT" || item.status === "NOT_ATTEMPTED") {
          reworkTasks += 1;
        }
        if (item.status === "CONFLICT") {
          conflictItems += 1;
        }
      }
    }
  }

  return {
    speedupVsSingle: null,
    costDeltaVsSingle: null,
    failureRate: totalTasks === 0 ? 0 : failedTasks / totalTasks,
    conflictRate: trainItems === 0 ? 0 : conflictItems / trainItems,
    reworkRate: totalTasks === 0 ? 0 : reworkTasks / totalTasks,
  };
}

/**
 * Derive wall-clock and cost comparisons, which need a SINGLE_AGENT baseline
 * plus per-task simulated costs supplied by the caller (the harness records
 * declared simulated costs; it never measures real money).
 */
export function deriveBaselineDeltas(
  runs: Partial<Record<BenchmarkStrategy, BenchmarkRunResult>>,
  costs: Map<string, number>,
): Pick<DerivedComparison, "speedupVsSingle" | "costDeltaVsSingle"> {
  const single = runs.SINGLE_AGENT;
  const atlas = runs.ATLAS;
  const singleWall = single?.wallClockMs ?? 0;
  const atlasWall = atlas?.wallClockMs ?? 0;
  const singleCost = single !== undefined ? strategyCost(single, costs) : null;
  const atlasCost = atlas !== undefined ? strategyCost(atlas, costs) : null;
  return {
    speedupVsSingle:
      single === undefined || atlas === undefined || singleWall <= 0 || atlasWall <= 0
        ? null
        : singleWall / atlasWall,
    costDeltaVsSingle: singleCost === null || atlasCost === null ? null : atlasCost - singleCost,
  };
}

function integratedAll(run: BenchmarkRunResult): boolean {
  return run.integration !== null && run.integration.status === "COMPLETED";
}

/**
 * Emit machine-readable findings from measured evidence. These are inputs to
 * later kill-criteria evaluation, never product decisions themselves:
 * - ATLAS_SERIALIZED: Atlas ran >1 task with no parallel wave.
 * - SINGLE_AGENT_FASTER: the serial baseline beat Atlas wall-clock.
 * - SLOWER_DESPITE_PARALLEL: a strategy with measured peak concurrency > 1
 *   still lost to the serial baseline on wall-clock.
 * - COSTLIER_WITHOUT_GAIN: positive simulated cost delta without a strictly
 *   better integration outcome (ATLAS completed while SINGLE_AGENT did not).
 * - DUMB_CONFLICTED: dumb integration halted on a genuine Git conflict.
 * - ALL_INTEGRATED: every compared strategy integrated everything attempted.
 */
export function assessComparison(
  runs: Partial<Record<BenchmarkStrategy, BenchmarkRunResult>>,
  derived: DerivedComparison,
): AssessmentFinding[] {
  const findings: AssessmentFinding[] = [];
  const push = (code: AssessmentCode, detail: string): void => {
    findings.push({ code, detail });
  };

  const atlas = runs.ATLAS;
  const single = runs.SINGLE_AGENT;
  const dumb = runs.DUMB_PARALLEL;

  if (atlas !== undefined && atlas.tasks.length > 1) {
    const maxWave = atlas.scheduling === null ? 0 : Math.max(0, ...atlas.scheduling.waves.map((wave) => wave.length));
    if (maxWave <= 1) {
      push("ATLAS_SERIALIZED", `Atlas ran ${atlas.tasks.length} tasks with no parallel wave`);
    }
  }

  if (
    single !== undefined &&
    atlas !== undefined &&
    single.wallClockMs > 0 &&
    atlas.wallClockMs > 0 &&
    single.wallClockMs < atlas.wallClockMs
  ) {
    push(
      "SINGLE_AGENT_FASTER",
      `single-agent wall ${single.wallClockMs}ms beat Atlas wall ${atlas.wallClockMs}ms`,
    );
  }

  const candidates: ReadonlyArray<readonly [string, BenchmarkRunResult | undefined]> = [
    ["DUMB_PARALLEL", dumb],
    ["ATLAS", atlas],
  ];
  for (const [name, run] of candidates) {
    if (
      run !== undefined &&
      single !== undefined &&
      run.metrics.peakConcurrency > 1 &&
      single.wallClockMs > 0 &&
      run.wallClockMs > single.wallClockMs
    ) {
      push(
        "SLOWER_DESPITE_PARALLEL",
        `${name} peaked at ${run.metrics.peakConcurrency} concurrent workers yet took ${run.wallClockMs}ms vs single-agent ${single.wallClockMs}ms`,
      );
    }
  }

  if (
    derived.costDeltaVsSingle !== null &&
    derived.costDeltaVsSingle > 0 &&
    !(atlas !== undefined && integratedAll(atlas) && (single === undefined || !integratedAll(single)))
  ) {
    push("COSTLIER_WITHOUT_GAIN", `simulated cost delta vs single-agent is +${derived.costDeltaVsSingle}`);
  }

  if (dumb !== undefined && dumb.integration !== null && dumb.integration.conflicts.length > 0) {
    push(
      "DUMB_CONFLICTED",
      `dumb integration halted on genuine Git conflicts in: ${dumb.integration.conflicts.join(", ")}`,
    );
  }

  const present = [single, dumb, atlas].filter((run): run is BenchmarkRunResult => run !== undefined);
  if (present.length > 0 && present.every((run) => run.integration !== null && integratedAll(run))) {
    push("ALL_INTEGRATED", "every compared strategy integrated all attempted items");
  }

  const order: AssessmentCode[] = [
    "ATLAS_SERIALIZED",
    "SINGLE_AGENT_FASTER",
    "SLOWER_DESPITE_PARALLEL",
    "COSTLIER_WITHOUT_GAIN",
    "DUMB_CONFLICTED",
    "ALL_INTEGRATED",
  ];
  return findings.sort((a, b) => order.indexOf(a.code) - order.indexOf(b.code));
}

export function compareRuns(
  scenarioId: string,
  runs: Partial<Record<BenchmarkStrategy, BenchmarkRunResult>>,
  costs: Map<string, number>,
): BenchmarkComparison {
  const derived: DerivedComparison = { ...deriveComparison(runs), ...deriveBaselineDeltas(runs, costs) };
  return { scenarioId, runs, derived, assessment: assessComparison(runs, derived) };
}
