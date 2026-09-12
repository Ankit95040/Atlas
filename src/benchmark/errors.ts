import { DomainError } from "../core/errors.js";

/** Benchmark configuration, fixture, or isolation failure. Never a measurement. */
export class BenchmarkError extends DomainError {
  constructor(message: string) {
    super("BENCHMARK_ERROR", message);
    this.name = "BenchmarkError";
  }
}
