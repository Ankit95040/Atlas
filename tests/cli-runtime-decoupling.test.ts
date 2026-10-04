import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// CLI runtime decoupling guarantee (M28.1 Phase A).
//
// The `atlas` executable must never load UI-only modules (React, Three.js,
// SSR server, browser APIs) through its import graph: Node ESM loads
// lazily per import chain, so absence from the graph is absence from the
// runtime. This test walks every engine/CLI source file and rejects
// imports of UI-only specifiers or directories. If UI code is ever
// imported by the engine, this fails loudly instead of silently
// bloating the CLI runtime.

const ENGINE_ROOTS = [
  "src/benchmark",
  "src/claims",
  "src/cli",
  "src/config",
  "src/core",
  "src/dag",
  "src/db",
  "src/git",
  "src/orchestrator",
  "src/planner",
  "src/triage",
  "src/verification",
  "src/workers",
  "src/workspaces",
];

const BANNED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /from\s+["']three["']/, reason: "three.js is UI-only (island projector)" },
  { pattern: /from\s+["']react["']/, reason: "react is UI-only" },
  { pattern: /from\s+["']react-dom/, reason: "react-dom is UI-only" },
  { pattern: /\.\.\/ui\//, reason: "src/ui (SSR server, views, projector) is UI-only" },
  { pattern: /\.\/ui\//, reason: "src/ui (SSR server, views, projector) is UI-only" },
  { pattern: /apps\/web/, reason: "apps/web is UI-only" },
  { pattern: /document\.|window\.|localStorage|requestAnimationFrame/, reason: "browser globals have no place in engine code" },
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("CLI runtime decoupling (M28.1)", () => {
  it("imports no UI-only modules from engine/CLI sources", () => {
    const violations: string[] = [];
    for (const root of ENGINE_ROOTS) {
      for (const file of sourceFiles(root)) {
        const text = readFileSync(file, "utf8");
        for (const { pattern, reason } of BANNED_PATTERNS) {
          if (pattern.test(text)) {
            violations.push(`${file}: matches ${pattern} (${reason})`);
          }
        }
      }
    }
    expect(violations, "UI imports leaked into the CLI runtime graph").toEqual([]);
  });

  it("keeps three.js out of the root runtime dependency surface used by the CLI", () => {
    // Root package.json retains three ONLY because root tsc still compiles
    // src/ui/island3d (UI files are preserved, not deleted, per M28.1).
    // The guarantee that matters is the import graph above: nothing the
    // CLI loads can reach it. This pins that reasoning in place so a
    // future removal is a manifest-only change.
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { dependencies: Record<string, string> };
    expect(pkg.dependencies["three"], "three stays until UI removal milestone").toBeDefined();
    const web = JSON.parse(readFileSync("apps/web/package.json", "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(web.dependencies["three"], "apps/web owns its three.js copy").toBeDefined();
  });
});
