import { DomainError } from "../core/errors.js";

export class DependencyCycleError extends DomainError {
  readonly cycle: readonly string[];

  constructor(cycle: readonly string[]) {
    super("DEPENDENCY_CYCLE", `dependency cycle detected: ${cycle.join(" -> ")}`);
    this.name = "DependencyCycleError";
    this.cycle = cycle;
  }
}
