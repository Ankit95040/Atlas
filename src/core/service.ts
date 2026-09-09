import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { getPrismaClient } from "../db/client.js";
import {
  CreateApprovalInput,
  CreateContractInput,
  CreateFeatureInput,
  CreateProjectInput,
  CreateRepositoryInput,
  CreateTaskDependencyInput,
  CreateTaskInput,
  CreateWorkerInput,
  CreateWorkspaceInput,
  DecideApprovalInput,
  RecordArtifactInput,
  RecordCommitInput,
  RecordEventInput,
  RecordTestRunInput,
} from "./inputs.js";
import {
  APPROVAL_TRANSITIONS,
  FEATURE_TRANSITIONS,
  PROJECT_TRANSITIONS,
  TASK_TRANSITIONS,
  TEST_RUN_TRANSITIONS,
  WORKER_TRANSITIONS,
  WORKSPACE_TRANSITIONS,
  assertTransition,
  type TransitionMap,
} from "./transitions.js";
import { InvalidTransitionError, InvariantViolationError, NotFoundError } from "./errors.js";
import {
  assertNoSelfDependency,
  assertSameFeature,
  serializeMetadata,
  serializeResourceClaims,
  stripUndefined,
} from "./validation.js";

function mapUniqueViolation(error: unknown, message: string): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    throw new InvariantViolationError(message);
  }
  throw error;
}

// ---------- Creation (Zod-validated, FK integrity enforced by the database) ----------

export async function createProject(raw: unknown, db: PrismaClient = getPrismaClient()) {
  const input = CreateProjectInput.parse(raw);
  return db.project.create({ data: stripUndefined(input) });
}

export async function createRepository(raw: unknown, db: PrismaClient = getPrismaClient()) {
  const input = CreateRepositoryInput.parse(raw);
  try {
    return await db.repository.create({ data: stripUndefined(input) });
  } catch (error) {
    return mapUniqueViolation(error, "repository name already exists in this project");
  }
}

export async function createFeature(raw: unknown, db: PrismaClient = getPrismaClient()) {
  const input = CreateFeatureInput.parse(raw);
  return db.feature.create({ data: stripUndefined(input) });
}

export async function createTask(raw: unknown, db: PrismaClient = getPrismaClient()) {
  const input = CreateTaskInput.parse(raw);
  const { resourceClaims, ...rest } = input;
  return db.task.create({
    data: stripUndefined({ ...rest, resourceClaims: serializeResourceClaims(resourceClaims) }),
  });
}

export async function createTaskDependency(raw: unknown, db: PrismaClient = getPrismaClient()) {
  const input = CreateTaskDependencyInput.parse(raw);
  assertNoSelfDependency(input.taskId, input.dependsOnTaskId);

  const [task, prerequisite] = await Promise.all([
    db.task.findUnique({ where: { id: input.taskId } }),
    db.task.findUnique({ where: { id: input.dependsOnTaskId } }),
  ]);
  if (task === null) {
    throw new NotFoundError("Task", input.taskId);
  }
  if (prerequisite === null) {
    throw new NotFoundError("Task", input.dependsOnTaskId);
  }
  assertSameFeature(task.featureId, prerequisite.featureId);

  try {
    return await db.taskDependency.create({ data: stripUndefined(input) });
  } catch (error) {
    return mapUniqueViolation(error, "task dependency already exists");
  }
}

export async function createWorker(raw: unknown, db: PrismaClient = getPrismaClient()) {
  const input = CreateWorkerInput.parse(raw);
  return db.worker.create({ data: stripUndefined(input) });
}

export async function createWorkspace(raw: unknown, db: PrismaClient = getPrismaClient()) {
  const input = CreateWorkspaceInput.parse(raw);
  return db.workspace.create({ data: stripUndefined(input) });
}

export async function createContract(raw: unknown, db: PrismaClient = getPrismaClient()) {
  const input = CreateContractInput.parse(raw);
  try {
    return await db.contract.create({ data: stripUndefined(input) });
  } catch (error) {
    return mapUniqueViolation(error, "task already has a contract");
  }
}

export async function recordArtifact(raw: unknown, db: PrismaClient = getPrismaClient()) {
  const input = RecordArtifactInput.parse(raw);
  return db.artifact.create({ data: stripUndefined(input) });
}

export async function recordTestRun(raw: unknown, db: PrismaClient = getPrismaClient()) {
  const input = RecordTestRunInput.parse(raw);
  const { metadata, ...rest } = input;
  return db.testRun.create({
    data: stripUndefined({ ...rest, status: "PENDING", metadata: serializeMetadata(metadata) }),
  });
}

export async function recordCommit(raw: unknown, db: PrismaClient = getPrismaClient()) {
  const input = RecordCommitInput.parse(raw);
  try {
    return await db.commit.create({ data: stripUndefined(input) });
  } catch (error) {
    return mapUniqueViolation(error, "commit SHA already recorded for this repository");
  }
}

/** Events are append-only: this module exposes no update or delete for events. */
export async function recordEvent(raw: unknown, db: PrismaClient = getPrismaClient()) {
  const input = RecordEventInput.parse(raw);
  const { payload, ...rest } = input;
  return db.event.create({
    data: stripUndefined({ ...rest, payload: serializeMetadata(payload) }),
  });
}

/** Approvals are created PENDING; the explicit decision happens via decideApproval. */
export async function createApproval(raw: unknown, db: PrismaClient = getPrismaClient()) {
  const input = CreateApprovalInput.parse(raw);
  return db.approval.create({ data: stripUndefined({ ...input, status: "PENDING" }) });
}

export async function decideApproval(id: string, raw: unknown, db: PrismaClient = getPrismaClient()) {
  const input = DecideApprovalInput.parse(raw);
  const approval = await db.approval.findUnique({ where: { id } });
  if (approval === null) {
    throw new NotFoundError("Approval", id);
  }
  if (approval.status !== "PENDING") {
    throw new InvalidTransitionError("Approval", approval.status, input.decision);
  }
  return db.approval.update({
    where: { id },
    data: stripUndefined({
      status: input.decision,
      actor: input.actor,
      note: input.note,
      decidedAt: new Date(),
    }),
  });
}

// ---------- Explicit state transitions ----------

interface StatusHolder<S extends string> {
  status: S;
}

async function applyTransition<S extends string, Model extends StatusHolder<S>>(
  entity: string,
  current: Model | null,
  id: string,
  to: S,
  allowed: TransitionMap<S>,
  persist: (current: Model, next: S) => Promise<Model>,
): Promise<Model> {
  if (current === null) {
    throw new NotFoundError(entity, id);
  }
  assertTransition(entity, current.status, to, allowed);
  if (current.status === to) {
    return current;
  }
  return persist(current, to);
}

export async function transitionProject(id: string, to: "ACTIVE" | "PAUSED" | "ARCHIVED", db = getPrismaClient()) {
  const current = await db.project.findUnique({ where: { id } });
  return applyTransition("Project", current, id, to, PROJECT_TRANSITIONS, (_current, status) =>
    db.project.update({ where: { id }, data: { status } }),
  );
}

export async function transitionFeature(
  id: string,
  to: "DRAFT" | "PLANNED" | "READY" | "IN_PROGRESS" | "VERIFICATION" | "COMPLETED" | "CANCELLED",
  db = getPrismaClient(),
) {
  const current = await db.feature.findUnique({ where: { id } });
  return applyTransition("Feature", current, id, to, FEATURE_TRANSITIONS, (_current, status) =>
    db.feature.update({ where: { id }, data: { status } }),
  );
}

export async function transitionTask(
  id: string,
  to: "PENDING" | "READY" | "CLAIMED" | "IN_PROGRESS" | "BLOCKED" | "VERIFICATION" | "COMPLETED" | "FAILED" | "CANCELLED",
  db = getPrismaClient(),
) {
  const current = await db.task.findUnique({ where: { id } });
  return applyTransition("Task", current, id, to, TASK_TRANSITIONS, (_current, status) =>
    db.task.update({ where: { id }, data: { status } }),
  );
}

export async function transitionWorker(
  id: string,
  to: "IDLE" | "ASSIGNED" | "RUNNING" | "VERIFYING" | "COMPLETED" | "FAILED" | "STOPPED",
  db = getPrismaClient(),
) {
  const current = await db.worker.findUnique({ where: { id } });
  return applyTransition("Worker", current, id, to, WORKER_TRANSITIONS, (_current, status) =>
    db.worker.update({ where: { id }, data: { status } }),
  );
}

export async function transitionWorkspace(
  id: string,
  to: "CREATING" | "READY" | "IN_USE" | "VERIFYING" | "CLEANED" | "FAILED",
  db = getPrismaClient(),
) {
  const current = await db.workspace.findUnique({ where: { id } });
  return applyTransition("Workspace", current, id, to, WORKSPACE_TRANSITIONS, (_current, status) =>
    db.workspace.update({ where: { id }, data: { status } }),
  );
}

const TERMINAL_TEST_RUN_STATES = new Set(["PASSED", "FAILED", "CANCELLED"]);

export async function transitionTestRun(
  id: string,
  to: "PENDING" | "RUNNING" | "PASSED" | "FAILED" | "CANCELLED",
  db = getPrismaClient(),
) {
  const current = await db.testRun.findUnique({ where: { id } });
  return applyTransition("TestRun", current, id, to, TEST_RUN_TRANSITIONS, (record, status) => {
    const now = new Date();
    return db.testRun.update({
      where: { id },
      data: {
        status,
        startedAt: to === "RUNNING" ? (record.startedAt ?? now) : record.startedAt,
        finishedAt: TERMINAL_TEST_RUN_STATES.has(to) ? (record.finishedAt ?? now) : record.finishedAt,
      },
    });
  });
}
