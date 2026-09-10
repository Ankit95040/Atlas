// Atlas verification + merge train (V0.1 milestone 9).
//
// Boundary between worker execution and trustworthy integration. Deterministic
// throughout: no LLM, no semantic merge, no automatic merge into main.
//
//   types.ts     TestCommand / RunTestsInput / TestExecutionResult /
//                VerifyExecutionInput / VerificationResult / MergeTrain I/O
//   errors.ts    NoTestCommandError, TestExecutionError,
//                MergeTrainNotApprovedError (all DomainErrors)
//   tests.ts     runTests: Atlas-executed test processes with TestRun rows;
//                exit code is the only truth (provider claims never consulted)
//   verify.ts    verifyExecution: links → workspace → base ancestry → claims
//                → cited PASSED TestRun; VERIFIED or REJECTED with reasons
//   mergetrain.ts runMergeTrain: approval-gated ordered integration onto a
//                dedicated train branch — merge, cumulative tests, commit per
//                item, halt on first failure. Main is never touched.

export * from "./types.js";
export * from "./errors.js";
export * from "./tests.js";
export * from "./verify.js";
export * from "./mergetrain.js";
