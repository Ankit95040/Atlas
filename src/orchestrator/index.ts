// Atlas feature wave-run loop (V0.1 milestone 11).
//
// A thin orchestration service over the M1–M9 engine: schedule a wave,
// approve + assign + execute it, run Atlas tests, verify, mark verified
// work COMPLETED, re-plan from fresh state, repeat, then integrate through
// the approval-gated merge train. Composes existing services; duplicates
// none (no second scheduler, no second worker runtime).
//
//   types.ts    RunFeatureWaveLoopInput (strict Zod boundary)
//   errors.ts   OrchestratorError (loop/config failures only)
//   run-loop.ts runFeatureWaveLoop (+ TaskOutcome / WaveLoopResult)

export * from "./types.js";
export * from "./errors.js";
export * from "./run-loop.js";
