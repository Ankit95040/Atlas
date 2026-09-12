// Atlas benchmark harness (V0.1 milestone 10).
//
// Reproducible orchestration benchmark: same feature, same base commit,
// three strategies (SINGLE_AGENT, DUMB_PARALLEL, ATLAS), measured outcomes.
// Fake providers only — results prove orchestration behavior (scheduling
// correctness, overhead bounds, determinism, conflict mechanics), never
// real-world coding-agent productivity.
//
//   types.ts     Zod: scenario, run result, comparison, metrics (all JSON-stable)
//   errors.ts    BenchmarkError (config/fixture/isolation failures, never measurements)
//   scenarios.ts Fixture builders + six built-in scenarios (deterministic contents)
//   strategies.ts runSingleAgent / runDumbParallel / runAtlas (compose M1–M9 only)
//   metrics.ts   Pure derivation: deriveComparison, deriveBaselineDeltas,
//                assessComparison (findings are data, never verdicts)
//   runner.ts    runBenchmarkScenario: shared fixture, isolation asserts,
//                per-run cleanup in finally, JSON-serializable comparison

export * from "./types.js";
export * from "./errors.js";
export * from "./scenarios.js";
export * from "./strategies.js";
export * from "./metrics.js";
export * from "./runner.js";
