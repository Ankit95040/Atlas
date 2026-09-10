import { describe, expect, it } from "vitest";
import * as service from "../src/core/service.js";
import { parseResourceClaims } from "../src/core/validation.js";
import { DomainError, InvalidTransitionError, InvariantViolationError, NotFoundError } from "../src/core/errors.js";
import { getPrismaClient } from "../src/db/client.js";
import { track, uniqueName } from "./domain-helpers.js";

const db = getPrismaClient();

async function createChain(suffix: string) {
  const project = await service.createProject({ name: uniqueName(`proj-${suffix}`) });
  track("project", project.id);
  const repository = await service.createRepository({
    projectId: project.id,
    name: "main-repo",
    localPath: `/tmp/atlas-${project.id}`,
  });
  track("repository", repository.id);
  const feature = await service.createFeature({ projectId: project.id, title: "Checkout flow" });
  track("feature", feature.id);
  const task = await service.createTask({
    featureId: feature.id,
    title: "Implement cart",
    resourceClaims: [{ path: "src/cart/**", mode: "write" }],
  });
  track("task", task.id);
  return { project, repository, feature, task };
}

describe("domain persistence and invariants", () => {
  it("creates the Project → Repository → Feature → Task chain with relations", async () => {
    const { project, repository, feature, task } = await createChain("chain");

    const loaded = await db.project.findUniqueOrThrow({
      where: { id: project.id },
      include: { repositories: true, features: { include: { tasks: true } } },
    });
    expect(loaded.repositories.map((r) => r.id)).toContain(repository.id);
    expect(loaded.features.map((f) => f.id)).toContain(feature.id);
    expect(loaded.features.find((f) => f.id === feature.id)?.tasks.map((t) => t.id)).toContain(task.id);
    expect(repository.projectId).toBe(project.id);
    expect(feature.projectId).toBe(project.id);
    expect(task.featureId).toBe(feature.id);

    const claims = parseResourceClaims(task.resourceClaims);
    expect(claims).toEqual([{ path: "src/cart/**", mode: "write" }]);
  });

  it("rejects children with unknown parents (FK integrity)", async () => {
    await expect(service.createRepository({ projectId: "missing", name: "r", localPath: "/x" })).rejects.toThrow();
    await expect(service.createFeature({ projectId: "missing", title: "f" })).rejects.toThrow();
    await expect(service.createTask({ featureId: "missing", title: "t" })).rejects.toThrow();
  });

  it("rejects duplicate repository names within one project", async () => {
    const { project } = await createChain("dup-repo");
    await expect(
      service.createRepository({ projectId: project.id, name: "main-repo", localPath: "/tmp/other" }),
    ).rejects.toThrow(InvariantViolationError);
  });

  it("creates directed task dependencies with both navigation directions", async () => {
    const { task } = await createChain("dep");
    const other = await service.createTask({ featureId: task.featureId, title: "Second task" });
    track("task", other.id);

    const edge = await service.createTaskDependency({ taskId: other.id, dependsOnTaskId: task.id });
    track("taskDependency", edge.id);

    const loaded = await db.task.findUniqueOrThrow({
      where: { id: other.id },
      include: { dependencies: { include: { dependsOn: true } } },
    });
    expect(loaded.dependencies.map((d) => d.dependsOn.id)).toEqual([task.id]);

    const prerequisite = await db.task.findUniqueOrThrow({
      where: { id: task.id },
      include: { dependents: true },
    });
    expect(prerequisite.dependents.map((d) => d.taskId)).toEqual([other.id]);
  });

  it("rejects self-dependencies, duplicates, and unknown tasks, and allows cross-feature edges", async () => {
    const { task } = await createChain("dep-bad");
    const sibling = await service.createTask({ featureId: task.featureId, title: "Sibling" });
    track("task", sibling.id);
    const { feature: otherFeature } = await createChain("dep-other");
    const outsider = await service.createTask({ featureId: otherFeature.id, title: "Outsider" });
    track("task", outsider.id);

    await expect(
      service.createTaskDependency({ taskId: task.id, dependsOnTaskId: task.id }),
    ).rejects.toThrow(/cannot depend on itself/);
    // Cross-feature dependencies are valid as of M6: the DAG spans features.
    const crossEdge = await service.createTaskDependency({ taskId: task.id, dependsOnTaskId: outsider.id });
    track("taskDependency", crossEdge.id);
    expect(crossEdge.taskId).toBe(task.id);
    expect(crossEdge.dependsOnTaskId).toBe(outsider.id);
    await expect(
      service.createTaskDependency({ taskId: "missing", dependsOnTaskId: task.id }),
    ).rejects.toThrow(NotFoundError);

    const edge = await service.createTaskDependency({ taskId: sibling.id, dependsOnTaskId: task.id });
    track("taskDependency", edge.id);
    await expect(
      service.createTaskDependency({ taskId: sibling.id, dependsOnTaskId: task.id }),
    ).rejects.toThrow(InvariantViolationError);
  });

  it("transitions features along valid paths and rejects invalid ones", async () => {
    const { feature } = await createChain("feat-trans");
    expect((await service.transitionFeature(feature.id, "PLANNED")).status).toBe("PLANNED");
    expect((await service.transitionFeature(feature.id, "READY")).status).toBe("READY");
    await expect(service.transitionFeature(feature.id, "COMPLETED")).rejects.toThrow(InvalidTransitionError);
    await expect(service.transitionFeature("missing", "PLANNED")).rejects.toThrow(NotFoundError);
  });

  it("transitions tasks and projects along valid paths and rejects invalid ones", async () => {
    const { project, task } = await createChain("task-trans");
    expect((await service.transitionTask(task.id, "READY")).status).toBe("READY");
    expect((await service.transitionTask(task.id, "CLAIMED")).status).toBe("CLAIMED");
    await expect(service.transitionTask(task.id, "COMPLETED")).rejects.toThrow(InvalidTransitionError);
    await expect(service.transitionTask("missing", "READY")).rejects.toThrow(NotFoundError);

    expect((await service.transitionProject(project.id, "PAUSED")).status).toBe("PAUSED");
    await expect(service.transitionProject(project.id, "COMPLETED" as never)).rejects.toThrow();
  });

  it("runs worker and workspace lifecycles with task/worker links", async () => {
    const { task } = await createChain("worker");
    const worker = await service.createWorker({ taskId: task.id });
    track("worker", worker.id);
    expect(worker.status).toBe("IDLE");
    expect((await service.transitionWorker(worker.id, "ASSIGNED")).status).toBe("ASSIGNED");
    await expect(service.transitionWorker(worker.id, "COMPLETED")).rejects.toThrow(InvalidTransitionError);

    const workspace = await service.createWorkspace({ workerId: worker.id, path: `/tmp/ws-${worker.id}` });
    track("workspace", workspace.id);
    expect(workspace.status).toBe("CREATING");
    expect((await service.transitionWorkspace(workspace.id, "READY")).status).toBe("READY");
    expect((await service.transitionWorkspace(workspace.id, "IN_USE")).status).toBe("IN_USE");

    const loaded = await db.worker.findUniqueOrThrow({
      where: { id: worker.id },
      include: { task: true, workspace: true },
    });
    expect(loaded.task?.id).toBe(task.id);
    expect(loaded.workspace?.id).toBe(workspace.id);
  });

  it("records append-only events with structured metadata", async () => {
    const { project, feature, task } = await createChain("event");
    const event = await service.recordEvent({
      type: "TASK_CREATED",
      projectId: project.id,
      featureId: feature.id,
      taskId: task.id,
      actor: "planner",
      payload: { source: "milestone-2-test" },
    });
    track("event", event.id);

    const stored = await db.event.findUniqueOrThrow({ where: { id: event.id } });
    expect(stored.type).toBe("TASK_CREATED");
    expect(JSON.parse(stored.payload ?? "{}") as unknown).toEqual({ source: "milestone-2-test" });

    // Append-only at the application layer: no update/delete API is exposed.
    expect("updateEvent" in service).toBe(false);
    expect("deleteEvent" in service).toBe(false);
  });

  it("requires explicit human approval decisions exactly once", async () => {
    const { task } = await createChain("approval");
    const approval = await service.createApproval({ taskId: task.id, context: "merge to main" });
    track("approval", approval.id);
    expect(approval.status).toBe("PENDING");
    expect(approval.actor).toBeNull();
    expect(approval.decidedAt).toBeNull();

    const decided = await service.decideApproval(approval.id, { decision: "APPROVED", actor: "tech-lead" });
    expect(decided.status).toBe("APPROVED");
    expect(decided.actor).toBe("tech-lead");
    expect(decided.decidedAt).toBeInstanceOf(Date);

    await expect(
      service.decideApproval(approval.id, { decision: "REJECTED", actor: "tech-lead" }),
    ).rejects.toThrow(InvalidTransitionError);
    await expect(service.decideApproval("missing", { decision: "APPROVED", actor: "x" })).rejects.toThrow(
      NotFoundError,
    );
  });

  it("runs test runs from PENDING with deterministic timestamps", async () => {
    const { task } = await createChain("testrun");
    const run = await service.recordTestRun({ taskId: task.id, name: "unit", metadata: { suite: "unit" } });
    track("testRun", run.id);
    expect(run.status).toBe("PENDING");
    expect(run.startedAt).toBeNull();

    const running = await service.transitionTestRun(run.id, "RUNNING");
    expect(running.startedAt).toBeInstanceOf(Date);
    expect(running.finishedAt).toBeNull();

    const passed = await service.transitionTestRun(run.id, "PASSED");
    expect(passed.finishedAt).toBeInstanceOf(Date);

    await expect(service.transitionTestRun(run.id, "RUNNING")).rejects.toThrow(InvalidTransitionError);
  });

  it("records artifacts as references, never source blobs", async () => {
    const { task } = await createChain("artifact");
    const artifact = await service.recordArtifact({
      taskId: task.id,
      type: "PATCH",
      label: "cart patch",
      location: "/tmp/artifacts/cart.patch",
      contentHash: "abc1234",
    });
    track("artifact", artifact.id);
    expect(artifact.type).toBe("PATCH");
    expect(artifact.location).toBe("/tmp/artifacts/cart.patch");
  });

  it("allows exactly one contract per task", async () => {
    const { task } = await createChain("contract");
    const contract = await service.createContract({ taskId: task.id, requirements: "Cart must total items." });
    track("contract", contract.id);
    expect(contract.requirements).toContain("Cart");
    await expect(
      service.createContract({ taskId: task.id, requirements: "Second contract." }),
    ).rejects.toThrow(InvariantViolationError);
  });

  it("records commit metadata with SHA validation and per-repo uniqueness", async () => {
    const { repository, task } = await createChain("commit");
    const sha = "da39a3ee5e6b4b0d3255bfef95601890afd80709";
    const commit = await service.recordCommit({
      repositoryId: repository.id,
      taskId: task.id,
      sha,
      branch: "feat/cart",
      subject: "Add cart total",
    });
    track("commit", commit.id);
    expect(commit.sha).toBe(sha);

    await expect(service.recordCommit({ repositoryId: repository.id, sha: "not-a-sha" })).rejects.toThrow();
    await expect(service.recordCommit({ repositoryId: repository.id, sha })).rejects.toThrow(
      InvariantViolationError,
    );

    // Same SHA in a different repository is a different record.
    const { repository: otherRepo } = await createChain("commit-other");
    const other = await service.recordCommit({ repositoryId: otherRepo.id, sha });
    track("commit", other.id);
    expect(other.id).not.toBe(commit.id);
  });

  it("rejects unknown-entity transitions with NotFoundError", async () => {
    await expect(service.transitionWorker("missing", "ASSIGNED")).rejects.toThrow(NotFoundError);
    await expect(service.transitionWorkspace("missing", "READY")).rejects.toThrow(NotFoundError);
    await expect(service.transitionTestRun("missing", "RUNNING")).rejects.toThrow(NotFoundError);
  });
});
