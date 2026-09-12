import { DomainError } from "../core/errors.js";

/**
 * Orchestrator configuration or loop failure. Per-task operational outcomes
 * (execution FAILED/CLAIM_VIOLATION, test failures, REJECTED verification)
 * are recorded in the wave-loop result, never thrown as this error — only
 * genuine loop/config failures (missing feature/repository, project
 * mismatch, empty feature, scheduler/merge-train infra errors) surface here.
 */
export class OrchestratorError extends DomainError {
  constructor(message: string) {
    super("ORCHESTRATOR_ERROR", message);
    this.name = "OrchestratorError";
  }
}
