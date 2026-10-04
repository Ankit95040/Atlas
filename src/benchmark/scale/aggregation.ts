import { BenchmarkError } from "../errors.js";
import type { BenchmarkStrategy } from "../types.js";
import { median } from "../real/metrics.js";
import type { ScaleComplexityLevel, ScaleRunResult, ScaleStrategySummary } from "./types.js";
import type { ContextRecord } from "./context.js";

const Z_95 = 1.96;

// ---------- Wilson score interval (per-arm rates, design §8.1) ----------

export interface ConfidenceInterval {
  readonly lo: number;
  readonly hi: number;
}

/** Wilson score interval for a binomial proportion. Degenerate n=0 yields [0, 0]. */
export function wilsonInterval(successes: number, total: number, z: number = Z_95): ConfidenceInterval {
  if (total <= 0) {
    return { lo: 0, hi: 0 };
  }
  const p = successes / total;
  const denom = 1 + (z * z) / total;
  const center = (p + (z * z) / (2 * total)) / denom;
  const half = (z * Math.sqrt(p * (1 - p) / total + (z * z) / (4 * total * total))) / denom;
  return { lo: Math.max(0, center - half), hi: Math.min(1, center + half) };
}

/**
 * Newcombe-Wilson interval (method 10) for the difference of two independent
 * proportions. Used for the AE − SA contrast (design §8.1, V2/F-B).
 */
export function newcombeDifferenceInterval(
  successesA: number,
  totalA: number,
  successesB: number,
  totalB: number,
  z: number = Z_95,
): ConfidenceInterval {
  const pA = totalA === 0 ? 0 : successesA / totalA;
  const pB = totalB === 0 ? 0 : successesB / totalB;
  const diff = pA - pB;
  const ciA = wilsonInterval(successesA, totalA, z);
  const ciB = wilsonInterval(successesB, totalB, z);
  return {
    lo: diff - Math.sqrt((pA - ciA.lo) * (pA - ciA.lo) + (ciB.hi - pB) * (ciB.hi - pB)),
    hi: diff + Math.sqrt((ciA.hi - pA) * (ciA.hi - pA) + (pB - ciB.lo) * (pB - ciB.lo)),
  };
}

// ---------- Level summaries (design §8.1, §8.4) ----------

export interface ScaleArmSummary {
  readonly strategy: string;
  readonly totalRuns: number;
  readonly successfulRuns: number;
  readonly successRate: number;
  readonly successRateCI: ConfidenceInterval;
  readonly medianSuccessfulWallClockMs: number | null;
  readonly meanSurvivalRate: number | null;
  readonly runIds: string[];
}

export interface ScaleLevelSummary {
  readonly level: ScaleComplexityLevel;
  readonly arms: ScaleArmSummary[];
  /** ATLAS_EVOLVING minus SINGLE_AGENT success-rate difference with Newcombe CI. */
  readonly aeMinusSa: { readonly diff: number; readonly ci: ConfidenceInterval } | null;
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function summarizeArm(strategy: string, runs: ScaleRunResult[], minSuccessfulRuns: number): ScaleArmSummary {
  const successful = runs.filter((run) => run.success);
  const survivalRates = runs
    .map((run) => run.survivalRate)
    .filter((rate): rate is number => rate !== null);
  return {
    strategy,
    totalRuns: runs.length,
    successfulRuns: successful.length,
    successRate: runs.length === 0 ? 0 : successful.length / runs.length,
    successRateCI: wilsonInterval(successful.length, runs.length),
    medianSuccessfulWallClockMs:
      successful.length >= minSuccessfulRuns ? median(successful.map((run) => run.wallClockMs)) : null,
    meanSurvivalRate: mean(survivalRates),
    runIds: runs.map((run) => run.runId),
  };
}

/** Per-workload per-strategy summary persisted inside ScaleComparison (design §8.1). */
export function summarizeScaleRuns(
  strategy: BenchmarkStrategy,
  runs: ScaleRunResult[],
  minSuccessfulRuns: number,
): ScaleStrategySummary {
  const successful = runs.filter((run) => run.success);
  const survivalRates = runs
    .map((run) => run.survivalRate)
    .filter((rate): rate is number => rate !== null);
  return {
    strategy,
    totalRuns: runs.length,
    successfulRuns: successful.length,
    successRate: runs.length === 0 ? 0 : successful.length / runs.length,
    medianSuccessfulWallClockMs:
      successful.length >= minSuccessfulRuns ? median(successful.map((run) => run.wallClockMs)) : null,
    meanSurvivalRate: mean(survivalRates),
    runIds: runs.map((run) => run.runId),
  };
}

/** Per-level contrast over exactly the two M18 arms. Exploratory per design §8.5. */
export function summarizeScaleLevel(
  runs: ScaleRunResult[],
  level: ScaleComplexityLevel,
  minSuccessfulRuns: number,
): ScaleLevelSummary {
  const byStrategy = new Map<string, ScaleRunResult[]>();
  for (const run of runs) {
    const group = byStrategy.get(run.strategy) ?? [];
    group.push(run);
    byStrategy.set(run.strategy, group);
  }
  const arms = [...byStrategy.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([strategy, group]) => summarizeArm(strategy, group, minSuccessfulRuns));
  const ae = arms.find((arm) => arm.strategy === "ATLAS_EVOLVING");
  const sa = arms.find((arm) => arm.strategy === "SINGLE_AGENT");
  return {
    level,
    arms,
    aeMinusSa:
      ae !== undefined && sa !== undefined
        ? {
            diff: ae.successRate - sa.successRate,
            ci: newcombeDifferenceInterval(ae.successfulRuns, ae.totalRuns, sa.successfulRuns, sa.totalRuns),
          }
        : null,
  };
}

// ---------- Crossover interaction test (design §8.2, confirmatory) ----------

export interface InteractionCoefficient {
  readonly estimate: number;
  readonly standardError: number;
  readonly ci95: ConfidenceInterval;
  readonly z: number;
  readonly p: number;
}

export interface CrossoverFit {
  readonly converged: boolean;
  readonly iterations: number;
  readonly n: number;
  readonly intercept: InteractionCoefficient;
  readonly strategy: InteractionCoefficient;
  readonly complexity: InteractionCoefficient;
  /** The verdict statistic: AE log-odds improvement per complexity step. H1 predicts > 0. */
  readonly interaction: InteractionCoefficient;
}

function normalCdf(value: number): number {
  // Abramowitz & Stegun 7.1.26 (≈1e-7 accuracy): adequate for reporting p-values.
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-x * x);
  return 0.5 * (1 + sign * erf);
}

function solveLinear(system: number[][], rhs: number[]): number[] | null {
  // Gaussian elimination with partial pivoting for the 4x4 Newton step.
  const n = rhs.length;
  const augmented = system.map((row, i) => [...row, rhs[i] as number]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(augmented[row]?.[col] ?? 0) > Math.abs(augmented[pivot]?.[col] ?? 0)) {
        pivot = row;
      }
    }
    const pivotValue = augmented[pivot]?.[col] ?? 0;
    if (Math.abs(pivotValue) < 1e-12) {
      return null;
    }
    const pivotRow = augmented[pivot] as number[];
    augmented[pivot] = augmented[col] as number[];
    augmented[col] = pivotRow;
    for (let row = 0; row < n; row += 1) {
      if (row === col) {
        continue;
      }
      const factor = (augmented[row]?.[col] ?? 0) / pivotValue;
      for (let k = col; k <= n; k += 1) {
        augmented[row]![k] = (augmented[row]?.[k] ?? 0) - factor * (pivotRow[k] ?? 0);
      }
    }
  }
  return augmented.map((row, i) => (row[n] ?? 0) / (row[i] ?? 1));
}

function invert(matrix: number[][]): number[][] | null {
  const n = matrix.length;
  const inverse: number[][] = matrix.map((_, i) => matrix.map((_, j) => (i === j ? 1 : 0)));
  const work = matrix.map((row) => [...row]);
  const solved: number[][] = [];
  for (let col = 0; col < n; col += 1) {
    const rhs = inverse.map((row) => row[col] as number);
    const solution = solveLinear(work.map((row) => [...row]), rhs);
    if (solution === null) {
      return null;
    }
    solved.push(solution);
  }
  // solved[col][row] → transpose to rows.
  return solved[0]!.map((_, row) => solved.map((column) => column[row] as number));
}

/**
 * IRLS logistic regression for success ~ 1 + strategyAE + complexity +
 * strategyAE:complexity, complexity coded numerically (design §8.2).
 * Dependency-free by design (no new dependencies per M18 constraints):
 * 4-wide Newton steps with a small ridge for separation stability.
 * Non-convergence is reported, never hidden — an unconverged fit is not evidence.
 */
export function fitCrossoverInteraction(
  outcomes: ReadonlyArray<{ strategy: string; complexity: number; success: boolean }>,
  options: { ridge?: number; maxIterations?: number } = {},
): CrossoverFit {
  const ridge = options.ridge ?? 1e-4;
  const maxIterations = options.maxIterations ?? 100;
  const rows = outcomes.map((outcome) => {
    if (outcome.strategy !== "SINGLE_AGENT" && outcome.strategy !== "ATLAS_EVOLVING") {
      throw new BenchmarkError(`crossover fit supports only the two M18 arms, got ${outcome.strategy}`);
    }
    const strategyAE = outcome.strategy === "ATLAS_EVOLVING" ? 1 : 0;
    return { x: [1, strategyAE, outcome.complexity, strategyAE * outcome.complexity], y: outcome.success ? 1 : 0 };
  });
  if (rows.length === 0) {
    throw new BenchmarkError("crossover fit needs at least one outcome");
  }
  const dim = 4;
  let beta = [0, 0, 0, 0];
  let converged = false;
  let iterations = 0;
  for (let iter = 0; iter < maxIterations; iter += 1) {
    iterations = iter + 1;
    const gradient = [0, 0, 0, 0];
    const hessian = Array.from({ length: dim }, () => [0, 0, 0, 0]);
    for (const row of rows) {
      const linear = row.x.reduce((sum, value, i) => sum + value * (beta[i] ?? 0), 0);
      const prob = 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, linear))));
      const weight = Math.max(1e-9, prob * (1 - prob));
      const residual = row.y - prob;
      for (let i = 0; i < dim; i += 1) {
        gradient[i] = (gradient[i] ?? 0) + (row.x[i] ?? 0) * residual;
        for (let j = 0; j < dim; j += 1) {
          hessian[i]![j] = (hessian[i]?.[j] ?? 0) + (row.x[i] ?? 0) * (row.x[j] ?? 0) * weight;
        }
      }
    }
    for (let i = 0; i < dim; i += 1) {
      gradient[i] = (gradient[i] ?? 0) - ridge * (beta[i] ?? 0);
      hessian[i]![i] = (hessian[i]?.[i] ?? 0) + ridge;
    }
    const step = solveLinear(hessian, gradient);
    if (step === null) {
      break;
    }
    let largest = 0;
    for (let i = 0; i < dim; i += 1) {
      beta[i] = (beta[i] ?? 0) + (step[i] ?? 0);
      largest = Math.max(largest, Math.abs(step[i] ?? 0));
    }
    if (largest < 1e-8) {
      converged = true;
      break;
    }
  }
  // Standard errors from the observed information at the final estimate.
  const information = Array.from({ length: dim }, () => [0, 0, 0, 0]);
  for (const row of rows) {
    const linear = row.x.reduce((sum, value, i) => sum + value * (beta[i] ?? 0), 0);
    const prob = 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, linear))));
    const weight = Math.max(1e-9, prob * (1 - prob));
    for (let i = 0; i < dim; i += 1) {
      for (let j = 0; j < dim; j += 1) {
        information[i]![j] = (information[i]?.[j] ?? 0) + (row.x[i] ?? 0) * (row.x[j] ?? 0) * weight;
      }
    }
  }
  for (let i = 0; i < dim; i += 1) {
    information[i]![i] = (information[i]?.[i] ?? 0) + ridge;
  }
  const covariance = invert(information);
  const names = ["intercept", "strategy", "complexity", "interaction"] as const;
  const coefficients = {} as Record<(typeof names)[number], InteractionCoefficient>;
  for (let i = 0; i < dim; i += 1) {
    const name = names[i];
    if (name === undefined) {
      throw new BenchmarkError("crossover fit coefficient index out of range");
    }
    const estimate = beta[i] ?? 0;
    const variance = covariance?.[i]?.[i] ?? Number.NaN;
    const standardError = Number.isFinite(variance) && variance >= 0 ? Math.sqrt(variance) : Number.NaN;
    const z = standardError > 0 && Number.isFinite(standardError) ? estimate / standardError : Number.NaN;
    const p = Number.isFinite(z) ? 2 * (1 - normalCdf(Math.abs(z))) : Number.NaN;
    coefficients[name] = {
      estimate,
      standardError,
      ci95: { lo: estimate - Z_95 * standardError, hi: estimate + Z_95 * standardError },
      z,
      p,
    };
  }
  return {
    converged,
    iterations,
    n: rows.length,
    intercept: coefficients.intercept,
    strategy: coefficients.strategy,
    complexity: coefficients.complexity,
    interaction: coefficients.interaction,
  };
}

// ---------- Failure-mode classification (design §9, V3/F-C support) ----------

export type ScaleFailureMode =
  | "F1_CONTEXT_LOSS"
  | "F2_WORKER_FLAKINESS"
  | "F3_SILENT_OVERWRITE"
  | "F4_TRAIN_HALT"
  | "F6_TIMEOUT"
  | "F7_REGRESSION"
  | "NONE"
  | "UNCLASSIFIED";

/**
 * Heuristic dominant-mode classifier over one failed run. Priority is
 * upstream-first: worker causes outrank integration symptoms, which outrank
 * survival symptoms. Exploratory per design §8.5 — distributions support V3
 * mechanistically but never carry confirmatory weight alone.
 *
 * Note: F5 (union contradiction) is folded into F1 here: distinguishing them
 * needs workload-level competing-pair metadata the harness does not carry.
 * A run classified F1 on a contradiction workload is F1-or-F5; record the
 * workload, not just the code.
 */
export function classifyFailureMode(run: ScaleRunResult, workerTimeoutMs: number): ScaleFailureMode {
  if (run.success) {
    return "NONE";
  }
  if (run.regressionPassed === false) {
    return "F7_REGRESSION";
  }
  const tasks = run.tasks;
  if (
    tasks.some((task) =>
      ["CLAIM_VIOLATION", "INVALID_WORKSPACE", "BASE_COMMIT_MISMATCH", "NOT_AUTHORIZED"].includes(task.status),
    )
  ) {
    return "F2_WORKER_FLAKINESS";
  }
  const failedTasks = tasks.filter((task) => task.status === "FAILED");
  if (failedTasks.length > 0) {
    const diedBeforeTests = failedTasks.some((task) => task.testStatus === "NOT_RUN");
    if (diedBeforeTests && run.wallClockMs >= workerTimeoutMs) {
      return "F6_TIMEOUT";
    }
    return "F2_WORKER_FLAKINESS";
  }
  if (run.integration?.status === "HALTED") {
    return "F4_TRAIN_HALT";
  }
  const overwritten = run.survival.some((entry) => entry.status === "OVERWRITTEN" || entry.status === "REVERTED");
  if (overwritten) {
    return run.strategy === "ATLAS_EVOLVING" ? "F3_SILENT_OVERWRITE" : "F1_CONTEXT_LOSS";
  }
  if (run.survival.some((entry) => entry.status === "NEVER_MERGED")) {
    return run.strategy === "ATLAS_EVOLVING" ? "F4_TRAIN_HALT" : "F1_CONTEXT_LOSS";
  }
  if (!run.successPredicates.featureCorrectness) {
    // Train-gate and integration agree on the same command; disagreement here
    // means flakiness between the two executions.
    return "F2_WORKER_FLAKINESS";
  }
  return "UNCLASSIFIED";
}

/** Count runs per failure mode within one arm (supports V3 distributional comparison). */
export function failureModeBreakdown(
  runs: ScaleRunResult[],
  strategy: string,
  workerTimeoutMs: number,
): Record<ScaleFailureMode, number> {
  const breakdown: Record<ScaleFailureMode, number> = {
    F1_CONTEXT_LOSS: 0,
    F2_WORKER_FLAKINESS: 0,
    F3_SILENT_OVERWRITE: 0,
    F4_TRAIN_HALT: 0,
    F6_TIMEOUT: 0,
    F7_REGRESSION: 0,
    NONE: 0,
    UNCLASSIFIED: 0,
  };
  for (const run of runs.filter((candidate) => candidate.strategy === strategy)) {
    breakdown[classifyFailureMode(run, workerTimeoutMs)] += 1;
  }
  return breakdown;
}

// ---------- Context summary (Amendment A.2, exploratory) ----------

export interface ScaleContextSummary {
  readonly repoTokens: number;
  readonly taskRelevantTokens: number;
  readonly meanPromptTokensMax: number;
  readonly meanPromptTokensMean: number;
  readonly meanUtilizationMax: number;
  readonly runCount: number;
}

/** Mean context fields across runs. Descriptive/exploratory — never an admission gate. */
export function summarizeContext(runs: readonly ScaleRunResult[]): ScaleContextSummary | null {
  const withContext = runs.filter((run) => run.context !== undefined);
  if (withContext.length === 0) {
    return null;
  }
  // §R and §T are identical across runs of the same workload; take from first.
  const first = withContext[0]!;
  const promptTokensMaxValues = withContext.map((run) => run.context!.promptTokensMax);
  const promptTokensMeanValues = withContext.map((run) => run.context!.promptTokensMean);
  const utilizationMaxValues = withContext.map((run) => run.context!.utilizationMax);
  const mean = (values: number[]): number => values.reduce((s, v) => s + v, 0) / values.length;
  return {
    repoTokens: first.context!.repoTokens,
    taskRelevantTokens: first.context!.taskRelevantTokens,
    meanPromptTokensMax: mean(promptTokensMaxValues),
    meanPromptTokensMean: mean(promptTokensMeanValues),
    meanUtilizationMax: mean(utilizationMaxValues),
    runCount: withContext.length,
  };
}
