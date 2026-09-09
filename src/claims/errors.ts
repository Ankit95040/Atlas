import { DomainError } from "../core/errors.js";
import type { ConflictDetail } from "./types.js";

export class InvalidResourceClaimError extends DomainError {
  constructor(reason: string) {
    super("INVALID_RESOURCE_CLAIM", reason);
    this.name = "InvalidResourceClaimError";
  }
}

export class ResourceClaimConflictError extends DomainError {
  readonly conflicts: readonly ConflictDetail[];

  constructor(conflicts: readonly ConflictDetail[]) {
    super(
      "RESOURCE_CLAIM_CONFLICT",
      `resource conflict on ${conflicts
        .map((conflict) => `${conflict.resourceA} (${conflict.accessA}) vs ${conflict.resourceB} (${conflict.accessB})`)
        .join("; ")}`,
    );
    this.name = "ResourceClaimConflictError";
    this.conflicts = conflicts;
  }
}
