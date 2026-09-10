import type { RepositoryAnalysis } from "../analyzer/types.js";
import type { PlannerProvider } from "./provider.js";
import { PlannerInputSchema, type PlannerInput, type ValidatedPlannerPlan } from "./types.js";
import { validatePlannerProposal } from "./validator.js";

export interface RunPlannerOptions {
  readonly analysis?: RepositoryAnalysis;
}

/**
 * Full planning pipeline — and deliberately nothing else:
 *
 *   PlannerInput → Provider.generate() → raw proposal → validate → plan
 *
 * The provider's output is typed `unknown` and always re-validated, so even
 * a compromised or buggy provider cannot inject authority. This function
 * never assigns workers, creates worktrees, runs Git, touches source code,
 * writes to the database, or executes anything. What comes out is a
 * validated proposal awaiting M6 scheduling and human approval.
 */
export async function runPlanner(
  input: PlannerInput,
  provider: PlannerProvider,
  options: RunPlannerOptions = {},
): Promise<ValidatedPlannerPlan> {
  const parsed = PlannerInputSchema.parse(input);
  const raw = await provider.generate(parsed);
  return validatePlannerProposal(raw, options);
}
