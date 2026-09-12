import { DomainError } from "../core/errors.js";

/**
 * Triage input or configuration failure (unknown repository, no halted item,
 * malformed input). Evidence-collection failures (missing branches, failed
 * replay) never throw this — they degrade honestly to UNKNOWN findings so a
 * merge failure is never masked by a triage failure.
 */
export class TriageError extends DomainError {
  constructor(message: string) {
    super("TRIAGE_ERROR", message);
    this.name = "TriageError";
  }
}
