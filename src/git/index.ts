// Atlas Git worktree engine (V0.1 milestone 3).
//
// Deterministic Git CLI primitives for isolated worker workspaces.
// Git is the source of truth for repository state; Atlas stores only
// orchestration metadata (see the Workspace entity in Milestone 2).
// The engine never modifies the primary working tree and never uses a shell:
// all commands run via execFile-style argument arrays.
//
//   client.ts     runGit: no-shell execution with captured stdout/stderr/exit
//   types.ts      command results, repository status, worktree metadata
//   errors.ts     typed DomainError failures (codes stable for tests)
//   repository.ts inspection (root/branch/commit/status) + branch management
//   worktree.ts   isolated worktree lifecycle + worker branch naming

export * from "./client.js";
export * from "./types.js";
export * from "./errors.js";
export * from "./repository.js";
export * from "./worktree.js";
