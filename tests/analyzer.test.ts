import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RepositoryAnalysisError,
  analyzeRepository,
  classifyResourceDirectory,
  classifyResourceFile,
  listTrackedFiles,
} from "../src/analyzer/index.js";
import { NotGitRepositoryError, getCurrentCommit, runGit } from "../src/git/index.js";
import { initTempRepo, makeTempDir } from "./git-helpers.js";

const FIXTURE_FILES = [
  "src/app.ts",
  "src/auth/login.ts",
  "src/auth/__tests__/login.test.ts",
  "prisma/schema.prisma",
  "prisma/migrations/001_init/migration.sql",
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
] as const;

async function initFixtureRepo(): Promise<string> {
  const repo = await initTempRepo();
  for (const file of FIXTURE_FILES) {
    const full = join(repo, file);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, `// ${file}\n`);
  }
  // Deliberately committed noise: dependency payload + OS droppings must be excluded.
  await mkdir(join(repo, "node_modules", "fake"), { recursive: true });
  await writeFile(join(repo, "node_modules", "fake", "dep.js"), "module.exports = {};\n");
  await writeFile(join(repo, ".DS_Store"), "noise\n");
  await runGit(["add", "-A"], { cwd: repo });
  await runGit(["-c", "commit.gpgsign=false", "commit", "-m", "fixture"], { cwd: repo });
  return repo;
}

function kindOf(analysis: { resources: readonly { id: string; kind: string }[] }, id: string): string | null {
  return analysis.resources.find((resource) => resource.id === id)?.kind ?? null;
}

describe("repository analyzer", () => {
  it("resolves the correct repository root", async () => {
    const repo = await initFixtureRepo();
    const analysis = await analyzeRepository(repo);
    expect(analysis.repositoryRoot).toBe(repo);
  });

  it("includes tracked files with repository-relative ids", async () => {
    const repo = await initFixtureRepo();
    const analysis = await analyzeRepository(repo);
    for (const file of [...FIXTURE_FILES, "README.md"]) {
      expect(analysis.resources.map((resource) => resource.id)).toContain(file);
    }
    for (const resource of analysis.resources) {
      expect(resource.id.startsWith("/")).toBe(false);
    }
  });

  it("excludes .git internals, node_modules, and OS droppings", async () => {
    const repo = await initFixtureRepo();
    const files = await listTrackedFiles(repo);
    expect(files).toContain("src/app.ts");
    expect(files.some((file) => file.includes("node_modules"))).toBe(false);
    expect(files).not.toContain(".DS_Store");
    const analysis = await analyzeRepository(repo);
    expect(analysis.resources.some((resource) => resource.id.includes("node_modules"))).toBe(false);
    expect(analysis.resources.some((resource) => resource.id.includes(".git"))).toBe(false);
  });

  it("sorts resources deterministically by id", async () => {
    const repo = await initFixtureRepo();
    const analysis = await analyzeRepository(repo);
    const ids = analysis.resources.map((resource) => resource.id);
    expect(ids).toEqual([...ids].sort());
    expect(analysis.resourceCount).toBe(analysis.resources.length);
  });

  it("records the analyzed git commit", async () => {
    const repo = await initFixtureRepo();
    const analysis = await analyzeRepository(repo);
    expect(analysis.analyzedCommit).toBe(await getCurrentCommit(repo));
    expect(analysis.analyzedCommit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("produces equivalent output on repeated runs", async () => {
    const repo = await initFixtureRepo();
    expect(await analyzeRepository(repo)).toEqual(await analyzeRepository(repo));
  });

  it("detects source, test, config, schema, migration, manifest, and lockfile kinds", async () => {
    const repo = await initFixtureRepo();
    const analysis = await analyzeRepository(repo);
    expect(kindOf(analysis, "src/app.ts")).toBe("SOURCE");
    expect(kindOf(analysis, "src/auth/login.ts")).toBe("SOURCE");
    expect(kindOf(analysis, "src/auth/__tests__/login.test.ts")).toBe("TEST");
    expect(kindOf(analysis, "prisma/schema.prisma")).toBe("SCHEMA");
    expect(kindOf(analysis, "prisma/migrations/001_init/migration.sql")).toBe("MIGRATION");
    expect(kindOf(analysis, "package.json")).toBe("PACKAGE_MANIFEST");
    expect(kindOf(analysis, "pnpm-lock.yaml")).toBe("LOCKFILE");
    expect(kindOf(analysis, "tsconfig.json")).toBe("CONFIG");
    expect(kindOf(analysis, "README.md")).toBe("FILE");
  });

  it("emits directory resources with the migrations-tree convention", async () => {
    const repo = await initFixtureRepo();
    const analysis = await analyzeRepository(repo);
    expect(kindOf(analysis, "src")).toBe("DIRECTORY");
    expect(kindOf(analysis, "src/auth")).toBe("DIRECTORY");
    expect(kindOf(analysis, "prisma/migrations")).toBe("MIGRATION");
    expect(kindOf(analysis, "prisma/migrations/001_init")).toBe("MIGRATION");
  });

  it("rejects empty repositories and non-repositories", async () => {
    const empty = await makeTempDir();
    await runGit(["init", "-b", "main"], { cwd: empty });
    await expect(analyzeRepository(empty)).rejects.toThrow(RepositoryAnalysisError);
    const plain = await makeTempDir();
    await expect(analyzeRepository(plain)).rejects.toThrow(NotGitRepositoryError);
  });

  it("classifies filenames purely, with test-over-source precedence", async () => {
    expect(classifyResourceFile("src/foo.test.ts")).toBe("TEST");
    expect(classifyResourceFile("src/foo.ts")).toBe("SOURCE");
    expect(classifyResourceFile("tests/e2e/login.spec.ts")).toBe("TEST");
    expect(classifyResourceFile("package.json")).toBe("PACKAGE_MANIFEST");
    expect(classifyResourceFile("yarn.lock")).toBe("LOCKFILE");
    expect(classifyResourceFile("vite.config.ts")).toBe("CONFIG");
    expect(classifyResourceFile("Dockerfile")).toBe("CONFIG");
    expect(classifyResourceFile("notes.md")).toBe("FILE");
    expect(classifyResourceDirectory("src/auth")).toBe("DIRECTORY");
    expect(classifyResourceDirectory("prisma/migrations")).toBe("MIGRATION");
  });
});
