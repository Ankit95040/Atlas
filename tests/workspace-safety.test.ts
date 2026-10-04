import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findAtlasCheckout, resolveWorkspaceRoot } from "../src/cli/run-command.js";
import { initTempRepo } from "./git-helpers.js";

// Workspace safety guard (M28.4 Phase A).
//
// The default worker workspace root silently resolves under cwd. When that
// lands inside the Atlas checkout itself, the operator almost certainly
// meant a target repository. Explicit paths are always honored.

describe("workspace safety guard (M28.4)", () => {
  it("identifies the Atlas checkout positively or not at all", () => {
    const checkout = findAtlasCheckout();
    // Running from source: identified. (Packaged installs return null;
    // either outcome is safe — the guard only fires on positive identity.)
    if (checkout !== null) {
      expect(checkout.endsWith("Atlas")).toBe(true);
    }
  });

  it("resolves an explicit workspace root verbatim, even inside the checkout", () => {
    const checkout = findAtlasCheckout();
    if (checkout === null) {
      return;
    }
    expect(resolveWorkspaceRoot({ workspaceRoot: join(checkout, ".atlas", "work") }, checkout)).toBe(
      join(checkout, ".atlas", "work"),
    );
  });

  it("refuses the silent default inside the Atlas checkout", () => {
    const checkout = findAtlasCheckout();
    if (checkout === null) {
      return;
    }
    expect(() => resolveWorkspaceRoot({}, checkout)).toThrow(/inside the Atlas checkout/);
    expect(() => resolveWorkspaceRoot({}, checkout)).toThrow(/--workspace-root/);
    expect(() => resolveWorkspaceRoot({}, join(checkout, "subdir"))).toThrow(/inside the Atlas checkout/);
  });

  it("accepts the default for an intended external repository", async () => {
    const repo = await initTempRepo();
    try {
      expect(resolveWorkspaceRoot({}, repo)).toBe(join(repo, ".atlas", "work"));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("accepts safe temporary directories", () => {
    const dir = mkdtempSync(join(tmpdir(), "atlas-safe-"));
    try {
      // /tmp (and /private/tmp) never contain the Atlas markers.
      expect(resolveWorkspaceRoot({}, dir)).toBe(join(dir, ".atlas", "work"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves invalid paths to repository validation, not the guard", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atlas-safe-"));
    try {
      // Not a git checkout, but also not the Atlas tree: guard passes,
      // validateRepository rejects later with the actionable error.
      expect(resolveWorkspaceRoot({}, dir)).toBe(join(dir, ".atlas", "work"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
