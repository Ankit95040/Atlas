// Atlas integration triage (V0.1 milestone 13).
//
// Read-only deterministic evidence layer over halted merge trains. When
// sibling worker branches collide in the train, triage turns the halt into
// an actionable report — conflicting files (via a throwaway Git replay),
// proven per-file ownership (branch diffs, never titles), declared claim
// overlap (existing M5 engine), dependency direction (existing M6 graph),
// and explicitly-unproven semantic-risk flags — without rebasing,
// resolving, or modifying anything. The human remains the final authority.
//
//   types.ts    strict Zod I/O: input, findings, classifications, report
//   errors.ts   TriageError (input/config failures; evidence gaps degrade)
//   evidence.ts read-only Git collection: branch diffs + replay lifecycle
//   triage.ts   triageIntegrationHalt + pure classifyTriageFindings

export * from "./types.js";
export * from "./errors.js";
export * from "./evidence.js";
export * from "./triage.js";
