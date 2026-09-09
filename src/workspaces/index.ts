// Atlas workspace service (V0.1 milestone 4).
//
// Application layer coordinating the domain model (src/core/) with the Git
// worktree engine (src/git/): explicit Task → Worker assignment with an
// isolated Git worktree per worker. No scheduling, no execution.
//
//   types.ts   AssignTaskInput (Zod), AssignmentResult, buildWorkspacePath
//   errors.ts  TaskAssignmentError + specific subclasses (all DomainErrors)
//   service.ts assignTaskToWorker, getAssignment, compensateWorktree
//
// Git + SQLite are not one transaction: the worktree is created first (outside
// any Prisma transaction), all rows/transitions/events persist in a single
// Prisma transaction, and persistence failures trigger best-effort worktree
// removal that preserves the original error.

export * from "./types.js";
export * from "./errors.js";
export * from "./service.js";
