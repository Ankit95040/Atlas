// Atlas AI planner boundary (V0.1 milestone 7).
//
// Core principle: an AI-generated plan is never an authority. It is an
// untrusted proposal that must pass deterministic Atlas validation before it
// can influence execution. AI proposes → Atlas validates → Atlas schedules →
// human approves → workers execute later.
//
//   types.ts     PlannerInput / PlannerProposal (strict Zod contracts) +
//                ValidatedPlannerPlan (proof-of-validation boundary type)
//   provider.ts  PlannerProvider (returns unknown, never authority) +
//                FakePlannerProvider (deterministic stand-in for tests)
//   validator.ts validatePlannerProposal: Zod shape → M5 claim normalization
//                → M6 TaskGraph cycle check → optional M5 analysis check
//   convert.ts   toSchedulerInput: ValidatedPlannerPlan → M6 SchedulerInput
//                (raw proposals cannot reach the scheduler — compiler-enforced)
//   planner.ts   runPlanner: input → provider → validation. Nothing else:
//                no assignment, worktrees, Git, DB writes, or execution.

export * from "./types.js";
export * from "./provider.js";
export * from "./validator.js";
export * from "./convert.js";
export * from "./planner.js";
