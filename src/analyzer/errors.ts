import { DomainError } from "../core/errors.js";

export class RepositoryAnalysisError extends DomainError {
  constructor(reason: string) {
    super("REPOSITORY_ANALYSIS_FAILED", reason);
    this.name = "RepositoryAnalysisError";
  }
}
