import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { disconnectDatabase } from "../src/db/client.js";
import { runInitCommand } from "../src/cli/init.js";
import {
  findProjectStateDir,
  resolveDatabaseUrl,
  resolveExplicitStateDir,
} from "../src/config/state.js";
import { initTempRepo } from "./git-helpers.js";
import { track } from "./domain-helpers.js";

// Per-project state isolation (M28.1 Phase B).
//
// Resolution contract: explicit DATABASE_URL wins, else the nearest
// `.atlas/atlas.db` walking up from cwd, else the legacy dev.db default.
// Two provisioned repositories must operate on fully disjoint state.

function pushSchema(dbUrl: string): void {
  execFileSync("npx", ["prisma", "db", "push", "--skip-generate"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: dbUrl },
    stdio: "pipe",
  });
}

describe("state resolution (M28.1)", () => {
  it("prefers explicit DATABASE_URL over everything", () => {
    const resolved = resolveDatabaseUrl({ cwd: "/", env: { DATABASE_URL: "file:/tmp/explicit.db" } });
    expect(resolved).toEqual({ databaseUrl: "file:/tmp/explicit.db", source: "env", stateDir: null });
  });

  it("falls back to the legacy default when nothing is configured", () => {
    const resolved = resolveDatabaseUrl({ cwd: "/", env: {} });
    expect(resolved).toEqual({ databaseUrl: "file:./dev.db", source: "legacy", stateDir: null });
  });

  it("finds the nearest provisioned state home walking up", () => {
    const root = mkdtempSync(join(tmpdir(), "atlas-state-walk-"));
    try {
      const outer = join(root, ".atlas");
      mkdirSync(join(outer), { recursive: true });
      writeFileSync(join(outer, "atlas.db"), "");
      const nested = join(root, "a", "b");
      mkdirSync(nested, { recursive: true });
      expect(findProjectStateDir(nested)).toBe(root);
      const resolved = resolveDatabaseUrl({ cwd: nested, env: {} });
      expect(resolved.source).toBe("project");
      expect(resolved.databaseUrl).toBe(`file:${join(root, ".atlas", "atlas.db")}`);
      expect(resolved.stateDir).toBe(join(root, ".atlas"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores a bare .atlas directory without a database file", () => {
    const root = mkdtempSync(join(tmpdir(), "atlas-state-bare-"));
    try {
      mkdirSync(join(root, ".atlas"), { recursive: true });
      expect(findProjectStateDir(root)).toBeNull();
      expect(resolveDatabaseUrl({ cwd: root, env: {} }).source).toBe("legacy");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an unprovisioned explicit state dir with an actionable error", () => {
    const root = mkdtempSync(join(tmpdir(), "atlas-state-missing-"));
    try {
      expect(() => resolveExplicitStateDir(join(root, ".atlas"))).toThrow(/not found.*prisma db push/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

const scratch: string[] = [];

describe("two-repository isolation (M28.1)", () => {
  const clients: PrismaClient[] = [];

  afterAll(async () => {
    for (const client of clients) {
      await client.$disconnect();
    }
    await disconnectDatabase();
    for (const dir of scratch) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps project state disjoint across two provisioned repositories", async () => {
    const setups: Array<{ repo: string; dbUrl: string; db: PrismaClient; featureId: string }> = [];
    for (const name of ["repo-a", "repo-b"]) {
      const repo = await initTempRepo();
      scratch.push(repo);
      const stateDir = join(repo, ".atlas");
      mkdirSync(stateDir, { recursive: true });
      const dbUrl = `file:${join(stateDir, "atlas.db")}`;
      pushSchema(dbUrl);
      const db = new PrismaClient({ datasourceUrl: dbUrl });
      clients.push(db);
      const output = await runInitCommand(
        { name, repoPath: repo, featureTitle: `${name} feature`, stateDatabaseUrl: dbUrl },
        db,
      );
      expect(output.exitCode).toBe(0);
      expect(output.human).toContain(`state: ${dbUrl}`);
      setups.push({ repo, dbUrl, db, featureId: (output.data as { featureId: string }).featureId });
    }
    const [a, b] = setups as [{ repo: string; dbUrl: string; db: PrismaClient; featureId: string }, { repo: string; dbUrl: string; db: PrismaClient; featureId: string }];
    // Each DB sees exactly its own project/feature.
    expect(await a.db.project.count()).toBe(1);
    expect(await b.db.project.count()).toBe(1);
    expect(await a.db.feature.findUnique({ where: { id: a.featureId } })).not.toBeNull();
    expect(await b.db.feature.findUnique({ where: { id: a.featureId } })).toBeNull();
    expect(await a.db.feature.findUnique({ where: { id: b.featureId } })).toBeNull();
    // Resolution from inside each repo finds its own state home.
    expect(resolveDatabaseUrl({ cwd: a.repo, env: {} }).databaseUrl).toBe(a.dbUrl);
    expect(resolveDatabaseUrl({ cwd: b.repo, env: {} }).databaseUrl).toBe(b.dbUrl);
  }, 120000);
});

describe("init state reporting (M28.1)", () => {
  it("omits the state line when no explicit database is reported", async () => {
    const repo = await initTempRepo();
    scratch.push(repo);
    const { getPrismaClient } = await import("../src/db/client.js");
    const db = getPrismaClient();
    const before = await db.project.count();
    const output = await runInitCommand({ name: "state-line-probe", repoPath: repo, featureTitle: "probe" }, db);
    expect(output.exitCode).toBe(0);
    expect(output.human).not.toContain("state: ");
    const data = output.data as { projectId: string; repositoryId: string; featureId: string };
    track("project", data.projectId);
    track("repository", data.repositoryId);
    track("feature", data.featureId);
    expect(await db.project.count()).toBe(before + 1);
  });
});
