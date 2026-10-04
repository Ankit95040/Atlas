import { z } from "zod";

// Provider usage metering (M28.9). Pure observation, zero control impact.
//
// Provenance: `opencode run --format json` emits `step_finish` events whose
// `tokens`/`cost` payloads are emitted by the CLI runtime, not the model.
// This module parses those envelopes out of captured child stdout. Anything
// else — missing lines, non-JSON lines, wrong shapes, negative numbers —
// yields null (unknown), never a guess. A provider-reported cost of 0
// (free tier) is a legitimate observed value and is preserved as 0.

const nonNegativeInt = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const ProviderTokenUsageSchema = z
  .object({
    total: nonNegativeInt.nullable(),
    input: nonNegativeInt.nullable(),
    output: nonNegativeInt.nullable(),
    reasoning: nonNegativeInt.nullable(),
    cachedRead: nonNegativeInt.nullable(),
    cachedWrite: nonNegativeInt.nullable(),
  })
  .strict();

export type ProviderTokenUsage = z.infer<typeof ProviderTokenUsageSchema>;

export const ProviderUsageSchema = z
  .object({
    tokens: ProviderTokenUsageSchema.nullable(),
    /** Provider-reported cost in USD. Null when unreported; 0 is valid (free tier). */
    costUsd: z.number().min(0).nullable(),
    /** Step-finish events observed in this invocation (diagnostic count). */
    events: z.number().int().min(0),
    /** Malformed candidate lines skipped (diagnostic count). */
    malformed: z.number().int().min(0),
  })
  .strict();

export type ProviderUsage = z.infer<typeof ProviderUsageSchema>;

interface RawTokens {
  total?: unknown;
  input?: unknown;
  output?: unknown;
  reasoning?: unknown;
  cache?: unknown;
}

function asNonNegativeInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function parseTokens(raw: RawTokens): ProviderTokenUsage | null {
  const cache = (raw.cache ?? {}) as { read?: unknown; write?: unknown };
  const tokens = {
    total: asNonNegativeInt(raw.total),
    input: asNonNegativeInt(raw.input),
    output: asNonNegativeInt(raw.output),
    reasoning: asNonNegativeInt(raw.reasoning),
    cachedRead: asNonNegativeInt(typeof cache === "object" && cache !== null ? cache.read : null),
    cachedWrite: asNonNegativeInt(typeof cache === "object" && cache !== null ? cache.write : null),
  };
  if (Object.values(tokens).every((v) => v === null)) {
    return null;
  }
  return ProviderTokenUsageSchema.parse(tokens);
}

/**
 * Extract usage from one provider invocation's captured stdout. Sums across
 * every well-formed `step_finish` event (multi-step sessions are additive,
 * never overwritten). Returns null when nothing usable was observed.
 * Never throws on hostile input.
 */
export function extractProviderUsage(stdout: string): ProviderUsage | null {
  let events = 0;
  let malformed = 0;
  let costUsd: number | null = null;
  let costSeen = false;
  const totals = { total: 0, input: 0, output: 0, reasoning: 0, cachedRead: 0, cachedWrite: 0 };
  const seen = { total: false, input: false, output: false, reasoning: false, cachedRead: false, cachedWrite: false };
  const bump = (key: keyof typeof totals, value: number | null): void => {
    if (value !== null) {
      totals[key] += value;
      seen[key] = true;
    }
  };
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) {
      continue;
    }
    const record = parsed as { type?: unknown; part?: unknown };
    const part = (record.part ?? record) as { type?: unknown; tokens?: unknown; cost?: unknown };
    const isStepFinish = record.type === "step_finish" || part.type === "step-finish";
    if (!isStepFinish) {
      continue;
    }
    events += 1;
    const tokens = parseTokens((part.tokens ?? {}) as RawTokens);
    if (tokens === null) {
      malformed += 1;
      continue;
    }
    bump("total", tokens.total);
    bump("input", tokens.input);
    bump("output", tokens.output);
    bump("reasoning", tokens.reasoning);
    bump("cachedRead", tokens.cachedRead);
    bump("cachedWrite", tokens.cachedWrite);
    const cost = (part as { cost?: unknown }).cost;
    if (typeof cost === "number" && cost >= 0 && Number.isFinite(cost)) {
      costUsd = (costUsd ?? 0) + cost;
      costSeen = true;
    } else if (cost !== undefined && cost !== null) {
      malformed += 1;
    }
  }
  if (events === 0) {
    return null;
  }
  const anyTokens = seen.total || seen.input || seen.output || seen.reasoning || seen.cachedRead || seen.cachedWrite;
  return ProviderUsageSchema.parse({
    tokens: anyTokens
      ? {
          total: seen.total ? totals.total : null,
          input: seen.input ? totals.input : null,
          output: seen.output ? totals.output : null,
          reasoning: seen.reasoning ? totals.reasoning : null,
          cachedRead: seen.cachedRead ? totals.cachedRead : null,
          cachedWrite: seen.cachedWrite ? totals.cachedWrite : null,
        }
      : null,
    costUsd: costSeen ? costUsd : null,
    events,
    malformed,
  });
}

/**
 * Aggregate per-task usage into run totals. All-or-null: totals are sums
 * only when EVERY task reports that dimension; otherwise null with the
 * reason recorded. Never partial sums presented as totals, never zeros
 * standing in for unknown.
 */
export function aggregateUsage(usages: ReadonlyArray<ProviderUsage | null>): {
  tokens: ProviderTokenUsage | null;
  costUsd: number | null;
  coverage: string;
} {
  if (usages.length === 0 || usages.some((u) => u === null || u.tokens === null)) {
    const missing = usages.length === 0 ? "no tasks" : "tasks without observed usage";
    return { tokens: null, costUsd: null, coverage: `incomplete: ${missing}` };
  }
  const present = usages as Array<ProviderUsage & { tokens: ProviderTokenUsage }>;
  const sum = (pick: (t: ProviderTokenUsage) => number | null): number | null => {
    let acc = 0;
    for (const u of present) {
      const v = pick(u.tokens);
      if (v === null) {
        return null;
      }
      acc += v;
    }
    return acc;
  };
  const costs = present.map((u) => u.costUsd);
  return {
    tokens: {
      total: sum((t) => t.total),
      input: sum((t) => t.input),
      output: sum((t) => t.output),
      reasoning: sum((t) => t.reasoning),
      cachedRead: sum((t) => t.cachedRead),
      cachedWrite: sum((t) => t.cachedWrite),
    },
    costUsd: costs.every((c): c is number => typeof c === "number") ? costs.reduce((a, b) => a + b, 0) : null,
    coverage: `complete: ${present.length}/${usages.length} tasks`,
  };
}
