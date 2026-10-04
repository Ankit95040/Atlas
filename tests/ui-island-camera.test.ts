import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Camera stability contract for M27.7 (Phase 0 of the topology plan).
//
// Polling must never move the operator's camera; only explicit Focus/Reset
// and first-paint/bounds-change framing may. WebGL cannot run in node, so
// these are static enforcement tests over the projector source — the same
// technique as the existing "3D discipline" suite — paired with a live
// Playwright orbit-persistence test for real proof.

const source = readFileSync(join(import.meta.dirname, "..", "src", "ui", "island3d", "client.ts"), "utf8");

function functionBody(name: string): string {
  const start = source.indexOf(`function ${name}(`);
  expect(start, `${name} exists`).toBeGreaterThanOrEqual(0);
  const next = source.indexOf("\n  function ", start + 1);
  return next === -1 ? source.slice(start) : source.slice(start, next);
}

describe("poll-safe camera (M27.7)", () => {
  it("frames exactly once at boot and never resets on polls", () => {
    // hasFramed gates the one and only home-framing call in update().
    expect(source).toContain("let hasFramed = false");
    expect(source).toContain("if (!hasFramed) {");
    // The home position write occurs in exactly one place: frameHome,
    // called from first paint and from explicit Reset only.
    const homes = [...source.matchAll(/camera\.position\.set\(34, 34, 34\)/g)].map((m) => m.index ?? -1);
    expect(homes).toHaveLength(2); // renderer boot default + frameHome
    const frameHomeAt = source.indexOf("function frameHome(");
    expect(frameHomeAt).toBeGreaterThanOrEqual(0);
    expect(homes[1] ?? -1).toBeGreaterThan(frameHomeAt);
    expect(source).toContain("frameHome(data.bounds)");
    expect(source).not.toContain("framedBoundsKey");
  });

  it("refits projection on canvas resize without touching the camera", () => {
    // Size tracking drives projection-only refits; position/target writes
    // appear nowhere in the resize path.
    expect(source).toContain("lastSize");
    expect(source).toContain("applyProjection(data.bounds)");
    const applyBody = functionBody("applyProjection");
    for (const token of ["camera.position.set", "controls.target.set", "lookAt"]) {
      expect(applyBody, `applyProjection must not touch ${token}`).not.toContain(token);
    }
    expect(applyBody).toContain("camera.updateProjectionMatrix()");
  });

  it("never moves the camera on selection", () => {
    const selectBody = functionBody("select");
    for (const token of ["camera.", "controls.", "flyTo", "resetView", "lookAt"]) {
      expect(selectBody, `select() must not touch ${token}`).not.toContain(token);
    }
  });

  it("moves the camera only through explicit focus/reset", () => {
    const focusBody = functionBody("focus");
    expect(focusBody).toContain("flyTo");
    const resetBody = functionBody("resetView");
    // Reset recomputes home framing from latest bounds (tweened, snapped
    // under reduced motion) — never a poll-driven reset.
    expect(resetBody).toContain("frameHome(bounds)");
    expect(resetBody).toContain("reducedMotion");
    // Reduced motion snaps instead of tweening.
    expect(functionBody("flyTo")).toContain("reducedMotion");
    // Focus-without-target restores home framing (explicit reset path).
    expect(focusBody).toContain("resetView()");
  });

  it("initial boot frames the scene (first update frames, reset recomputes)", () => {
    // hasFramed starts false, so the first update() frames; Reset recomputes
    // from the latest seen bounds instead of a stale snapshot.
    expect(source).toContain("let hasFramed = false");
    expect(source).toContain("let lastBounds:");
    expect(source).toContain("frameHome(data.bounds)");
    expect(source).toContain("if (!hasFramed) {");
  });

  it("disposal removes every canvas listener and the controls", () => {
    const disposeBody = functionBody("dispose");
    for (const kind of ["pointerdown", "pointerup", "pointermove", "pointerleave"]) {
      expect(disposeBody, `removes ${kind}`).toContain(`removeEventListener("${kind}"`);
    }
    expect(disposeBody).toContain("controls.dispose()");
  });

  it("publishes a poll-safe camera hook for smoke tests", () => {
    expect(source).toContain("__atlasIslandCamera");
  });

  it("constrains orbit to readable elevations at control-room speed (M27.7.3)", () => {
    // Designed view sits at polar ≈0.94 rad; the envelope keeps every
    // orbit near it — no top-down plate, no edge-on sliver.
    expect(source).toContain("controls.minPolarAngle = 0.7");
    expect(source).toContain("controls.maxPolarAngle = 1.25");
    expect(source).toContain("controls.rotateSpeed = 0.55");
    // Damping stays off: no render loop exists to settle it.
    expect(source).toContain("controls.enableDamping = false");
    // Zoom limits predate this milestone and stay intact.
    expect(source).toContain("controls.minZoom = 0.4");
    expect(source).toContain("controls.maxZoom = 4");
  });
});
