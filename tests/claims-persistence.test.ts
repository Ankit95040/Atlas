import { describe, expect, it } from "vitest";
import { NotFoundError } from "../src/core/errors.js";
import * as core from "../src/core/service.js";
import { getPrismaClient } from "../src/db/client.js";
import { analyzeRepository } from "../src/analyzer/index.js";
import {
  InvalidResourceClaimError,
  checkTaskPair,
  createTaskClaims,
  getTaskClaims,
  readTaskClaims,
  validateClaimsAgainstAnalysis,
} from "../src/claims/index.js";
import { track, uniqueName } from "./domain-helpers.js";
import { initTempRepo } from "./git-helpers.js";

const db = getPrismaClient();

async function setupTask(suffix: string) {
  const project = await core.createProject({ name: uniqueName(`claims-${suffix}`) });
  track("project", project.id);
  const feature = await core.createFeature({ projectId: project.id, title: `feat-${suffix}` });
  track("feature", feature.id);
  const task = await core.createTask({ featureId: feature.id, title: `task-${suffix}` });
  track("task", task.id);
  return { project, feature, task };
}

describe("claim persistence", () => {
  it("persists explicit claims and reads them back normalized", async () => {
    const { task } = await setupTask("roundtrip");
    const claims = await createTaskClaims({
      taskId: task.id,
      claims: [
        { resource: "./src/auth/login.ts", access: "write" },
        { resource: "src/auth/types.ts", access: "READ" },
      ],
    });
    expect(claims).toEqual([
      { resourceId: "src/auth/login.ts", kind: "FILE", access: "WRITE" },
      { resourceId: "src/auth/types.ts", kind: "FILE", access: "READ" },
    ]);
    expect(await getTaskClaims(task.id)).toEqual(claims);

    const stored = await db.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(JSON.parse(stored.resourceClaims)).toEqual([
      { path: "src/auth/login.ts", mode: "WRITE" },
      { path: "src/auth/types.ts", mode: "READ" },
    ]);
  });

  it("is idempotent and deduplicates repeated submissions", async () => {
    const { task } = await setupTask("idem");
    const input = {
      taskId: task.id,
      claims: [
        { resource: "src/a.ts", access: "WRITE" as const },
        { resource: "src/a.ts", access: "WRITE" as const },
        { resource: "src/b.ts", access: "READ" as const },
      ],
    };
    const first = await createTaskClaims(input);
    const before = (await db.task.findUniqueOrThrow({ where: { id: task.id } })).resourceClaims;
    const second = await createTaskClaims({ taskId: task.id, claims: [...input.claims].reverse() });
    expect(second).toEqual(first);
    expect(first).toHaveLength(2);
    expect((await db.task.findUniqueOrThrow({ where: { id: task.id } })).resourceClaims).toBe(before);
  });

  it("reads legacy lowercase rows and empty claim sets", async () => {
    const { task } = await setupTask("legacy");
    await db.task.update({
      where: { id: task.id },
      data: { resourceClaims: JSON.stringify([{ path: "src/old.ts", mode: "write" }]) },
    });
    expect(await getTaskClaims(task.id)).toEqual([{ resourceId: "src/old.ts", kind: "FILE", access: "WRITE" }]);

    const { task: empty } = await setupTask("empty");
    expect(await getTaskClaims(empty.id)).toEqual([]);
    expect(readTaskClaims("[]")).toEqual([]);
  });

  it("rejects unknown tasks and malformed stored rows", async () => {
    await expect(getTaskClaims("missing")).rejects.toThrow(NotFoundError);
    await expect(createTaskClaims({ taskId: "missing", claims: [{ resource: "a.ts", access: "READ" }] })).rejects.toThrow(
      NotFoundError,
    );
    const { task } = await setupTask("malformed");
    await db.task.update({ where: { id: task.id }, data: { resourceClaims: "not-json{{" } });
    await expect(getTaskClaims(task.id)).rejects.toThrow(InvalidResourceClaimError);
    await db.task.update({ where: { id: task.id }, data: { resourceClaims: JSON.stringify([{ nope: 1 }]) } });
    await expect(getTaskClaims(task.id)).rejects.toThrow(InvalidResourceClaimError);
  });

  it("compares persisted task pairs deterministically", async () => {
    const first = await setupTask("pair-a");
    const second = await setupTask("pair-b");
    await createTaskClaims({ taskId: first.task.id, claims: [{ resource: "prisma/schema.prisma", access: "WRITE" }] });
    await createTaskClaims({ taskId: second.task.id, claims: [{ resource: "prisma/schema.prisma", access: "WRITE" }] });

    const conflict = await checkTaskPair(first.task.id, second.task.id);
    expect(conflict.status).toBe("CONFLICT");
    if (conflict.status === "CONFLICT") {
      expect(conflict.conflicts).toHaveLength(1);
      expect(conflict.conflicts[0]?.kind).toBe("WRITE_WRITE");
    }

    const third = await setupTask("pair-c");
    await createTaskClaims({ taskId: third.task.id, claims: [{ resource: "src/other.ts", access: "WRITE" }] });
    expect(await checkTaskPair(first.task.id, third.task.id)).toEqual({ status: "NO_CONFLICT", checkedPairs: 1 });
  });

  it("validates claims against a repository analysis", async () => {
    const repo = await initTempRepo();
    const analysis = await analyzeRepository(repo);
    const { task } = await setupTask("validate");
    await createTaskClaims({
      taskId: task.id,
      claims: [
        { resource: "README.md", access: "READ" },
        { resource: "src/future.ts", access: "WRITE" },
      ],
    });
    const enriched = validateClaimsAgainstAnalysis(await getTaskClaims(task.id), analysis);
    expect(enriched.find((claim) => claim.resourceId === "README.md")?.detectedKind).toBe("FILE");
    expect(enriched.find((claim) => claim.resourceId === "src/future.ts")?.detectedKind).toBeNull();

    expect(() =>
      validateClaimsAgainstAnalysis([{ resourceId: "nope/missing.ts", kind: "FILE", access: "READ" }], analysis),
    ).toThrow(InvalidResourceClaimError);
  });

  it("cleans claims up with its task", async () => {
    const { task } = await setupTask("cleanup");
    await createTaskClaims({ taskId: task.id, claims: [{ resource: "src/gone.ts", access: "WRITE" }] });
    await db.task.delete({ where: { id: task.id } });
    await expect(getTaskClaims(task.id)).rejects.toThrow(NotFoundError);
  });
});
