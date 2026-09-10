// Atlas controlled worker runtime (V0.1 milestone 8).
//
// Atlas controls the execution boundary; the AI worker only implements inside
// it. Flow: approved task → assigned worker → isolated worktree → provider
// executes → Git diff inspected → declared claims vs actual changes →
// structured WorkerExecutionResult. No merging, no assignment, no execution
// of untrusted instructions as control.
//
//   types.ts    ExecuteTaskInput / WorkerExecutionInput (Zod), provider output
//               schema, WorkerExecutionResult + status codes
//   provider.ts WorkerProvider (returns unknown, never authority) +
//               FakeWorkerProvider (confined test file ops, optional commit)
//   runtime.ts  executeTask: gates → atomic slot → provider → diff → enforce
//   ../git/diff.ts (M3 engine extension): read-only worktree change inspection

export * from "./types.js";
export * from "./provider.js";
export * from "./runtime.js";
