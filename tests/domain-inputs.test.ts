import { describe, expect, it } from "vitest";
import {
  CreateApprovalInput,
  CreateContractInput,
  CreateFeatureInput,
  CreateProjectInput,
  CreateRepositoryInput,
  CreateTaskDependencyInput,
  CreateTaskInput,
  CreateWorkspaceInput,
  DecideApprovalInput,
  RecordArtifactInput,
  RecordCommitInput,
  RecordEventInput,
  RecordTestRunInput,
} from "../src/core/inputs.js";

describe("domain input validation", () => {
  it("accepts a valid project and applies no hidden defaults", () => {
    const parsed = CreateProjectInput.parse({ name: " Atlas " });
    expect(parsed.name).toBe("Atlas");
    expect(parsed.description).toBeUndefined();
  });

  it("rejects empty or whitespace-only required fields", () => {
    expect(() => CreateProjectInput.parse({ name: "" })).toThrow();
    expect(() => CreateProjectInput.parse({ name: "   " })).toThrow();
    expect(() => CreateFeatureInput.parse({ projectId: "p1", title: "" })).toThrow();
    expect(() => CreateTaskInput.parse({ featureId: "f1", title: "  " })).toThrow();
    expect(() => CreateRepositoryInput.parse({ projectId: "p1", name: "r", localPath: "" })).toThrow();
    expect(() => CreateContractInput.parse({ taskId: "t1", requirements: "   " })).toThrow();
  });

  it("rejects empty ids", () => {
    expect(() => CreateFeatureInput.parse({ projectId: "", title: "x" })).toThrow();
    expect(() => CreateTaskInput.parse({ featureId: "", title: "x" })).toThrow();
  });

  it("applies task and repository defaults", () => {
    const task = CreateTaskInput.parse({ featureId: "f1", title: "t" });
    expect(task.priority).toBe(0);
    expect(task.resourceClaims).toEqual([]);
    const repo = CreateRepositoryInput.parse({ projectId: "p1", name: "r", localPath: "/tmp/r" });
    expect(repo.defaultBranch).toBe("main");
  });

  it("rejects negative or non-integer priority", () => {
    expect(() => CreateTaskInput.parse({ featureId: "f", title: "t", priority: -1 })).toThrow();
    expect(() => CreateTaskInput.parse({ featureId: "f", title: "t", priority: 1.5 })).toThrow();
  });

  it("validates resource claims", () => {
    const task = CreateTaskInput.parse({
      featureId: "f",
      title: "t",
      resourceClaims: [{ path: "src/payments/**", mode: "write" }],
    });
    expect(task.resourceClaims).toHaveLength(1);
    expect(() =>
      CreateTaskInput.parse({
        featureId: "f",
        title: "t",
        resourceClaims: [{ path: "", mode: "write" }],
      }),
    ).toThrow();
    expect(() =>
      CreateTaskInput.parse({
        featureId: "f",
        title: "t",
        resourceClaims: [{ path: "x", mode: "delete" }],
      }),
    ).toThrow();
  });

  it("rejects self-dependencies at the boundary", () => {
    expect(() => CreateTaskDependencyInput.parse({ taskId: "t1", dependsOnTaskId: "t1" })).toThrow(
      /cannot depend on itself/,
    );
    expect(CreateTaskDependencyInput.parse({ taskId: "t1", dependsOnTaskId: "t2" })).toEqual({
      taskId: "t1",
      dependsOnTaskId: "t2",
    });
  });

  it("validates commit SHAs as Git SHA-like values", () => {
    expect(RecordCommitInput.parse({ repositoryId: "r", sha: "abc1234" }).sha).toBe("abc1234");
    expect(
      RecordCommitInput.parse({ repositoryId: "r", sha: "da39a3ee5e6b4b0d3255bfef95601890afd80709" }).sha,
    ).toHaveLength(40);
    for (const bad of ["", "xyz", "abc", "zzzzzzz", "abc12345678901234567890123456789012345678901", "not a sha!"]) {
      expect(() => RecordCommitInput.parse({ repositoryId: "r", sha: bad })).toThrow();
    }
  });

  it("requires approvals to target a feature or a task", () => {
    expect(() => CreateApprovalInput.parse({})).toThrow(/must target a feature or a task/);
    expect(CreateApprovalInput.parse({ featureId: "f1" }).featureId).toBe("f1");
    expect(CreateApprovalInput.parse({ taskId: "t1" }).taskId).toBe("t1");
  });

  it("requires approval decisions to be explicit", () => {
    expect(() => DecideApprovalInput.parse({ decision: "PENDING", actor: "human" })).toThrow();
    expect(() => DecideApprovalInput.parse({ decision: "APPROVED", actor: "" })).toThrow();
    expect(() => DecideApprovalInput.parse({ decision: "APPROVED", actor: "  " })).toThrow();
    expect(DecideApprovalInput.parse({ decision: "REJECTED", actor: "tech-lead" }).decision).toBe("REJECTED");
  });

  it("validates event, artifact, test-run, and workspace inputs", () => {
    expect(RecordEventInput.parse({ type: "TASK_CREATED", taskId: "t1" }).type).toBe("TASK_CREATED");
    expect(() => RecordEventInput.parse({ type: "SOMETHING_ELSE" })).toThrow();
    expect(RecordArtifactInput.parse({ taskId: "t1", type: "TEST_REPORT" }).type).toBe("TEST_REPORT");
    expect(() => RecordArtifactInput.parse({ taskId: "t1", type: "SOURCE_BLOB" })).toThrow();
    expect(RecordTestRunInput.parse({ taskId: "t1" }).taskId).toBe("t1");
    expect(() => CreateWorkspaceInput.parse({ path: "" })).toThrow();
  });
});
