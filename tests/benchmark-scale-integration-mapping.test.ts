import { describe, expect, it } from "vitest";
import type { IntegratedItem } from "../src/verification/index.js";
import { toScaleIntegrationItems } from "../src/benchmark/scale/runner.js";

function item(overrides: Partial<IntegratedItem> = {}): IntegratedItem {
  return { taskId: "t1", workerId: "w1", status: "INTEGRATED", ...overrides };
}

describe("toScaleIntegrationItems (M19.3 evidence propagation)", () => {
  it("preserves merge evidence instead of dropping to key/status", () => {
    const [mapped] = toScaleIntegrationItems(
      [
        item({
          status: "MERGE_FAILED",
          reason: "merge failed: exit 128",
          gitExitCode: 128,
          gitStderr: "fatal: bad merge",
          sourceCommit: "abc123",
          durationMs: 42,
          emptyMerge: true,
        }),
      ],
      () => "a",
      "ATLAS_EVOLVING",
    );
    expect(mapped?.key).toBe("a");
    expect(mapped?.status).toBe("MERGE_FAILED");
    expect(mapped?.reason).toBe("merge failed: exit 128");
    expect(mapped?.gitExitCode).toBe(128);
    expect(mapped?.gitStderr).toBe("fatal: bad merge");
    expect(mapped?.sourceCommit).toBe("abc123");
    expect(mapped?.durationMs).toBe(42);
    expect(mapped?.emptyMerge).toBe(true);
  });

  it("preserves conflict files and merge commits", () => {
    const [mapped] = toScaleIntegrationItems(
      [item({ mergeCommit: "def456", testRunId: "tr1", conflictFiles: ["src/a.txt"] })],
      () => "a",
      "ATLAS_EVOLVING",
    );
    expect(mapped?.mergeCommit).toBe("def456");
    expect(mapped?.testRunId).toBe("tr1");
    expect(mapped?.conflictFiles).toEqual(["src/a.txt"]);
  });

  it("preserves SKIPPED_EMPTY with its empty-merge evidence", () => {
    const [mapped] = toScaleIntegrationItems(
      [item({ status: "SKIPPED_EMPTY", reason: "no changes over the integration base", emptyMerge: true, durationMs: 7 })],
      () => "a",
      "ATLAS_EVOLVING",
    );
    expect(mapped?.status).toBe("SKIPPED_EMPTY");
    expect(mapped?.emptyMerge).toBe(true);
    expect(mapped?.reason).toContain("no changes");
    expect(mapped?.durationMs).toBe(7);
  });

  it("maps absent evidence to null and folds the single-agent union key", () => {
    const [mapped] = toScaleIntegrationItems([item()], () => "single", "SINGLE_AGENT");
    expect(mapped?.key).toBe("single");
    expect(mapped?.reason).toBeNull();
    expect(mapped?.mergeCommit).toBeNull();
    expect(mapped?.testRunId).toBeNull();
    expect(mapped?.durationMs).toBeNull();
    expect(mapped?.conflictFiles).toBeNull();
    expect(mapped?.emptyMerge).toBeNull();
    expect(mapped?.gitExitCode).toBeNull();
    expect(mapped?.gitStderr).toBeNull();
    expect(mapped?.sourceCommit).toBeNull();
  });
});
