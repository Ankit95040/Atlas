import type { BenchmarkStrategy } from "../types.js";
import type { RealRunResult } from "./types.js";

/** Median of sorted values; standard middle (averaged pair when even). Null on empty input. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid] as number;
  }
  return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

export interface RealStrategySummaryInput {
  readonly strategy: BenchmarkStrategy;
  readonly runs: RealRunResult[];
  readonly minSuccessfulRuns: number;
}

export function summarizeRealStrategy(strategy: BenchmarkStrategy, runs: RealRunResult[], minSuccessfulRuns: number) {
  const successful = runs.filter((run) => run.success);
  return {
    strategy,
    totalRuns: runs.length,
    successfulRuns: successful.length,
    successRate: runs.length === 0 ? 0 : successful.length / runs.length,
    // Median over successful wall-clocks only; null below the minimum count. Never fabricated.
    medianSuccessfulWallClockMs:
      successful.length >= minSuccessfulRuns ? median(successful.map((run) => run.wallClockMs)) : null,
    runIds: runs.map((run) => run.runId),
  };
}

/**
 * Assemble a real-agent comparison: every individual run is kept; aggregates
 * are computed separately per strategy. No verdicts, no scores — success
 * rates and successful-run medians are data, never a single arbitrary number.
 */
export function compareRealRuns(
  workloadId: string,
  runs: RealRunResult[],
  minSuccessfulRuns: number,
  strategies: readonly BenchmarkStrategy[] = ["SINGLE_AGENT", "DUMB_PARALLEL", "ATLAS"],
) {
  const summaries = strategies
    .filter((strategy) => runs.some((run) => run.strategy === strategy))
    .map((strategy) => summarizeRealStrategy(strategy, runs.filter((run) => run.strategy === strategy), minSuccessfulRuns));
  return { workloadId, minSuccessfulRuns, summaries, runs: [...runs] };
}
