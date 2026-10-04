import { describe, expect, it } from "vitest";
import { recommendRoute, SMALL_INDEPENDENT_SET_MAX } from "../src/planner/routing.js";
import { deriveActualStrategy } from "../src/cli/run-command.js";

// Shadow classifier unit tests (M29.2 Phase 1/2). Pure function, no I/O.
// Every branch is pinned: adding a rule or changing a threshold must
// update these tests deliberately, never silently.

const w = (resourceId: string) => ({ resourceId, access: "WRITE" as const });
const r = (resourceId: string) => ({ resourceId, access: "READ" as const });

describe("execution routing classifier, shadow mode (M29.2)", () => {
  it("requires review for an empty run", () => {
    const rec = recommendRoute([], []);
    expect(rec.route).toBe("REQUIRES_REVIEW");
    expect(rec.reasons[0]?.rule).toBe("empty-run");
  });

  it("requires review for unclaimed tasks", () => {
    const rec = recommendRoute([{ id: "a", claims: [] }], []);
    expect(rec.route).toBe("REQUIRES_REVIEW");
    expect(rec.reasons[0]?.rule).toBe("unclaimed-tasks");
    expect(rec.reasons[0]?.detail).toContain("a");
  });

  it("requires review for shared WRITE resources with explicit reasons", () => {
    const rec = recommendRoute(
      [
        { id: "a", claims: [w("src/settings.js")] },
        { id: "b", claims: [w("src/settings.js")] },
      ],
      [],
    );
    expect(rec.route).toBe("REQUIRES_REVIEW");
    expect(rec.reasons[0]?.rule).toBe("shared-write");
    expect(rec.reasons[0]?.detail).toContain("src/settings.js");
  });

  it("does not flag shared READ resources", () => {
    const rec = recommendRoute(
      [
        { id: "a", claims: [r("package.json")] },
        { id: "b", claims: [r("package.json")] },
      ],
      [],
    );
    expect(rec.route).toBe("SINGLE_AGENT");
  });

  it("routes a single task to single-agent", () => {
    const rec = recommendRoute([{ id: "a", claims: [w("a.txt")] }], []);
    expect(rec.route).toBe("SINGLE_AGENT");
    expect(rec.reasons[0]?.rule).toBe("single-task");
  });

  it("routes small independent sets to single-agent with provisional marking", () => {
    expect(SMALL_INDEPENDENT_SET_MAX).toBe(3);
    const rec = recommendRoute(
      [
        { id: "a", claims: [w("a.txt")] },
        { id: "b", claims: [w("b.txt")] },
      ],
      [],
    );
    expect(rec.route).toBe("SINGLE_AGENT");
    expect(rec.reasons[0]?.rule).toBe("small-independent-set");
    expect(rec.reasons[0]?.detail).toContain("PROVISIONAL");
  });

  it("routes dependency chains to orchestrated", () => {
    const rec = recommendRoute(
      [
        { id: "a", claims: [w("a.txt")] },
        { id: "b", claims: [w("b.txt")] },
      ],
      [{ taskId: "b", dependsOnTaskId: "a" }],
    );
    expect(rec.route).toBe("ORCHESTRATED");
    expect(rec.reasons[0]?.rule).toBe("coordination-present");
  });

  it("routes large independent sets to orchestrated (provisional bound)", () => {
    const tasks = ["a", "b", "c", "d"].map((id) => ({ id, claims: [w(`${id}.txt`)] }));
    const rec = recommendRoute(tasks, []);
    expect(rec.route).toBe("ORCHESTRATED");
  });

  it("is deterministic and total (every input yields reasons)", () => {
    const inputs = [
      { tasks: [], deps: [] },
      { tasks: [{ id: "a", claims: [w("x")] }], deps: [] },
    ] as const;
    for (const input of inputs) {
      const first = recommendRoute(input.tasks, input.deps);
      const second = recommendRoute(input.tasks, input.deps);
      expect(second).toEqual(first);
      expect(first.reasons.length).toBeGreaterThan(0);
    }
  });
});

describe("actual strategy derivation (M29.3)", () => {
  it("derives single-agent only for single-task runs", () => {
    expect(deriveActualStrategy(1)).toBe("SINGLE_AGENT");
    expect(deriveActualStrategy(0)).toBe("ORCHESTRATED");
    expect(deriveActualStrategy(2)).toBe("ORCHESTRATED");
    expect(deriveActualStrategy(200)).toBe("ORCHESTRATED");
  });
});
