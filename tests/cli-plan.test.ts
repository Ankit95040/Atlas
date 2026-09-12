import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getPrismaClient } from "../src/db/client.js";
import { createFeature, createProject } from "../src/core/service.js";
import { runPlanCommand } from "../src/cli/plan.js";
import { writeCommandError, writeCommandOutput } from "../src/cli/output.js";
import { track, uniqueName } from "./domain-helpers.js";
import { makeTempDir } from "./git-helpers.js";

const db = getPrismaClient();

async function setupFeature(): Promise<{ featureId: string }> {
  const project = await createProject({ name: uniqueName("m12-plan"), description: "cli plan test" }, db);
  track("project", project.id);
  const feature = await createFeature({ projectId: project.id, title: "plan feature" }, db);
  track("feature", feature.id);
  return { featureId: feature.id };
}

async function writeProposal(dir: string, featureId: string, overrides?: Record<string, unknown>): Promise<string> {
  const proposal = {
    featureId,
    tasks: [
      { id: "alpha", title: "Alpha task", claims: [{ resource: "src/alpha.txt", access: "WRITE" }] },
      { id: "beta", title: "Beta task", claims: [{ resource: "src/beta.txt", access: "WRITE" }], },
    ],
    dependencies: [{ taskId: "beta", dependsOnTaskId: "alpha" }],
    ...overrides,
  };
  const path = join(dir, `proposal-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}.json`);
  await writeFile(path, JSON.stringify(proposal));
  return path;
}

async function trackPlanScope(featureId: string): Promise<void> {
  const tasks = await db.task.findMany({ where: { featureId }, select: { id: true } });
  for (const task of tasks) track("task", task.id);
  for (const row of await db.taskDependency.findMany({ where: { taskId: { in: tasks.map((t) => t.id) } } })) {
    track("taskDependency", row.id);
  }
  for (const row of await db.approval.findMany({ where: { featureId } })) track("approval", row.id);
}

describe("atlas plan", () => {
  it("validates, persists, and previews a proposal without executing anything", async () => {
    const { featureId } = await setupFeature();
    const proposal = await writeProposal(await makeTempDir(), featureId);

    const output = await runPlanCommand({ featureId, proposal }, db);
    await trackPlanScope(featureId);

    expect(output.exitCode).toBe(0);
    const tasks = await db.task.findMany({ where: { featureId }, orderBy: { title: "asc" } });
    expect(tasks.map((task) => task.title)).toEqual(["Alpha task", "Beta task"]);
    expect(tasks.every((task) => task.status === "READY")).toBe(true);
    const approvals = await db.approval.findMany({ where: { featureId } });
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.status).toBe("PENDING");
    // No execution: no workers were ever assigned to these tasks.
    expect(await db.worker.findMany({ where: { taskId: { in: tasks.map((t) => t.id) } } })).toEqual([]);
    // Preview shows what can run now: alpha first, beta blocked on alpha.
    const preview = (output.data as { preview: { waves: string[][]; blocked: Array<{ taskId: string; reason: string }> } }).preview;
    expect(preview.waves).toEqual([["alpha"]]);
    expect(preview.blocked.map((entry) => `${entry.taskId}:${entry.reason}`)).toContain("beta:BLOCKED_BY_DEPENDENCY");
    expect(output.human).toContain("plan approval:");
  }, 60000);

  it("rejects malformed proposals with nothing persisted", async () => {
    const { featureId } = await setupFeature();
    const dir = await makeTempDir();
    const proposal = await writeProposal(dir, featureId, {
      tasks: [{ id: "bad", title: "Bad task", claims: [{ resource: "src/x.txt", access: "DELETE" }] }],
      dependencies: [],
    });

    await expect(runPlanCommand({ featureId, proposal }, db)).rejects.toThrow(/proposal rejected/);
    expect(await db.task.findMany({ where: { featureId } })).toEqual([]);
    expect(await db.approval.findMany({ where: { featureId } })).toEqual([]);
  }, 60000);

  it("refuses a proposal targeting a different feature", async () => {
    const { featureId } = await setupFeature();
    const { featureId: otherId } = await setupFeature();
    const proposal = await writeProposal(await makeTempDir(), otherId);

    await expect(runPlanCommand({ featureId, proposal }, db)).rejects.toThrow(/another feature's plan/);
    expect(await db.task.findMany({ where: { featureId } })).toEqual([]);
  }, 60000);

  it("refuses missing and non-JSON proposal files", async () => {
    const { featureId } = await setupFeature();
    await expect(runPlanCommand({ featureId, proposal: join(await makeTempDir(), "absent.json") }, db)).rejects.toThrow(
      /cannot read proposal file/,
    );
    const bad = join(await makeTempDir(), "bad.json");
    await writeFile(bad, "{not json");
    await expect(runPlanCommand({ featureId, proposal: bad }, db)).rejects.toThrow(/not valid JSON/);
  }, 60000);

  it("re-running the same file reuses the approval instead of duplicating tasks", async () => {
    const { featureId } = await setupFeature();
    const proposal = await writeProposal(await makeTempDir(), featureId);

    const first = await runPlanCommand({ featureId, proposal }, db);
    const second = await runPlanCommand({ featureId, proposal }, db);
    await trackPlanScope(featureId);

    const firstId = (first.data as { approval: { id: string } }).approval.id;
    const secondId = (second.data as { approval: { id: string } }).approval.id;
    expect(secondId).toBe(firstId);
    expect(await db.task.findMany({ where: { featureId } })).toHaveLength(2);
  }, 60000);

  it("approves explicitly with an actor and is idempotent on repeat", async () => {
    const { featureId } = await setupFeature();
    const proposal = await writeProposal(await makeTempDir(), featureId);

    await runPlanCommand({ featureId, proposal }, db);
    // Approving without naming the author is refused: nothing decided.
    await expect(runPlanCommand({ featureId, proposal, approve: true }, db)).rejects.toThrow(/--actor/);

    const approved = await runPlanCommand({ featureId, proposal, approve: true, actor: "ada" }, db);
    await trackPlanScope(featureId);
    expect((approved.data as { approval: { status: string } }).approval.status).toBe("APPROVED");

    // Re-approving an approved plan is a no-op report, not a second decision.
    const again = await runPlanCommand({ featureId, proposal, approve: true }, db);
    expect(again.human).toContain("already APPROVED");
    expect((again.data as { approval: { status: string } }).approval.status).toBe("APPROVED");
  }, 60000);

  it("refuses to approve when the file changed since planning", async () => {
    const { featureId } = await setupFeature();
    const dir = await makeTempDir();
    const proposal = await writeProposal(dir, featureId);
    await runPlanCommand({ featureId, proposal }, db);

    // Same feature, different bytes: no matching approval, tasks exist → refuse.
    const changed = await writeProposal(dir, featureId, {
      tasks: [{ id: "gamma", title: "Gamma task", claims: [{ resource: "src/gamma.txt", access: "WRITE" }] }],
      dependencies: [],
    });
    await expect(runPlanCommand({ featureId, proposal: changed, approve: true, actor: "ada" }, db)).rejects.toThrow(
      /already has .* task/,
    );
    await trackPlanScope(featureId);
  }, 60000);
});

describe("cli output helpers", () => {
  it("emits JSON envelopes and human text from the same result", () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (line: string): void => {
      lines.push(line);
    };
    try {
      writeCommandOutput({ exitCode: 0, human: "hello", data: { a: 1 } }, true);
      expect(JSON.parse(lines[0] as string)).toEqual({ ok: true, a: 1 });
      writeCommandOutput({ exitCode: 0, human: "hello", data: { a: 1 } }, false);
      expect(lines[1]).toBe("hello");
      writeCommandError(new Error("boom"), true);
      expect(JSON.parse(lines[2] as string)).toEqual({ ok: false, error: "boom" });
    } finally {
      console.log = original;
    }
  });
});
