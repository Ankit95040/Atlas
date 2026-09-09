// Atlas repository analyzer (V0.1 milestone 5).
//
// Deterministic static structural analysis: Git-tracked files (`git ls-files`)
// classified into a small resource vocabulary, pinned to the analyzed commit.
// No semantic understanding, no LLM, no filesystem crawling outside Git.
// Untracked files are out of scope for V0.1 (documented in analyze.ts).
//
//   types.ts    ResourceKind, ResourceEntry, RepositoryAnalysis
//   errors.ts   RepositoryAnalysisError (a DomainError)
//   classify.ts pure filename-based classification (unit-testable, no Git)
//   analyze.ts  analyzeRepository + listTrackedFiles (Git via src/git/)

export * from "./types.js";
export * from "./errors.js";
export * from "./classify.js";
export * from "./analyze.js";
