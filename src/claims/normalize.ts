import { InvalidResourceClaimError } from "./errors.js";
import type { AccessMode, ClaimKind, NormalizedClaim } from "./types.js";

const CONTROL_CHARS = /[\0-\x1f\x7f]/;
const DRIVE_LETTER = /^[A-Za-z]:(?:\/|$)/;

/**
 * Normalize one repository-relative resource path to its canonical id.
 *
 * - trims whitespace, folds `\` to `/`, collapses `//`, strips leading `./`
 * - rejects: empty, absolute (`/...`), drive letters (`C:...`), `..` segments,
 *   control characters, and anything under `.git/`
 * - a trailing slash marks a directory claim; the canonical id drops it, so
 *   `src/auth/` and `src/auth` denote the same resource deterministically
 * - case is preserved (filesystems may be case-sensitive); `*` and friends
 *   are treated literally — no glob expansion in V0.1
 */
export function normalizeResourceId(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new InvalidResourceClaimError("claim resource must not be empty");
  }
  if (trimmed.length > 1000) {
    throw new InvalidResourceClaimError("claim resource is too long");
  }
  if (CONTROL_CHARS.test(trimmed)) {
    throw new InvalidResourceClaimError(`claim resource contains control characters: ${JSON.stringify(raw)}`);
  }
  let path = trimmed.replace(/\\/g, "/");
  while (path.startsWith("./")) {
    path = path.slice(2);
  }
  if (path.startsWith("/") || DRIVE_LETTER.test(path)) {
    throw new InvalidResourceClaimError(`claim resource must be repository-relative: ${JSON.stringify(raw)}`);
  }
  const segments = path.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    throw new InvalidResourceClaimError(`claim resource must not be empty: ${JSON.stringify(raw)}`);
  }
  for (const segment of segments) {
    if (segment === "." || segment === "..") {
      throw new InvalidResourceClaimError(`claim resource must not contain dot segments: ${JSON.stringify(raw)}`);
    }
    if (segment === ".git") {
      throw new InvalidResourceClaimError(`claim resource must not reference .git internals: ${JSON.stringify(raw)}`);
    }
  }
  return segments.join("/");
}

function kindOf(raw: string): ClaimKind {
  return raw.trim().replace(/\\/g, "/").endsWith("/") ? "DIRECTORY" : "FILE";
}

/** Case-insensitive READ/WRITE; anything else is an invalid claim. */
export function normalizeAccess(raw: string): AccessMode {
  const upper = raw.trim().toUpperCase();
  if (upper === "READ" || upper === "WRITE") {
    return upper;
  }
  throw new InvalidResourceClaimError(`claim access must be READ or WRITE: ${JSON.stringify(raw)}`);
}

export function normalizeClaimInput(resource: string, access: string): NormalizedClaim {
  return { resourceId: normalizeResourceId(resource), kind: kindOf(resource), access: normalizeAccess(access) };
}

/**
 * Deduplicate normalized claims (key: access + resource id) and sort
 * deterministically by resource id, then access. Same input always yields the
 * same output regardless of submission order.
 */
export function deduplicateClaims(claims: readonly NormalizedClaim[]): NormalizedClaim[] {
  const seen = new Map<string, NormalizedClaim>();
  for (const claim of claims) {
    seen.set(`${claim.access}:${claim.resourceId}`, claim);
  }
  return [...seen.values()].sort((a, b) => {
    if (a.resourceId < b.resourceId) {
      return -1;
    }
    if (a.resourceId > b.resourceId) {
      return 1;
    }
    return a.access < b.access ? -1 : 1;
  });
}
