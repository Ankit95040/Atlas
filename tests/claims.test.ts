import { describe, expect, it } from "vitest";
import { DomainError } from "../src/core/errors.js";
import {
  CreateTaskClaimsInput,
  InvalidResourceClaimError,
  ResourceClaimConflictError,
  assertNoConflict,
  compareClaimSets,
  deduplicateClaims,
  normalizeAccess,
  normalizeClaimInput,
  normalizeResourceId,
  resourceOverlaps,
} from "../src/claims/index.js";
import type { NormalizedClaim } from "../src/claims/index.js";

function claim(resourceId: string, access: "READ" | "WRITE"): NormalizedClaim {
  return { resourceId, kind: "FILE", access };
}

describe("claim normalization", () => {
  it("accepts valid claims and normalizes equivalent spellings", () => {
    expect(normalizeClaimInput("./src/a.ts", "WRITE")).toEqual({
      resourceId: "src/a.ts",
      kind: "FILE",
      access: "WRITE",
    });
    expect(normalizeClaimInput("src/auth/", "WRITE")).toEqual({
      resourceId: "src/auth",
      kind: "DIRECTORY",
      access: "WRITE",
    });
    expect(normalizeClaimInput("src/auth", "READ")).toEqual({
      resourceId: "src/auth",
      kind: "FILE",
      access: "READ",
    });
    expect(normalizeResourceId("src\\\\app.ts")).toBe("src/app.ts");
    expect(normalizeResourceId("src//auth///login.ts")).toBe("src/auth/login.ts");
    expect(normalizeResourceId("  src/a.ts  ")).toBe("src/a.ts");
    expect(normalizeResourceId("././src/a.ts")).toBe("src/a.ts");
  });

  it("normalizes access case-insensitively for legacy rows", () => {
    expect(normalizeAccess("write")).toBe("WRITE");
    expect(normalizeAccess("Read")).toBe("READ");
    expect(normalizeAccess("WRITE")).toBe("WRITE");
    expect(() => normalizeAccess("delete")).toThrow(InvalidResourceClaimError);
    expect(() => normalizeAccess("")).toThrow(InvalidResourceClaimError);
  });

  it("rejects absolute paths, traversal, empties, and .git", () => {
    for (const bad of ["", "   ", "/abs/path", "C:\\win\\path", "C:/win", "../evil", "a/../../b", "a/../b"]) {
      expect(() => normalizeResourceId(bad), bad).toThrow(InvalidResourceClaimError);
    }
    expect(() => normalizeResourceId(".git/config")).toThrow(InvalidResourceClaimError);
    expect(() => normalizeResourceId("a/.git/hooks")).toThrow(InvalidResourceClaimError);
    try {
      normalizeResourceId("/x");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidResourceClaimError);
      expect(error).toBeInstanceOf(DomainError);
    }
  });

  it("deduplicates deterministically regardless of submission order", () => {
    const first: NormalizedClaim[] = [
      normalizeClaimInput("src/b.ts", "WRITE"),
      normalizeClaimInput("src/a.ts", "WRITE"),
      normalizeClaimInput("src/a.ts", "WRITE"),
      normalizeClaimInput("src/a.ts", "READ"),
    ];
    const second: NormalizedClaim[] = [
      normalizeClaimInput("src/a.ts", "READ"),
      normalizeClaimInput("src/a.ts", "WRITE"),
      normalizeClaimInput("src/b.ts", "WRITE"),
    ];
    expect(deduplicateClaims(first)).toEqual(deduplicateClaims(second));
    expect(deduplicateClaims(first)).toEqual([
      { resourceId: "src/a.ts", kind: "FILE", access: "READ" },
      { resourceId: "src/a.ts", kind: "FILE", access: "WRITE" },
      { resourceId: "src/b.ts", kind: "FILE", access: "WRITE" },
    ]);
  });

  it("validates the create-task-claims input shape at the boundary", () => {
    const parsed = CreateTaskClaimsInput.parse({
      taskId: "t1",
      claims: [{ resource: "src/a.ts", access: "write" }],
    });
    expect(parsed.claims).toEqual([{ resource: "src/a.ts", access: "WRITE" }]);
    expect(() => CreateTaskClaimsInput.parse({ taskId: "t1", claims: [] })).toThrow();
    expect(() => CreateTaskClaimsInput.parse({ taskId: "", claims: [{ resource: "a", access: "READ" }] })).toThrow();
    expect(() =>
      CreateTaskClaimsInput.parse({ taskId: "t1", claims: [{ resource: "a", access: "DELETE" }] }),
    ).toThrow();
    expect(() => CreateTaskClaimsInput.parse({ taskId: "t1", claims: [{ resource: "", access: "READ" }] })).toThrow();
  });
});

describe("claim conflict detection", () => {
  const read = (id: string): NormalizedClaim => claim(id, "READ");
  const write = (id: string): NormalizedClaim => claim(id, "WRITE");

  it("allows READ+READ and conflicts on any WRITE", () => {
    expect(compareClaimSets([read("a.ts")], [read("a.ts")])).toEqual({ status: "NO_CONFLICT", checkedPairs: 1 });
    expect(compareClaimSets([read("a.ts")], [write("a.ts")]).status).toBe("CONFLICT");
    expect(compareClaimSets([write("a.ts")], [read("a.ts")]).status).toBe("CONFLICT");
    expect(compareClaimSets([write("a.ts")], [write("a.ts")])).toMatchObject({
      status: "CONFLICT",
      conflicts: [{ resourceA: "a.ts", resourceB: "a.ts", accessA: "WRITE", accessB: "WRITE", kind: "WRITE_WRITE" }],
    });
  });

  it("reports conflict kinds from set A's perspective", () => {
    expect(compareClaimSets([read("a")], [write("a")])).toMatchObject({ conflicts: [{ kind: "READ_WRITE" }] });
    expect(compareClaimSets([write("a")], [read("a")])).toMatchObject({ conflicts: [{ kind: "WRITE_READ" }] });
  });

  it("detects parent/child conflicts in both directions", () => {
    expect(compareClaimSets([write("src/auth")], [write("src/auth/login.ts")]).status).toBe("CONFLICT");
    expect(compareClaimSets([write("src/auth/login.ts")], [write("src/auth")]).status).toBe("CONFLICT");
    expect(compareClaimSets([read("src/auth")], [write("src/auth/login.ts")]).status).toBe("CONFLICT");
    expect(compareClaimSets([read("src/auth/login.ts")], [read("src/auth")]).status).toBe("NO_CONFLICT");
  });

  it("uses segment comparison, never naive prefixes", () => {
    expect(resourceOverlaps("src/auth", "src/auth/login.ts")).toBe(true);
    expect(resourceOverlaps("src/auth", "src/authentication/login.ts")).toBe(false);
    expect(resourceOverlaps("src/authentication", "src/auth")).toBe(false);
    expect(compareClaimSets([write("src/auth")], [write("src/authentication/login.ts")])).toEqual({
      status: "NO_CONFLICT",
      checkedPairs: 1,
    });
  });

  it("finds no conflict across unrelated and multi-task sets", () => {
    const a = [write("src/auth/login.ts")];
    const b = [write("src/dashboard/page.tsx")];
    const c = [read("prisma/schema.prisma")];
    expect(compareClaimSets(a, b).status).toBe("NO_CONFLICT");
    expect(compareClaimSets(a, c).status).toBe("NO_CONFLICT");
    expect(compareClaimSets(b, c).status).toBe("NO_CONFLICT");
    expect(compareClaimSets([], []).status).toBe("NO_CONFLICT");
  });

  it("throws a typed conflict with details on demand", () => {
    expect(() => assertNoConflict([read("a")], [read("a")])).not.toThrow();
    try {
      assertNoConflict([write("a")], [write("a")]);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ResourceClaimConflictError);
      expect(error).toBeInstanceOf(DomainError);
      expect((error as ResourceClaimConflictError).conflicts).toHaveLength(1);
    }
  });
});
