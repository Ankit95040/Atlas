import { z } from "zod";
import { ArtifactType, EventType } from "@prisma/client";

// ---------- Shared primitives ----------

const nonEmpty = (label: string, max = 500): z.ZodString =>
  z.string().trim().min(1, `${label} must not be empty`).max(max, `${label} is too long`);

const optionalText = (label: string, max = 5000): z.ZodOptional<z.ZodString> =>
  z.string().trim().min(1, `${label} must not be empty`).max(max, `${label} is too long`).optional();

export const idSchema = z.string().trim().min(1, "id must not be empty");

/** Git SHA-like value: 7–40 lowercase/uppercase hex chars (full or abbreviated SHA). */
export const commitShaSchema = z
  .string()
  .trim()
  .regex(/^[0-9a-fA-F]{7,40}$/, "sha must be a Git SHA-like hex string (7-40 chars)");

/**
 * A resource claim: a filesystem path a task needs, plus the access mode.
 * Paths only — never file contents (AGENTS.md: resource claims over labels,
 * Atlas state separate from source code).
 */
export const resourceClaimSchema = z.object({
  path: nonEmpty("claim path", 1000),
  mode: z.enum(["read", "write"]),
});

export type ResourceClaim = z.infer<typeof resourceClaimSchema>;

/** Structured JSON-compatible metadata (event payloads, test-run metadata). */
const metadataSchema = z.record(z.unknown());

// ---------- Create / record inputs (validated at application boundaries) ----------

export const CreateProjectInput = z.object({
  name: nonEmpty("project name", 200),
  description: optionalText("project description"),
});

export const CreateRepositoryInput = z.object({
  projectId: idSchema,
  name: nonEmpty("repository name", 200),
  localPath: nonEmpty("repository local path", 1000),
  remoteUrl: optionalText("repository remote URL", 1000),
  defaultBranch: nonEmpty("default branch", 200).default("main"),
});

export const CreateFeatureInput = z.object({
  projectId: idSchema,
  title: nonEmpty("feature title", 300),
  description: optionalText("feature description"),
});

export const CreateTaskInput = z.object({
  featureId: idSchema,
  title: nonEmpty("task title", 300),
  description: optionalText("task description"),
  priority: z.number().int("priority must be an integer").min(0, "priority must be >= 0").default(0),
  resourceClaims: z.array(resourceClaimSchema).default([]),
});

export const CreateTaskDependencyInput = z
  .object({
    taskId: idSchema,
    dependsOnTaskId: idSchema,
  })
  .refine((value) => value.taskId !== value.dependsOnTaskId, {
    message: "a task cannot depend on itself",
  });

export const CreateWorkerInput = z.object({
  taskId: idSchema.optional(),
});

export const CreateWorkspaceInput = z.object({
  workerId: idSchema.optional(),
  path: nonEmpty("workspace path", 1000),
  branch: optionalText("workspace branch", 200),
});

export const CreateContractInput = z.object({
  taskId: idSchema,
  title: optionalText("contract title", 300),
  requirements: nonEmpty("contract requirements", 10000),
});

export const RecordArtifactInput = z.object({
  taskId: idSchema,
  type: z.nativeEnum(ArtifactType),
  label: optionalText("artifact label", 300),
  location: optionalText("artifact location", 1000),
  contentHash: optionalText("artifact content hash", 200),
});

export const RecordTestRunInput = z.object({
  taskId: idSchema,
  artifactId: idSchema.optional(),
  name: optionalText("test run name", 300),
  metadata: metadataSchema.optional(),
  exitCode: z.number().int().optional(),
});

export const RecordCommitInput = z.object({
  repositoryId: idSchema,
  sha: commitShaSchema,
  branch: optionalText("commit branch", 200),
  subject: optionalText("commit subject", 500),
  taskId: idSchema.optional(),
  workspaceId: idSchema.optional(),
});

export const RecordEventInput = z.object({
  type: z.nativeEnum(EventType),
  projectId: idSchema.optional(),
  featureId: idSchema.optional(),
  taskId: idSchema.optional(),
  actor: optionalText("event actor", 200),
  payload: metadataSchema.optional(),
});

export const CreateApprovalInput = z
  .object({
    featureId: idSchema.optional(),
    taskId: idSchema.optional(),
    context: optionalText("approval context", 1000),
    note: optionalText("approval note", 2000),
  })
  .refine((value) => value.featureId !== undefined || value.taskId !== undefined, {
    message: "approval must target a feature or a task",
  });

export const DecideApprovalInput = z.object({
  decision: z.enum(["APPROVED", "REJECTED"]),
  actor: nonEmpty("approval actor", 200),
  note: optionalText("approval note", 2000),
});

export type CreateProjectInput = z.infer<typeof CreateProjectInput>;
export type CreateRepositoryInput = z.infer<typeof CreateRepositoryInput>;
export type CreateFeatureInput = z.infer<typeof CreateFeatureInput>;
export type CreateTaskInput = z.infer<typeof CreateTaskInput>;
export type CreateTaskDependencyInput = z.infer<typeof CreateTaskDependencyInput>;
export type CreateWorkerInput = z.infer<typeof CreateWorkerInput>;
export type CreateWorkspaceInput = z.infer<typeof CreateWorkspaceInput>;
export type CreateContractInput = z.infer<typeof CreateContractInput>;
export type RecordArtifactInput = z.infer<typeof RecordArtifactInput>;
export type RecordTestRunInput = z.infer<typeof RecordTestRunInput>;
export type RecordCommitInput = z.infer<typeof RecordCommitInput>;
export type RecordEventInput = z.infer<typeof RecordEventInput>;
export type CreateApprovalInput = z.infer<typeof CreateApprovalInput>;
export type DecideApprovalInput = z.infer<typeof DecideApprovalInput>;
