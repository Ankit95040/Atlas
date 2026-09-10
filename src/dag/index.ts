// Atlas dependency graph + claim-aware scheduler (V0.1 milestone 6).
//
// Deterministic decision layer between task DAG + resource claims and the
// future worker runtime. No LLM, no execution, no assignment — the output is
// a machine-readable execution plan answering which tasks can run now, which
// must wait, and exactly why.
//
//   types.ts     SchedulerInput (Zod), ExecutionPlan, reason codes
//   errors.ts    DependencyCycleError (a DomainError)
//   graph.ts     TaskGraph: directed edges, sorted traversals, cycle detection
//   scheduler.ts planSchedule: pure greedy wave packing (dependency-ready,
//                capacity-bounded, claim-conflict-free within each wave)
//   loader.ts    loadSchedulerInput: Prisma rows → pure scheduler input
//                (transitive prerequisite closure, cross-feature included)

export * from "./types.js";
export * from "./errors.js";
export * from "./graph.js";
export * from "./scheduler.js";
export * from "./loader.js";
