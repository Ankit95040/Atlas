import { describe, expect, it } from "vitest";
import { classifyTriageFindings } from "../src/triage/index.js";
import { TriageReportSchema } from "../src/triage/index.js";

function ownership(file: string, owners: string[]) {
  return { file, owners };
}

describe("triage classifier", () => {
  it("produces GIT_CONFLICT from Git-confirmed files", () => {
    const { classifications } = classifyTriageFindings({
      conflictFiles: ["src/a.txt"],
      ownership: [ownership("src/a.txt", ["task-b"])],
      claimOverlap: [],
      dependencyLinks: [],
      semanticFlags: [],
    });
    expect(classifications).toContain("GIT_CONFLICT");
  });

  it("produces CLAIM_CONFLICT from declared overlap", () => {
    const { classifications } = classifyTriageFindings({
      conflictFiles: [],
      ownership: [],
      claimOverlap: [{ taskA: "a", taskB: "b" }],
      dependencyLinks: [],
      semanticFlags: [],
    });
    expect(classifications).toContain("CLAIM_CONFLICT");
  });

  it("does not produce CLAIM_CONFLICT without claim overlap", () => {
    const { classifications } = classifyTriageFindings({
      conflictFiles: ["src/shared.txt"],
      ownership: [ownership("src/shared.txt", ["task-b"])],
      claimOverlap: [],
      dependencyLinks: [],
      semanticFlags: [],
    });
    expect(classifications).not.toContain("CLAIM_CONFLICT");
    expect(classifications).toContain("GIT_CONFLICT");
  });

  it("produces EMPTY_MERGE from a flagged empty merge (M19.3)", () => {
    const { classifications, recommendedActions } = classifyTriageFindings({
      conflictFiles: [],
      ownership: [],
      claimOverlap: [],
      dependencyLinks: [],
      semanticFlags: [],
      emptyMerges: ["task-empty"],
    });
    expect(classifications).toContain("EMPTY_MERGE");
    expect(classifications).not.toContain("GIT_CONFLICT");
    expect(recommendedActions.length).toBeGreaterThan(0);
  });

  it("does not produce EMPTY_MERGE without a flag", () => {
    const { classifications } = classifyTriageFindings({
      conflictFiles: [],
      ownership: [],
      claimOverlap: [],
      dependencyLinks: [],
      semanticFlags: [],
    });
    expect(classifications).not.toContain("EMPTY_MERGE");
    expect(classifications).toContain("UNKNOWN");
  });

  it("does not produce GIT_CONFLICT without Git-confirmed files", () => {
    const { classifications } = classifyTriageFindings({
      conflictFiles: [],
      ownership: [],
      claimOverlap: [{ taskA: "a", taskB: "b" }],
      dependencyLinks: [],
      semanticFlags: [],
    });
    expect(classifications).not.toContain("GIT_CONFLICT");
    expect(classifications).toContain("CLAIM_CONFLICT");
  });

  it("keeps dependency evidence directional", () => {
    const first = classifyTriageFindings({
      conflictFiles: [],
      ownership: [],
      claimOverlap: [],
      dependencyLinks: [{ taskId: "h", dependsOnTaskId: "o", direction: "halted-waits-for-owner" }],
      semanticFlags: [],
    });
    expect(first.classifications).toContain("DEPENDENCY_ORDERING");
    const second = classifyTriageFindings({
      conflictFiles: ["f"],
      ownership: [ownership("f", ["o"])],
      claimOverlap: [],
      dependencyLinks: [{ taskId: "o", dependsOnTaskId: "h", direction: "owner-waits-for-halted" }],
      semanticFlags: [],
    });
    expect(second.classifications).toEqual(["GIT_CONFLICT", "DEPENDENCY_ORDERING"]);
  });

  it("reports UNKNOWN rather than inventing ownership", () => {
    const { classifications } = classifyTriageFindings({
      conflictFiles: ["src/ghost.txt"],
      ownership: [ownership("src/ghost.txt", [])],
      claimOverlap: [],
      dependencyLinks: [],
      semanticFlags: [],
    });
    expect(classifications).toContain("UNKNOWN");
    expect(classifications).toContain("GIT_CONFLICT");
  });

  it("emits UNKNOWN when evidence is insufficient", () => {
    expect(
      classifyTriageFindings({ conflictFiles: [], ownership: [], claimOverlap: [], dependencyLinks: [], semanticFlags: [] })
        .classifications,
    ).toEqual(["UNKNOWN"]);
  });

  it("lets multiple classifications coexist in stable order", () => {
    const { classifications, recommendedActions } = classifyTriageFindings({
      conflictFiles: ["src/a.txt"],
      ownership: [ownership("src/a.txt", ["task-b"])],
      claimOverlap: [{ taskA: "task-a", taskB: "task-b" }],
      dependencyLinks: [{ taskId: "task-a", dependsOnTaskId: "task-b", direction: "halted-waits-for-owner" }],
      semanticFlags: [{ kind: "SHARED_WRITE_WITHOUT_TEXTUAL_CONFLICT", detail: "x", tasks: ["task-a"], notProven: true as const }],
    });
    expect(classifications).toEqual(["CLAIM_CONFLICT", "GIT_CONFLICT", "DEPENDENCY_ORDERING", "SEMANTIC_RISK"]);
    expect(recommendedActions).toEqual([...recommendedActions].sort());
    expect(new Set(recommendedActions).size).toBe(recommendedActions.length);
  });

  it("is deterministic on repeated identical input", () => {
    const input = {
      conflictFiles: ["src/b.txt", "src/a.txt"],
      ownership: [ownership("src/a.txt", ["t2", "t1"])],
      claimOverlap: [{ taskA: "t2", taskB: "t1" }],
      dependencyLinks: [],
      semanticFlags: [],
    };
    expect(classifyTriageFindings(input)).toEqual(classifyTriageFindings(input));
  });

  it("rejects semantic flags that do not disclaim proof", () => {
    expect(() =>
      TriageReportSchema.parse({
        repositoryId: "r",
        baseCommit: "abc1234",
        finalCommit: "abc1234",
        haltedTaskId: "h",
        haltedStatus: "CONFLICT",
        conflictFiles: [],
        ownership: [],
        claimOverlap: [],
        dependencyLinks: [],
        semanticFlags: [{ kind: "SHARED_WRITE_WITHOUT_TEXTUAL_CONFLICT", detail: "x", tasks: ["h"], notProven: false }],
        classifications: ["SEMANTIC_RISK"],
        recommendedActions: ["human-review-required"],
        evidenceRefs: { artifactId: "a", mergeCommits: [] },
        collectionNotes: [],
      }),
    ).toThrow();
  });
});
