export class DomainError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}

export class InvalidTransitionError extends DomainError {
  constructor(entity: string, from: string, to: string) {
    super("INVALID_TRANSITION", `${entity} cannot transition from ${from} to ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export class InvariantViolationError extends DomainError {
  constructor(message: string) {
    super("INVARIANT_VIOLATION", message);
    this.name = "InvariantViolationError";
  }
}

export class NotFoundError extends DomainError {
  constructor(entity: string, id: string) {
    super("NOT_FOUND", `${entity} not found: ${id}`);
    this.name = "NotFoundError";
  }
}
