// Atlas M18 scale/crossover benchmark harness (experimental).
//
// Controlled orchestration comparison held to the M18 design
// (docs/experiments/M18_SCALE_CROSSOVER_DESIGN.md): exactly the two arms
// SINGLE_AGENT and ATLAS_EVOLVING — the frozen M17 implementations, invoked
// unchanged — over leveled multi-task workloads with contribution-survival
// measurement. Only orchestration differs between arms.
//
//   types.ts       Complexity levels, probes, workload specs with review
//                  attestation, survival outcomes, run results with §6
//                  sub-predicates, resumable experiment state, setup contract
//   context.ts     Versioned token estimator, §R/§T/§V budget measurement
//   workloads.ts   Level-band conformance validation (incl. scheduler
//                  dry-run) + the human-authored workload dataset
//   survival.ts    Behavioral probes, diff presence, attribution, verdicts
//   persistence.ts Per-run atomic state persistence + resume (no infra)
//   aggregation.ts Wilson/Newcombe intervals, crossover interaction fit,
//                  failure-mode classification, context summary
//   runner.ts      Fixture build (inline + snapshot overlay + .gitignore),
//                  setup execution, frozen-arm dispatch, final gates,
//                  survival evaluation, context assembly, cleanup
//
// The M17 harness (../real/) is untouched and remains reproducible; M18
// reuses its arms, fixture builder shape, test runner, and git primitives
// without modifying any of them.

export * from "./types.js";
export * from "./context.js";
export * from "./workloads.js";
export * from "./survival.js";
export * from "./persistence.js";
export * from "./aggregation.js";
export * from "./runner.js";
