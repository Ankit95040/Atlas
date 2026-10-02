import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrismaClient } from "@prisma/client";
import { getPrismaClient } from "../db/client.js";
import { createTaskClaims } from "../claims/index.js";
import {
  createFeature,
  createProject,
  createRepository,
  createTask,
  createTaskDependency,
  createWorker,
  recordEvent,
  recordTestRun,
  transitionTask,
  transitionTestRun,
} from "../core/service.js";
import { assignTaskToWorker } from "../workspaces/index.js";

// Development-only demo seeding for the Atlas dashboard (M24.1).
//
// Builds a small realistic project through the EXISTING service functions
// (no new domain writes, no mock rows) so every displayed value traces to
// real control-plane records. Writes ONLY to the database DATABASE_URL
// points at — point it at a scratch file, never at production state.
// Not wired into any CLI command or server route.

function git(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd }, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

export async function seedDemoDatabase(db: PrismaClient = getPrismaClient()): Promise<{ projectId: string; featureId: string; repoDir: string; scratchRoot: string }> {
  const repoDir = await mkdtemp(join(tmpdir(), "atlas-ui-demo-repo-"));
  await writeFile(join(repoDir, "package.json"), JSON.stringify({ name: "demo", scripts: { test: "node check.mjs" } }));
  await writeFile(join(repoDir, "check.mjs"), "process.exit(0);\n");
  await git(["init", "-b", "main"], repoDir);
  await git(["config", "user.email", "demo@atlas.test"], repoDir);
  await git(["config", "user.name", "Atlas Demo"], repoDir);
  await git(["add", "-A"], repoDir);
  await git(["-c", "commit.gpgsign=false", "commit", "-m", "demo base"], repoDir);

  const project = await createProject({ name: "Demo Shop", description: "Development-only dashboard demo (M24.1 seed)" }, db);
  const repository = await createRepository({ projectId: project.id, name: "main", localPath: repoDir }, db);
  const feature = await createFeature({ projectId: project.id, title: "Checkout utilities", description: "Demo run for dashboard development" }, db);

  const slug = await createTask({ featureId: feature.id, title: "Implement slugify" }, db);
  const tests = await createTask({ featureId: feature.id, title: "Cover slugify with tests" }, db);
  const greet = await createTask({ featureId: feature.id, title: "Add greeting helper" }, db);
  await createTaskClaims({ taskId: slug.id, claims: [{ resource: "src/slug.js", access: "WRITE" }] });
  await createTaskClaims({
    taskId: tests.id,
    claims: [
      { resource: "test/slug.test.js", access: "WRITE" },
      { resource: "src/slug.js", access: "READ" },
    ],
  });
  await createTaskClaims({ taskId: greet.id, claims: [{ resource: "src/greet.js", access: "WRITE" }] });
  await createTaskDependency({ taskId: tests.id, dependsOnTaskId: slug.id }, db);

  // A live assignment (real worktree in a scratch root, never the repo).
  const scratch = await mkdtemp(join(tmpdir(), "atlas-ui-demo-work-"));
  await transitionTask(slug.id, "READY", db);
  const worker = await createWorker({}, db);
  await assignTaskToWorker({ taskId: slug.id, workerId: worker.id, repositoryId: repository.id, workspaceRoot: join(scratch, "ws") }, db);

  // A failed task with persisted evidence (valid edges + recorded events).
  await transitionTask(tests.id, "READY", db);
  await transitionTask(tests.id, "CLAIMED", db);
  await transitionTask(tests.id, "IN_PROGRESS", db);
  await transitionTask(tests.id, "FAILED", db);
  const testRun = await recordTestRun({ taskId: tests.id, name: "ui demo tests", exitCode: 1 }, db);
  await transitionTestRun(testRun.id, "RUNNING", db);
  await transitionTestRun(testRun.id, "FAILED", db);
  await recordEvent(
    { type: "TASK_FAILED", featureId: feature.id, taskId: tests.id, actor: "atlas-demo-seed", payload: { phase: "testing", errorCode: "EXIT_NONZERO", error: "demo failure" } },
    db,
  );

  // A completed, verified task (evidence rows only — no fake execution).
  await transitionTask(greet.id, "READY", db);
  await transitionTask(greet.id, "CLAIMED", db);
  await transitionTask(greet.id, "IN_PROGRESS", db);
  await transitionTask(greet.id, "VERIFICATION", db);
  await recordEvent(
    { type: "VERIFICATION_COMPLETED", featureId: feature.id, taskId: greet.id, actor: "atlas-demo-seed", payload: { verdict: "VERIFIED", reasons: [] } },
    db,
  );
  await transitionTask(greet.id, "COMPLETED", db);

  return { projectId: project.id, featureId: feature.id, repoDir, scratchRoot: scratch };
}
