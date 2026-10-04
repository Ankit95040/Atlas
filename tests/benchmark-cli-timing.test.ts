import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runGit } from "../src/git/index.js";

// Reproducible CLI overhead benchmark (M28.2 Phase C).
//
// Deterministic stub agents (tests/fixtures/script-agent.mjs) and trivial
// repo tests, so provider latency is exactly zero: every measured
// millisecond is Atlas + git + SQLite. Real providers and real test
// suites add minutes on top — see the M28.2 report for the split.
//
// Bounds below are generous sanity limits (catch 10x regressions, never
// flake on machine noise). Medians for the report come from repeated
// manual runs, not from these assertions.

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CLI = ["node", join(ROOT, "dist", "cli", "run.js")];
const AGENT = join(ROOT, "tests", "fixtures", "script-agent.mjs");

let scratch = "";
let dbUrl = "";

function cli(args: string[], cwd: string): { ms: number; json: Record<string, unknown> } {
  const start = Date.now();
  const spawned = spawnSync(CLI[0] as string, [...CLI.slice(1), ...args], {
    cwd,
    env: { ...process.env, DATABASE_URL: dbUrl },
    encoding: "utf8",
    timeout: 280_000,
  });
  const ms = Date.now() - start;
  expect(spawned.error, `CLI crashed: ${spawned.stderr.slice(0, 300)}`).toBeUndefined();
  const line = spawned.stdout.split("\n").find((l) => l.trim().startsWith("{"));
  expect(line, `no JSON in: ${spawned.stdout.slice(0, 300)}`).toBeDefined();
  return { ms, json: JSON.parse(line as string) as Record<string, unknown> };
}

function makeRepo(name: string): string {
  const dir = join(scratch, name);
  execFileSync("git", ["init", "-b", "main", "-q", dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "bench@example.invalid"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "Bench"]);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, scripts: { test: "node -e \"process.exit(0)\"" } }));
  writeFileSync(join(dir, "work.txt"), "seed\n");
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "-c", "commit.gpgsign=false", "commit", "-qm", "init"]);
  return dir;
}

function proposal(featureId: string, tasks: Array<{ id: string; deps?: string[] }>): string {
  const file = join(scratch, `proposal-${featureId.slice(-6)}.json`);
  writeFileSync(
    file,
    JSON.stringify({
      featureId,
      tasks: tasks.map((t) => ({
        id: t.id,
        title: t.id,
        claims: [{ resource: "work.txt", access: "WRITE" as const }],
      })),
      dependencies: tasks.flatMap((t) => (t.deps ?? []).map((d) => ({ taskId: t.id, dependsOnTaskId: d }))),
    }),
  );
  return file;
}

async function endToEnd(name: string, tasks: Array<{ id: string; deps?: string[] }>, maxConcurrency: number): Promise<number> {
  const repo = makeRepo(name);
  const init = cli(["init", "--name", name, "--repo-path", repo, "--feature-title", name, "--json"], ROOT);
  const featureId = init.json["featureId"] as string;
  const repositoryId = init.json["repositoryId"] as string;
  const plan = cli(
    ["plan", "--feature", featureId, "--proposal", proposal(featureId, tasks), "--approve", "--actor", "bench", "--json"],
    ROOT,
  );
  const approvalId = (plan.json["approval"] as { id: string }).id;
  const start = Date.now();
  const run = cli(
    [
      "run", "--feature", featureId, "--repository", repositoryId, "--plan-approval", approvalId,
      "--actor", "bench", "--agent", process.execPath, "--agent-arg", AGENT,
      "--agent-arg", "--write", "--agent-arg", "work.txt=bench\n", "--agent-arg", "--commit", "--agent-arg", "bench work",
      "--approve-merge", "--max-concurrency", String(maxConcurrency), "--json",
    ],
    scratch,
  );
  void start;
  expect(run.json["ok"], `run failed: ${JSON.stringify(run.json).slice(0, 400)}`).toBe(true);
  return run.ms;
}

describe("CLI overhead benchmark (M28.2)", () => {
  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), "atlas-bench-"));
    dbUrl = `file:${join(scratch, "bench.db")}`;
    execFileSync("npx", ["prisma", "db", "push", "--skip-generate"], {
      cwd: ROOT,
      env: { ...process.env, DATABASE_URL: dbUrl },
      stdio: "pipe",
      timeout: 120_000,
    });
    // CLI smoke tests need the built entrypoint; skip (don't fail) on a
    // fresh clone where `pnpm build` has not run yet.
    try {
      execFileSync("node", [join(ROOT, "dist", "cli", "run.js"), "--help"], { stdio: "pipe" });
    } catch {
      throw new Error("dist/cli/run.js missing: run `pnpm build` before the benchmark harness");
    }
  }, 180_000);

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it("starts the CLI quickly, cold and warm", () => {
    const time = (args: string[]): number => {
      const start = Date.now();
      const spawned = spawnSync(CLI[0] as string, [...CLI.slice(1), ...args], {
        cwd: ROOT,
        env: { ...process.env, DATABASE_URL: dbUrl },
        encoding: "utf8",
        timeout: 120_000,
      });
      expect(spawned.error, `CLI crashed: ${spawned.stderr.slice(0, 300)}`).toBeUndefined();
      expect(spawned.status, `exit ${spawned.status}: ${spawned.stderr.slice(0, 300)}`).toBe(0);
      return Date.now() - start;
    };
    const cold = time(["--help"]);
    const samples = [cold, time(["doctor"]), time(["doctor"]), time(["doctor"]), time(["doctor"])];
    samples.sort((a, b) => a - b);
    const median = samples[2] as number;
    console.log(`cli startup: cold=${cold}ms warm-samples=${samples.join(",")}`);
    expect(median).toBeLessThan(10_000);
  });

  it("executes a single task end to end", async () => {
    const ms = await endToEnd("one", [{ id: "t1" }], 4);
    console.log(`e2e 1-task: ${ms}ms`);
    expect(ms).toBeLessThan(120_000);
  });

  it("executes three independent tasks in one wave", async () => {
    const ms = await endToEnd("three-parallel", [{ id: "t1" }, { id: "t2" }, { id: "t3" }], 4);
    console.log(`e2e 3-parallel: ${ms}ms`);
    expect(ms).toBeLessThan(120_000);
  });

  it("executes a three-task dependency chain across waves", async () => {
    const ms = await endToEnd(
      "three-chain",
      [{ id: "t1" }, { id: "t2", deps: ["t1"] }, { id: "t3", deps: ["t2"] }],
      4,
    );
    console.log(`e2e 3-chain: ${ms}ms`);
    expect(ms).toBeLessThan(180_000);
  }, 200_000);

  it("times raw git worktree operations for comparison", async () => {
    const repo = makeRepo("wt-ops");
    const s1 = Date.now();
    await runGit(["worktree", "add", join(scratch, "wt1")], { cwd: repo });
    const addMs = Date.now() - s1;
    const s2 = Date.now();
    await runGit(["worktree", "remove", "--force", join(scratch, "wt1")], { cwd: repo });
    const removeMs = Date.now() - s2;
    console.log(`git worktree: add=${addMs}ms remove=${removeMs}ms`);
    expect(addMs).toBeLessThan(30_000);
  });
});
