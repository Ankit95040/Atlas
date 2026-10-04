import { readFile, rename, writeFile } from "node:fs/promises";
import { BenchmarkError } from "../errors.js";
import { summarizeScaleRuns } from "./aggregation.js";
import {
  ScaleExperimentStateSchema,
  type ScaleComparison,
  type ScaleExperimentState,
  type ScaleRunResult,
} from "./types.js";

export const SCALE_STATE_VERSION = 1 as const;

/** Empty resumable state (design §10.2). */
export function emptyScaleState(meta: Partial<ScaleExperimentState["meta"]> = {}): ScaleExperimentState {
  return {
    version: SCALE_STATE_VERSION,
    updatedAt: new Date().toISOString(),
    workloads: {},
    meta: { setupEvidence: null, ...meta },
  };
}

/** Load persisted state; null when no file exists yet. Throws on corrupt content. */
export async function loadScaleState(path: string): Promise<ScaleExperimentState | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BenchmarkError(`scale state at ${path} is not valid JSON`);
  }
  const state = ScaleExperimentStateSchema.parse(parsed);
  if (state.version !== SCALE_STATE_VERSION) {
    throw new BenchmarkError(`unsupported scale state version ${state.version} at ${path}`);
  }
  return state;
}

/** Atomic persist (write temp + rename) so interruption cannot corrupt completed work. */
export async function saveScaleState(path: string, state: ScaleExperimentState): Promise<void> {
  const next: ScaleExperimentState = { ...state, updatedAt: new Date().toISOString() };
  ScaleExperimentStateSchema.parse(next);
  await writeFile(`${path}.tmp`, JSON.stringify(next, null, 2));
  await rename(`${path}.tmp`, path);
}

/**
 * Insert or replace one run cell, keyed by (workloadId, strategy, repeatIndex).
 * Replacement (not duplication) is what makes resume-after-crash safe: a cell
 * is never recorded twice.
 */
export function upsertScaleRun(
  state: ScaleExperimentState,
  workloadId: string,
  comparison: Pick<ScaleComparison, "level" | "minSuccessfulRuns">,
  run: ScaleRunResult,
): ScaleExperimentState {
  if (run.workloadId !== workloadId) {
    throw new BenchmarkError(`run workload ${run.workloadId} does not match cell workload ${workloadId}`);
  }
  const existing = state.workloads[workloadId];
  const runs = [...(existing?.runs ?? [])];
  const index = runs.findIndex((candidate) => candidate.strategy === run.strategy && candidate.repeatIndex === run.repeatIndex);
  if (index >= 0) {
    runs[index] = run;
  } else {
    runs.push(run);
  }
  runs.sort((a, b) => a.repeatIndex - b.repeatIndex || a.strategy.localeCompare(b.strategy));
  const level = existing?.level ?? comparison.level;
  if (existing !== undefined && existing.level !== comparison.level) {
    throw new BenchmarkError(`workload ${workloadId} level changed from ${existing.level} to ${comparison.level}`);
  }
  const minSuccessfulRuns = existing?.minSuccessfulRuns ?? comparison.minSuccessfulRuns;
  // Summaries stay fresh on every upsert so persisted state is always a
  // complete comparison, never a runs-only fragment.
  const strategies = [...new Set(runs.map((run) => run.strategy))].sort();
  const summaries = strategies.map((strategy) =>
    summarizeScaleRuns(strategy, runs.filter((run) => run.strategy === strategy), minSuccessfulRuns),
  );
  return {
    ...state,
    workloads: {
      ...state.workloads,
      [workloadId]: {
        workloadId,
        level,
        minSuccessfulRuns,
        summaries,
        runs,
      },
    },
  };
}

/** Cells without a recorded run: the exact remaining work (design §10.2). */
export function missingScaleCells(
  state: ScaleExperimentState,
  workloadId: string,
  strategies: readonly string[],
  repeats: number,
): Array<{ strategy: string; repeatIndex: number }> {
  const runs = state.workloads[workloadId]?.runs ?? [];
  const missing: Array<{ strategy: string; repeatIndex: number }> = [];
  for (let repeatIndex = 0; repeatIndex < repeats; repeatIndex += 1) {
    for (const strategy of strategies) {
      const found = runs.some((run) => run.strategy === strategy && run.repeatIndex === repeatIndex);
      if (!found) {
        missing.push({ strategy, repeatIndex });
      }
    }
  }
  return missing;
}

/** Completed-run count for progress reporting. */
export function completedScaleRuns(state: ScaleExperimentState): number {
  return Object.values(state.workloads).reduce((sum, comparison) => sum + comparison.runs.length, 0);
}
