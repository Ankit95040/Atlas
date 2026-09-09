// Atlas core domain layer (V0.1 milestone 2).
//
// Layers, kept deliberately thin — no DDD framework:
//   enums.ts       canonical lifecycle vocabulary (Prisma-backed enums)
//   inputs.ts      Zod input DTOs validated at application boundaries
//   validation.ts  deterministic invariant helpers (SHA, claims, dependencies)
//   transitions.ts explicit state machines + transition assertion
//   errors.ts      DomainError, InvalidTransitionError, InvariantViolationError, NotFoundError
//   service.ts     minimal persistence operations (create / transition / record)
//
// Prisma models are the database layer; Zod inputs are the boundary layer.
// They are intentionally distinct: schemas reject invalid data before it
// reaches persistence, and the service adds the invariants SQL cannot express.

export * from "./enums.js";
export * from "./errors.js";
export * from "./inputs.js";
export * from "./transitions.js";
export * from "./validation.js";
export * from "./service.js";
