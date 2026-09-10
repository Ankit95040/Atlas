import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { getPrismaClient } from "../src/db/client.js";
import { planSchedule } from "../src/dag/index.js";
import {
  FakePlannerProvider,
  PlannerInputSchema,
  runPlanner,
  toSchedulerInput,
  validatePlannerProposal,
  type PlannerProvider,
} from "../src/planner/index.js";

const db = getPrismaClient();

function validInput() {
  return { featureId: "feat-1", title: "Add login", description: "Let users sign in" };
}

function validProposal() {
  return {
    featureId: "feat-1",
    tasks: [
      { id: "t1", title: "Build login form", claims: [{ resource: "src/auth/login.ts", access: "WRITE" }] },
      { id: "t2", title: "Style dashboard", claims: [{ resource: "src/dashboard/page.tsx", access: "WRITE" }] },
    ],
    dependencies: [{ taskId: "t2", dependsOnTaskId: "t1" }],
    rationale: "Form first, then styling.",
  };
}

describe("planner contract", () => {
  it("validates planner input with defaults", () => {
    const parsed = PlannerInputSchema.parse(validInput());
    expect(parsed.featureId).toBe("feat-1");
    expect(parsed.resourceIds).toEqual([]);
    expect(parsed.existingTasks).toEqual([]);
  });

  it("rejects invalid planner input", () => {
    expect(() => PlannerInputSchema.parse({})).toThrow(ZodError);
    expect(() => PlannerInputSchema.parse({ featureId: "f", title: "  " })).toThrow(ZodError);
    expect(() => PlannerInputSchema.parse({ ...validInput(), unknownField: 1 })).toThrow(ZodError);
  });
});

describe("planner provider abstraction", () => {
  it("fake provider returns its proposal for validation", async () => {
    const plan = await runPlanner(validInput(), new FakePlannerProvider(validProposal()));
    expect(plan.kind).toBe("ValidatedPlannerPlan");
    expect(plan.tasks.map((task) => task.id)).toEqual(["t1", "t2"]);
  });

  it("validates input before the provider is ever called", async () => {
    let called = false;
    const provider: PlannerProvider = {
      generate: async () => {
        called = true;
        return validProposal();
      },
    };
    await expect(runPlanner({ featureId: "", title: "x" }, provider)).rejects.toThrow(ZodError);
    expect(called).toBe(false);
  });

  it("propagates provider failures without swallowing them", async () => {
    const provider: PlannerProvider = {
      generate: async () => {
        throw new Error("model exploded");
      },
    };
    await expect(runPlanner(validInput(), provider)).rejects.toThrow("model exploded");
  });

  it("rejects malformed provider output", async () => {
    for (const bad of [null, "nope", 42, [], {}, { tasks: [] }]) {
      await expect(runPlanner(validInput(), new FakePlannerProvider(bad))).rejects.toThrow(ZodError);
    }
  });
});

describe("planner orchestration boundary", () => {
  it("produces no executable surface and touches no database rows", async () => {
    const tasksBefore = await db.task.count();
    const workersBefore = await db.worker.count();
    const plan = await runPlanner(validInput(), new FakePlannerProvider(validProposal()));
    expect(plan).not.toHaveProperty("execute");
    expect(plan).not.toHaveProperty("assign");
    expect(plan).not.toHaveProperty("groups");
    expect(await db.task.count()).toBe(tasksBefore);
    expect(await db.worker.count()).toBe(workersBefore);
  });

  it("converts a validated plan into M6 scheduler input", async () => {
    const plan = await runPlanner(validInput(), new FakePlannerProvider(validProposal()));
    const execution = planSchedule(
      toSchedulerInput(plan, { workers: [{ id: "w1", status: "IDLE" }], maxConcurrency: 2 }),
    );
    expect(execution.groups.map((group) => group.tasks)).toEqual([["t1"]]);
    expect(execution.blockedTasks).toEqual([
      { taskId: "t2", reason: "BLOCKED_BY_DEPENDENCY", blockedBy: ["t1"] },
    ]);
  });

  it("lets the M6 scheduler — not the AI rationale — decide parallel vs serial", async () => {
    const proposal = {
      featureId: "feat-1",
      tasks: [
        { id: "t1", title: "One", claims: [{ resource: "src/shared.ts", access: "WRITE" }] },
        { id: "t2", title: "Two", claims: [{ resource: "src/shared.ts", access: "WRITE" }] },
      ],
      dependencies: [],
      rationale: "T1 and T2 are safe to run in parallel.",
      metadata: { parallel: ["t1", "t2"] },
    };
    const plan = await runPlanner(validInput(), new FakePlannerProvider(proposal));
    // Rationale/metadata survive validation (transparency) but authorize nothing.
    expect(plan.rationale).toContain("safe to run in parallel");
    const execution = planSchedule(
      toSchedulerInput(plan, {
        workers: [
          { id: "w1", status: "IDLE" },
          { id: "w2", status: "IDLE" },
        ],
        maxConcurrency: 2,
      }),
    );
    expect(execution.groups.map((group) => group.tasks)).toEqual([["t1"], ["t2"]]);
    expect(execution.resourceConflicts).toHaveLength(1);
    expect(execution.resourceConflicts[0]?.reason).toBe("SERIALIZED_RESOURCE_CONFLICT");
  });

  it("keeps raw proposals out of the scheduler by construction", () => {
    const raw = validProposal();
    // toSchedulerInput demands the validated discriminant, not the raw shape.
    expect(() => validatePlannerProposal(raw)).not.toThrow();
    const plan = validatePlannerProposal(raw);
    expect(plan.kind).toBe("ValidatedPlannerPlan");
    expect("kind" in raw).toBe(false);
  });
});
