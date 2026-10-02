import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isoProject, layoutProtoTiles, renderIslandProto } from "../src/ui/island25.js";
import type { WorkflowGraphData } from "../src/ui/data.js";

function fabricated(overrides: Partial<WorkflowGraphData> = {}): WorkflowGraphData {
  return {
    runId: "run-25",
    runTitle: "Proto Fab",
    runStatus: "IN_PROGRESS",
    nodes: [],
    edges: [],
    phases: [],
    trainHalted: false,
    trainHaltReason: null,
    trainCars: [],
    defaultBranch: "main",
    ...overrides,
  };
}

function rich(): WorkflowGraphData {
  return fabricated({
    nodes: [
      { id: "a1", title: "Alpha", status: "COMPLETED", workerId: "w1", workerStatus: "COMPLETED", workerLink: "historical", wave: 1, verdict: "VERIFIED", reasons: [], integrated: true, dependsOn: [] },
      { id: "b2", title: "Beta", status: "IN_PROGRESS", workerId: "w2", workerStatus: "RUNNING", workerLink: "live", wave: 1, verdict: null, reasons: [], integrated: false, dependsOn: [] },
      { id: "c3", title: "Gamma", status: "BLOCKED", workerId: null, workerStatus: null, workerLink: "none", wave: null, verdict: null, reasons: [], integrated: false, dependsOn: ["a1"] },
      { id: "d4", title: "Delta", status: "FAILED", workerId: "w4", workerStatus: "FAILED", workerLink: "historical", wave: 2, verdict: "REJECTED", reasons: ["tests red"], integrated: false, dependsOn: ["c3"] },
    ],
    edges: [{ from: "a1", to: "c3" }, { from: "c3", to: "d4" }],
    trainCars: [{ taskId: "a1", title: "Alpha", sha: "abc123def456789012345678901234567890abcd", subject: "atlas-train: integrate" }],
  });
}

describe("isometric scene model (deterministic, no renderer needed)", () => {
  it("projects tiles deterministically with depth", () => {
    const a = isoProject(1, 2, 0);
    const b = isoProject(1, 2, 0);
    expect(a).toEqual(b);
    const raised = isoProject(1, 2, 40);
    expect(raised.y).toBeLessThan(a.y);
    expect(raised.x).toBe(a.x);
    // Downhill flow: larger j projects lower on screen.
    expect(isoProject(0, 2, 0).y).toBeGreaterThan(isoProject(0, 0, 0).y);
  });

  it("groups levels from dependency depth only", () => {
    const { levels, buildingTiles } = layoutProtoTiles(
      [{ id: "a1" }, { id: "b2" }, { id: "c3" }],
      [{ from: "a1", to: "c3" }],
    );
    expect(levels[0]).toEqual(expect.arrayContaining(["a1", "b2"]));
    expect(levels[1]).toEqual(["c3"]);
    expect(buildingTiles.get("a1")).toBeDefined();
    // Same-level independents share j; dependent sits deeper.
    expect(buildingTiles.get("a1")?.j).toBe(buildingTiles.get("b2")?.j);
    expect(buildingTiles.get("c3")?.j ?? 0).toBeGreaterThan(buildingTiles.get("a1")?.j ?? 0);
  });
});

describe("2.5D prototype rendering (projection of WorkflowGraphData)", () => {
  it("renders structures, figures, conduits, wall, railyard, and harbor", () => {
    const html = renderIslandProto("run-25", rich());
    expect(html).toContain("ATLAS CONTROL");
    expect(html).toContain("ATLAS ISLAND");
    expect(html).toContain("Alpha");
    expect(html).toContain("LEVEL 1");
    expect(html).toContain("LEVEL 2");
    expect(html).toContain("WAVE 1");
    expect(html).toContain("WAVE 2");
    // Only dependency rows become conduits, with direction and waiting state.
    expect(html).toContain("satisfied: Alpha → Gamma");
    expect(html).toContain("waiting on Gamma");
    expect(html).not.toContain("Alpha → Beta");
    // Verification wall opens gates only on persisted verdicts.
    expect(html).toContain("VERIFICATION WALL");
    expect(html).toContain("tests red");
    // Merge car from integration state with short SHA.
    expect(html).toContain("abc123def456");
    // Harbor without invented SHA.
    expect(html).toContain("HARBOR");
    expect(html).toContain("MAIN main");
    expect(html).toContain("SHA unavailable");
    // Historical vs live figures.
    expect(html).toContain("historical");
    // Full-ID navigation.
    expect(html).toContain('href="/run?feature=run-25&view=tasks#task-a1"');
    expect(html).toContain('href="/run?feature=run-25&view=workers#worker-w1"');
    expect(html).toContain('href="/run?feature=run-25&view=overview"');
    // Polling diff hooks for the M24.9 queue.
    expect(html).toContain('data-task="a1"');
    expect(html).toContain('data-status="IN_PROGRESS"');
    expect(html).toContain('data-worker="w2"');
    expect(html).toContain('data-gate="a1"');
    expect(html).toContain('data-verdict="VERIFIED"');
    expect(html).toContain('data-car="abc123def456789012345678901234567890abcd"');
    // Text equivalent on the same page.
    expect(html).toContain("Island nodes (text equivalent)");
    // Back link to the proven flat view.
    expect(html).toContain("proven flat Island");
  });

  it("renders halt beacons, empty water, and escapes text", () => {
    const halted = renderIslandProto("r", fabricated({
      nodes: [{ id: "h", title: "H", status: "VERIFICATION", workerId: "w", workerStatus: "COMPLETED", workerLink: "live", wave: null, verdict: null, reasons: [], integrated: false, dependsOn: [] }],
      trainHalted: true,
      trainHaltReason: "merge conflicts in shared/counter.txt",
    }));
    expect(halted).toContain("HALTED");
    expect(halted).toContain("merge conflicts in shared/counter.txt");
    expect(renderIslandProto("r", fabricated())).toContain("Open water");
    const evil = renderIslandProto('r"q', fabricated({
      nodes: [{ id: "x", title: "<img src=x onerror=1>", status: "READY", workerId: null, workerStatus: null, workerLink: "none", wave: null, verdict: null, reasons: [], integrated: false, dependsOn: [] }],
    }));
    expect(evil).not.toContain("<img src=x onerror=1>");
    expect(evil).toContain("&lt;img");
  });

  it("needs no WebGL, canvas, or external assets", () => {
    const html = renderIslandProto("run-25", rich());
    expect(html).not.toContain("<canvas");
    expect(html).not.toContain("webgl");
    expect(html).not.toContain("three");
    // No external URLs: only internal /run links.
    const hrefs = [...html.matchAll(/href="(http[^"]+)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual([]);
    const srcs = [...html.matchAll(/(?:src|url\()=?"?(https?:[^"')]+)/g)].map((m) => m[1]);
    expect(srcs).toEqual([]);
  });
});

describe("prototype discipline (static enforcement)", () => {
  it("contains no mutations, orchestration imports, or engine dependencies", () => {
    const source = readFileSync(join(import.meta.dirname, "..", "src", "ui", "island25.ts"), "utf8");
    for (const pattern of [/\bdb\.\w+\.(create|update|delete|upsert)\(/, /\.(createMany|updateMany|deleteMany)\(/, /\$transaction\(/, /\$executeRaw/, /\$queryRaw/, /execFile\(/, /child_process/, /process\.env/]) {
      expect(source, `island25.ts matches ${String(pattern)}`).not.toMatch(pattern);
    }
    for (const mod of ["../scheduler", "../workers/runtime", "../workers/command", "../verification/mergetrain", "../verification/verify", "../orchestrator/", "three", "react", "canvas", "pixi", "phaser"]) {
      expect(source, `island25.ts imports ${mod}`).not.toContain(mod);
    }
    expect(source).not.toContain("new Worker(");
  });
});

describe("transition hooks and motion contract (M24.9)", () => {
  it("emits stable diff hooks and no transition classes on fresh render", async () => {
    const { initTempRepo } = await import("./git-helpers.js");
    const { createProject, createFeature } = await import("../src/core/service.js");
    const { getPrismaClient } = await import("../src/db/client.js");
    const { track, uniqueName } = await import("./domain-helpers.js");
    const repoDir = await initTempRepo();
    void repoDir;
    const db = getPrismaClient();
    const project = await createProject({ name: uniqueName("isl-hooks") }, db);
    track("project", project.id);
    const feature = await createFeature({ projectId: project.id, title: "hooks" }, db);
    track("feature", feature.id);
    const server = (await import("../src/ui/serve.js")).createUiServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    try {
      const html = await (await fetch(`http://localhost:${port}/run?feature=${feature.id}&view=island&mode=proto`)).text();
      // Diff hooks present for the queue; transition classes never pre-applied
      // to elements (the keyframes live in CSS, which is fine).
      expect(html).toContain("data-terminal=");
      for (const cls of ["is-enter", "is-state", "is-gate-open", "is-gate-shut", "is-car-enter", "is-halt-pulse"]) {
        expect(html).not.toContain(`class="${cls}"`);
      }
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("serves motion CSS with reduced-motion kill-switch and queue markers", async () => {
    const { initTempRepo } = await import("./git-helpers.js");
    const { createProject, createFeature } = await import("../src/core/service.js");
    const { getPrismaClient } = await import("../src/db/client.js");
    const { track, uniqueName } = await import("./domain-helpers.js");
    const repoDir = await initTempRepo();
    void repoDir;
    const db = getPrismaClient();
    const project = await createProject({ name: uniqueName("isl-motion") }, db);
    track("project", project.id);
    const feature = await createFeature({ projectId: project.id, title: "motion" }, db);
    track("feature", feature.id);
    const server = (await import("../src/ui/serve.js")).createUiServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    try {
      const html = await (await fetch(`http://localhost:${port}/run?feature=${feature.id}&view=island&mode=proto`)).text();
      for (const marker of [
        "prefers-reduced-motion",
        "animation: none",
        "matchMedia",
        "planTransitions",
        "setInterval(tick, 2500)",
        "clearInterval(window.__atlasPoll)",
      ]) {
        expect(html, `missing motion marker: ${marker}`).toContain(marker);
      }
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
