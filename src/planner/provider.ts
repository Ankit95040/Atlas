import type { PlannerInput } from "./types.js";

/**
 * Planner provider abstraction: the seam between probabilistic AI and
 * deterministic Atlas. The return type is deliberately `unknown` — provider
 * output is untrusted data that MUST pass Zod + deterministic validation
 * before influencing anything. A provider can never return authority, only
 * a proposal-shaped candidate.
 */
export interface PlannerProvider {
  generate(input: PlannerInput): Promise<unknown>;
}

/**
 * Deterministic stand-in used by tests (and any offline/demo flow): returns
 * a predefined candidate proposal verbatim. Validation downstream treats it
 * exactly like model output — including rejection when it is malformed.
 */
export class FakePlannerProvider implements PlannerProvider {
  constructor(private readonly proposal: unknown) {}

  async generate(_input: PlannerInput): Promise<unknown> {
    return this.proposal;
  }
}
