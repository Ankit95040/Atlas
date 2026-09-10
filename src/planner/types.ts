import { z } from "zod";
import { TaskStatus } from "@prisma/client";
import { commitShaSchema, idSchema } from "../core/inputs.js";
import type { NormalizedClaim } from "../claims/types.js";

// ---------- Shared primitives (mirrors core/inputs conventions) ----------

const titleSchema = (label: string, max: number): z.ZodString =>
  z.string().trim().min(1, `${label} must not be empty`).max(max, `${label} is too long`);

const optionalText = (label: string, max: number): z.ZodOptional<z.ZodString> =>
  z.string().trim().min(1, `${label} must not be empty`).max(max, `${label} is too long`).optional();

/**
 * Atlas task identifier rules for proposals: trimmed, non-empty, bounded,
 * charset-restricted (letters/digits/dash/underscore, leading alnum) so ids
 * can never smuggle paths, whitespace, or shell syntax. Deliberately
 * independent of cuid generation — proposals predate persistence.
 */
const proposalTaskIdSchema = z
  .string()
  .trim()
  .min(1, "task id must not be empty")
  .max(200, "task id is too long")
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, "task id must be alphanumeric with dashes/underscores");

// ---------- PlannerInput: serializable, validated context for the provider ----------

export const PlannerInputSchema = z
  .object({
    featureId: idSchema,
    title: titleSchema("feature title", 300),
    description: optionalText("feature description", 5000),
    projectId: idSchema.optional(),
    repositoryId: idSchema.optional(),
    analyzedCommit: commitShaSchema.optional(),
    /** Known relevant resource ids (never file contents). */
    resourceIds: z.array(z.string().trim().min(1).max(1000)).default([]),
    /** Already-existing tasks the provider should build on, not duplicate. */
    existingTasks: z
      .array(
        z
          .object({ id: idSchema, status: z.nativeEnum(TaskStatus) })
          .strict(),
      )
      .default([]),
  })
  .strict();

export type PlannerInput = z.infer<typeof PlannerInputSchema>;

// ---------- PlannerProposal: UNTRUSTED provider output, strict shape ----------

const ProposedClaimSchema = z
  .object({
    resource: z.string().trim().min(1, "claim resource must not be empty").max(1000),
    access: z.string().trim().min(1, "claim access must not be empty"),
  })
  .strict();

const ProposedTaskSchema = z
  .object({
    id: proposalTaskIdSchema,
    title: titleSchema("task title", 300),
    description: optionalText("task description", 5000),
    /** Future persistence placement. No same-feature constraint is enforced. */
    featureId: idSchema.optional(),
    claims: z.array(ProposedClaimSchema).default([]),
  })
  .strict();

const ProposedDependencySchema = z
  .object({ taskId: proposalTaskIdSchema, dependsOnTaskId: proposalTaskIdSchema })
  .strict();

export const PlannerProposalSchema = z
  .object({
    featureId: idSchema,
    tasks: z
      .array(ProposedTaskSchema)
      .min(1, "proposal must contain at least one task")
      .max(500, "too many tasks in one proposal"),
    dependencies: z.array(ProposedDependencySchema).max(2000, "too many dependencies in one proposal").default([]),
    rationale: z.string().max(5000, "rationale is too long").optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict()
  .superRefine((proposal, ctx) => {
    const seenTasks = new Set<string>();
    for (const task of proposal.tasks) {
      if (seenTasks.has(task.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate task id: ${task.id}`, path: ["tasks"] });
      }
      seenTasks.add(task.id);
    }
    const seenEdges = new Set<string>();
    proposal.dependencies.forEach((edge, index) => {
      const path = ["dependencies", index];
      if (edge.taskId === edge.dependsOnTaskId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a task cannot depend on itself", path });
      }
      if (!seenTasks.has(edge.taskId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `dependency references unknown task: ${edge.taskId}`,
          path,
        });
      }
      if (!seenTasks.has(edge.dependsOnTaskId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `dependency references unknown task: ${edge.dependsOnTaskId}`,
          path,
        });
      }
      const key = `${edge.taskId}→${edge.dependsOnTaskId}`;
      if (seenEdges.has(key)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate dependency: ${key}`, path });
      }
      seenEdges.add(key);
    });
  });

export type PlannerProposal = z.infer<typeof PlannerProposalSchema>;

// ---------- ValidatedPlannerPlan: proof that validation ran ----------

export interface ValidatedTask {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly featureId?: string;
  readonly claims: NormalizedClaim[];
}

export interface ValidatedDependency {
  readonly taskId: string;
  readonly dependsOnTaskId: string;
}

/**
 * The trust boundary made tangible: only `validatePlannerProposal` can
 * produce this shape (discriminant + normalized contents), and only this
 * shape converts into M6 scheduler input. A raw PlannerProposal — however
 * plausible — is never executable.
 */
export interface ValidatedPlannerPlan {
  readonly kind: "ValidatedPlannerPlan";
  readonly featureId: string;
  readonly tasks: readonly ValidatedTask[];
  readonly dependencies: readonly ValidatedDependency[];
  readonly rationale?: string;
  readonly metadata?: Record<string, unknown>;
}
