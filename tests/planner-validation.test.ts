import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import type { RepositoryAnalysis } from "../src/analyzer/index.js";
import { InvalidResourceClaimError } from "../src/claims/index.js";
import { DependencyCycleError } from "../src/dag/index.js";
import { validatePlannerProposal } from "../src/planner/index.js";

function proposal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    featureId: "feat-1",
    tasks: [
      { id: "t1", title: "First task", claims: [{ resource: "src/a.ts", access: "WRITE" }] },
      { id: "t2", title: "Second task", claims: [{ resource: "src/b.ts", access: "READ" }] },
    ],
    dependencies: [{ taskId: "t2", dependsOnTaskId: "t1" }],
    ...overrides,
  };
}

function analysisWith(...ids: string[]): RepositoryAnalysis {
  return {
    repositoryRoot: "/repo",
    analyzedCommit: "abc1234",
    resourceCount: ids.length,
    resources: ids.map((id) => ({ id, kind: "FILE" as const })),
  };
}

describe("planner proposal validation boundary", () => {
  it("passes a valid proposal with normalized, sorted output", () => {
    const plan = validatePlannerProposal(proposal());
    expect(plan.kind).toBe("ValidatedPlannerPlan");
    expect(plan.featureId).toBe("feat-1");
    expect(plan.tasks.map((task) => task.id)).toEqual(["t1", "t2"]);
    expect(plan.tasks[0]?.claims).toEqual([{ resourceId: "src/a.ts", kind: "FILE", access: "WRITE" }]);
    expect(plan.dependencies).toEqual([{ taskId: "t2", dependsOnTaskId: "t1" }]);
  });

  it("rejects invalid task ids", () => {
    for (const badId of ["", "   ", "has space", "../x", "a/b", "-lead", "semi;colon"]) {
      expect(() =>
        validatePlannerProposal(
          proposal({ tasks: [{ id: badId, title: "T", claims: [] }] }),
        ),
      ).toThrow(ZodError);
    }
  });

  it("rejects duplicate task ids", () => {
    expect(() =>
      validatePlannerProposal(
        proposal({
          tasks: [
            { id: "t1", title: "One", claims: [] },
            { id: "t1", title: "Two", claims: [] },
          ],
        }),
      ),
    ).toThrow(/duplicate task id/);
  });

  it("rejects missing dependency targets", () => {
    expect(() =>
      validatePlannerProposal(proposal({ dependencies: [{ taskId: "t2", dependsOnTaskId: "ghost" }] })),
    ).toThrow(/unknown task/);
    expect(() =>
      validatePlannerProposal(proposal({ dependencies: [{ taskId: "ghost", dependsOnTaskId: "t1" }] })),
    ).toThrow(/unknown task/);
  });

  it("rejects self-dependencies", () => {
    expect(() =>
      validatePlannerProposal(proposal({ dependencies: [{ taskId: "t1", dependsOnTaskId: "t1" }] })),
    ).toThrow(/cannot depend on itself/);
  });

  it("rejects duplicate dependency edges", () => {
    const edge = { taskId: "t2", dependsOnTaskId: "t1" };
    expect(() => validatePlannerProposal(proposal({ dependencies: [edge, edge] }))).toThrow(
      /duplicate dependency/,
    );
  });

  it("rejects dependency cycles via the M6 graph", () => {
    expect(() =>
      validatePlannerProposal(
        proposal({
          dependencies: [
            { taskId: "t1", dependsOnTaskId: "t2" },
            { taskId: "t2", dependsOnTaskId: "t1" },
          ],
        }),
      ),
    ).toThrow(DependencyCycleError);
  });

  it("rejects invalid claim paths", () => {
    expect(() =>
      validatePlannerProposal(
        proposal({ tasks: [{ id: "t1", title: "T", claims: [{ resource: "", access: "WRITE" }] }] }),
      ),
    ).toThrow(ZodError);
    for (const bad of ["/abs/path", "../evil", "C:\\win", ".git/config"]) {
      expect(() =>
        validatePlannerProposal(
          proposal({
            tasks: [{ id: "t1", title: "T", claims: [{ resource: bad, access: "WRITE" }] }],
            dependencies: [],
          }),
        ),
      ).toThrow(InvalidResourceClaimError);
    }
  });

  it("rejects invalid access modes", () => {
    expect(() =>
      validatePlannerProposal(
        proposal({ tasks: [{ id: "t1", title: "T", claims: [{ resource: "src/a.ts", access: "" }] }] }),
      ),
    ).toThrow(ZodError);
    for (const bad of ["DELETE", "RW"]) {
      expect(() =>
        validatePlannerProposal(
          proposal({
            tasks: [{ id: "t1", title: "T", claims: [{ resource: "src/a.ts", access: bad }] }],
            dependencies: [],
          }),
        ),
      ).toThrow(InvalidResourceClaimError);
    }
  });

  it("keeps cross-feature task placement valid", () => {
    const plan = validatePlannerProposal(
      proposal({
        tasks: [
          { id: "t1", title: "One", featureId: "feat-a", claims: [] },
          { id: "t2", title: "Two", featureId: "feat-b", claims: [] },
        ],
        dependencies: [{ taskId: "t2", dependsOnTaskId: "t1" }],
      }),
    );
    expect(plan.tasks.map((task) => task.featureId)).toEqual(["feat-a", "feat-b"]);
    expect(plan.dependencies).toHaveLength(1);
  });

  it("does not turn resource conflicts into dependency edges", () => {
    const plan = validatePlannerProposal(
      proposal({
        tasks: [
          { id: "t1", title: "One", claims: [{ resource: "src/auth/", access: "WRITE" }] },
          { id: "t2", title: "Two", claims: [{ resource: "src/auth/session.ts", access: "WRITE" }] },
        ],
        dependencies: [],
      }),
    );
    expect(plan.dependencies).toEqual([]);
  });

  it("rejects empty titles, empty task lists, and extra fields", () => {
    expect(() =>
      validatePlannerProposal(proposal({ tasks: [{ id: "t1", title: "  ", claims: [] }] })),
    ).toThrow(ZodError);
    expect(() => validatePlannerProposal(proposal({ tasks: [] }))).toThrow(ZodError);
    expect(() =>
      validatePlannerProposal(
        proposal({ tasks: [{ id: "t1", title: "T", claims: [], bogus: true }] }),
      ),
    ).toThrow(ZodError);
    expect(() => validatePlannerProposal(proposal({ featureId: "feat-1", extra: 1 }))).toThrow(ZodError);
  });

  it("rejects malformed proposals wholesale", () => {
    for (const bad of [null, undefined, "nope", 42, [], {}, { tasks: "nope" }, { featureId: "f" }]) {
      expect(() => validatePlannerProposal(bad)).toThrow(ZodError);
    }
  });

  it("allows WRITE claims on future resources but not READ", () => {
    const analysis = analysisWith("src/a.ts");
    const writeNew = {
      tasks: [{ id: "t1", title: "T", claims: [{ resource: "src/new-file.ts", access: "WRITE" }] }],
      dependencies: [],
    };
    const plan = validatePlannerProposal(proposal(writeNew), { analysis });
    expect(plan.tasks).toHaveLength(1);
    expect(() =>
      validatePlannerProposal(
        proposal({
          tasks: [{ id: "t1", title: "T", claims: [{ resource: "src/new-file.ts", access: "READ" }] }],
          dependencies: [],
        }),
        { analysis },
      ),
    ).toThrow(InvalidResourceClaimError);
  });

  it("validates known resources against the analysis without requiring it", () => {
    const analysis = analysisWith("src/a.ts");
    const known = {
      tasks: [{ id: "t1", title: "T", claims: [{ resource: "src/a.ts", access: "READ" }] }],
      dependencies: [],
    };
    expect(() => validatePlannerProposal(proposal(known), { analysis })).not.toThrow();
    // Same proposal without analysis: existence unchecked, structure still valid.
    const unknownRead = {
      tasks: [{ id: "t1", title: "T", claims: [{ resource: "src/anything.ts", access: "READ" }] }],
      dependencies: [],
    };
    expect(() => validatePlannerProposal(proposal(unknownRead))).not.toThrow();
  });

  it("is deterministic across repeats and input orderings", () => {
    const first = validatePlannerProposal(proposal());
    expect(validatePlannerProposal(proposal())).toEqual(first);
    expect(JSON.stringify(validatePlannerProposal(proposal()))).toBe(JSON.stringify(first));
    const shuffled = validatePlannerProposal(
      proposal({
        tasks: [
          { id: "t2", title: "Second task", claims: [{ resource: "src/b.ts", access: "READ" }] },
          { id: "t1", title: "First task", claims: [{ resource: "src/a.ts", access: "WRITE" }] },
        ],
      }),
    );
    expect(shuffled).toEqual(first);
  });
});
