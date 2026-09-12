// Atlas real-agent benchmark harness (V0.1 milestone 14, experimental).
//
// Controlled orchestration comparison with a real coding-agent CLI held
// constant: same repository, base commit, human-authored decomposition,
// claims, prompts, and agent across SINGLE_AGENT, DUMB_PARALLEL, and ATLAS.
// Only orchestration differs. M10's synthetic benchmark is untouched and
// separate; results here carry real-agent provenance, never "fake-provider".
//
//   types.ts     Agent config, human-authored workload specs, run results
//                (observed vs derived vs unknown kept distinct), comparison
//   prompts.ts   One shared renderer: identical prompt bytes for every arm
//   agent.ts     CommandWorkerProvider construction from prompt + config
//   workloads.ts Six small synthetic multi-file workloads with real tests
//   strategies.ts SINGLE/DUMB manual composition + ATLAS via the M11 loop
//   metrics.ts   Success rates + successful-run medians; runs kept, never averaged away
//   runner.ts    Fixture build, fairness asserts, repeats, cleanup, assembly

export * from "./types.js";
export * from "./prompts.js";
export * from "./agent.js";
export * from "./workloads.js";
export * from "./strategies.js";
export * from "./metrics.js";
export * from "./runner.js";
