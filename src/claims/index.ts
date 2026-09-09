// Atlas resource claims (V0.1 milestone 5).
//
// First-class deterministic claim abstraction over repository resources:
// explicit caller-provided claims (never LLM-inferred), canonical
// normalization, segment-wise conflict detection, and persistence through the
// existing Task.resourceClaims column (single store — no competing table).
//
//   types.ts     AccessMode/ClaimKind, NormalizedClaim, Zod inputs, comparison types
//   errors.ts    InvalidResourceClaimError, ResourceClaimConflictError (DomainErrors)
//   normalize.ts canonical ids, case-insensitive access, deterministic dedup
//   conflicts.ts resourceOverlaps (segment-wise), compareClaimSets, assertNoConflict
//   service.ts   read/get/create task claims, checkTaskPair, analysis validation

export * from "./types.js";
export * from "./errors.js";
export * from "./normalize.js";
export * from "./conflicts.js";
export * from "./service.js";
