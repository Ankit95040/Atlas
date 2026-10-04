import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { getCurrentCommit, runGit } from "../src/git/index.js";
import {
  attribution,
  diffPresence,
  evaluateTaskSurvival,
  runBehavioralProbe,
  survivalPredicate,
  survivalRate,
} from "../src/benchmark/scale/index.js";
import type { ScaleProbe } from "../src/benchmark/scale/index.js";
import { initTempRepo, makeTempDir } from "./git-helpers.js";

const GOOD_CART = `export function total(items) {
  return items.reduce((sum, item) => sum + item.price * item.qty, 0);
}
`;

const BROKEN_CART = `export function total(items) {
  return items.length;
}
`;

function cartProbe(timeoutMs = 30000): ScaleProbe {
  return {
    name: "total sums",
    command: [
      process.execPath,
      "-e",
      "import('./src/cart.js').then((m) => { if (m.total([{ price: 10, qty: 2 }]) !== 20) process.exit(1); });",
    ],
    timeoutMs,
  };
}

async function commitFile(repo: string, path: string, content: string, message: string): Promise<string> {
  const absolute = join(repo, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
  await runGit(["add", "-A"], { cwd: repo });
  await runGit(
    ["-c", "user.email=t@example.invalid", "-c", "user.name=T", "-c", "commit.gpgsign=false", "commit", "-m", message],
    { cwd: repo },
  );
  return getCurrentCommit(repo);
}

async function baseOf(repo: string): Promise<string> {
  const result = await runGit(["rev-list", "--max-parents=0", "HEAD"], { cwd: repo });
  return result.stdout.trim().split("\n")[0] as string;
}

describe("scale survival", () => {
  it("scores SURVIVED when the probe passes on own attributed work", async () => {
    const repo = await initTempRepo();
    const base = await baseOf(repo);
    const head = await commitFile(repo, "src/cart.js", GOOD_CART, "cart");
    const verdict = await evaluateTaskSurvival({
      repoDir: repo,
      trainPath: repo,
      baseCommit: base,
      trainHead: head,
      taskKey: "cart",
      claimedPaths: ["src/cart.js"],
      probes: [cartProbe()],
      ownMergeShas: new Set([head]),
    });
    expect(verdict.status).toBe("SURVIVED");
    expect(verdict.probePassed).toBe(true);
    expect(verdict.diffNonEmpty).toBe(true);
    expect(verdict.attributed).toBe(true);
  });

  it("scores OVERWRITTEN when behavior is gone without later interference", async () => {
    const repo = await initTempRepo();
    const base = await baseOf(repo);
    const head = await commitFile(repo, "src/cart.js", BROKEN_CART, "broken");
    const verdict = await evaluateTaskSurvival({
      repoDir: repo,
      trainPath: repo,
      baseCommit: base,
      trainHead: head,
      taskKey: "cart",
      claimedPaths: ["src/cart.js"],
      probes: [cartProbe()],
      ownMergeShas: new Set([head]),
    });
    expect(verdict.status).toBe("OVERWRITTEN");
    expect(verdict.probePassed).toBe(false);
  });

  it("scores REVERTED when own work landed but later commits broke it", async () => {
    const repo = await initTempRepo();
    const base = await baseOf(repo);
    const own = await commitFile(repo, "src/cart.js", GOOD_CART, "cart");
    const head = await commitFile(repo, "src/cart.js", BROKEN_CART, "clobber");
    expect(head).not.toBe(own);
    const verdict = await evaluateTaskSurvival({
      repoDir: repo,
      trainPath: repo,
      baseCommit: base,
      trainHead: head,
      taskKey: "cart",
      claimedPaths: ["src/cart.js"],
      probes: [cartProbe()],
      ownMergeShas: new Set([own]),
    });
    expect(verdict.status).toBe("REVERTED");
  });

  it("scores NEVER_MERGED when nothing touched the paths", async () => {
    const repo = await initTempRepo();
    const base = await baseOf(repo);
    const head = await getCurrentCommit(repo);
    const verdict = await evaluateTaskSurvival({
      repoDir: repo,
      trainPath: repo,
      baseCommit: base,
      trainHead: head,
      taskKey: "cart",
      claimedPaths: ["src/cart.js"],
      probes: [cartProbe()],
      ownMergeShas: new Set(),
    });
    expect(verdict.status).toBe("NEVER_MERGED");
    expect(verdict.probePassed).toBe(false);
    expect(verdict.diffNonEmpty).toBe(false);
  });

  it("scores SURVIVED_WITH_REIMPLEMENTATION when others provide the behavior", async () => {
    const repo = await initTempRepo();
    const base = await baseOf(repo);
    await commitFile(repo, "src/cart.js", GOOD_CART, "sibling work");
    const head = await getCurrentCommit(repo);
    const verdict = await evaluateTaskSurvival({
      repoDir: repo,
      trainPath: repo,
      baseCommit: base,
      trainHead: head,
      taskKey: "cart",
      claimedPaths: ["src/cart.js"],
      probes: [cartProbe()],
      ownMergeShas: new Set(),
    });
    expect(verdict.status).toBe("SURVIVED_WITH_REIMPLEMENTATION");
    expect(verdict.probePassed).toBe(true);
    expect(verdict.attributed).toBe(false);
  });

  it("attributes through --no-ff merges despite log simplification", async () => {
    // git log base..head -- paths prunes merge commits; attribution must work
    // at the merge level or every integrated task scores REIMPLEMENTATION.
    const repo = await initTempRepo();
    const base = await baseOf(repo);
    await runGit(["checkout", "-b", "worker/cart"], { cwd: repo });
    const worker = await commitFile(repo, "src/cart.js", GOOD_CART, "cart");
    await runGit(["checkout", "main"], { cwd: repo });
    await runGit(["checkout", "-b", "train"], { cwd: repo });
    await runGit(["merge", "--no-ff", "--no-commit", "worker/cart"], { cwd: repo });
    await runGit(
      ["-c", "user.email=t@example.invalid", "-c", "user.name=T", "-c", "commit.gpgsign=false", "commit", "-m", "merge"],
      { cwd: repo },
    );
    const merge = await getCurrentCommit(repo);
    expect(merge).not.toBe(worker);
    const verdict = await evaluateTaskSurvival({
      repoDir: repo,
      trainPath: repo,
      baseCommit: base,
      trainHead: merge,
      taskKey: "cart",
      claimedPaths: ["src/cart.js"],
      probes: [cartProbe()],
      ownMergeShas: new Set([merge]),
    });
    expect(verdict.status).toBe("SURVIVED");
    expect(verdict.attributed).toBe(true);
  });

  it("bounds probes by timeout and reports exit codes", async () => {
    const dir = await makeTempDir();
    const hanging: ScaleProbe = { name: "hang", command: [process.execPath, "-e", "setInterval(() => {}, 100000)"], timeoutMs: 200 };
    const hung = await runBehavioralProbe({ workdir: dir, probe: hanging });
    expect(hung.passed).toBe(false);
    expect(hung.timedOut).toBe(true);

    const failing: ScaleProbe = { name: "fail", command: [process.execPath, "-e", "process.exit(3)"], timeoutMs: 30000 };
    const failed = await runBehavioralProbe({ workdir: dir, probe: failing });
    expect(failed.passed).toBe(false);
    expect(failed.exitCode).toBe(3);

    const passing: ScaleProbe = { name: "ok", command: [process.execPath, "-e", "process.exit(0)"], timeoutMs: 30000 };
    expect((await runBehavioralProbe({ workdir: dir, probe: passing })).passed).toBe(true);

    const empty = await runBehavioralProbe({ workdir: dir, probe: { name: "empty", command: [], timeoutMs: 30000 } });
    expect(empty.passed).toBe(false);
  });

  it("passes fixtureNodeModulesPath to runBehavioralProbe for NODE_PATH resolution", async () => {
    // Verify that the parameter is accepted and used (even if null, it should not throw).
    const dir = await makeTempDir();
    const passing: ScaleProbe = { name: "ok", command: [process.execPath, "-e", "process.exit(0)"], timeoutMs: 30000 };
    const observed = await runBehavioralProbe({ workdir: dir, probe: passing, fixtureNodeModulesPath: "/nonexistent" });
    expect(observed.passed).toBe(true);
  });

  it("degrades diff and attribution gracefully", async () => {
    const repo = await initTempRepo();
    const base = await baseOf(repo);
    const head = await getCurrentCommit(repo);
    const empty = await diffPresence({ repoDir: repo, base, head, paths: [] });
    expect(empty.nonEmpty).toBe(false);
    const missing = await diffPresence({ repoDir: join(repo, "nope"), base, head, paths: ["src/a.js"] });
    expect(missing.nonEmpty).toBe(false);
    expect(missing.detail).toMatch(/diff failed/);
    const unattributed = await attribution({ repoDir: repo, base, head, paths: [], ownMergeShas: new Set() });
    expect(unattributed.attributed).toBe(false);
  });

  it("computes survival rates and predicates without fabrication", () => {
    expect(survivalRate([])).toBeNull();
    const mixed = [
      { key: "a", status: "SURVIVED", probePassed: true, diffNonEmpty: true, attributed: true, detail: "" },
      { key: "b", status: "OVERWRITTEN", probePassed: false, diffNonEmpty: true, attributed: true, detail: "" },
      { key: "c", status: "SURVIVED_WITH_REIMPLEMENTATION", probePassed: true, diffNonEmpty: true, attributed: false, detail: "" },
      { key: "d", status: "NEVER_MERGED", probePassed: false, diffNonEmpty: false, attributed: false, detail: "" },
    ] as const;
    expect(survivalRate([...mixed])).toBe(0.5);
    expect(survivalPredicate([...mixed], ["a", "b", "c", "d"])).toBe(false);
    expect(survivalPredicate([...mixed], ["a", "c"])).toBe(true);
    expect(survivalPredicate([...mixed], ["a", "ghost"])).toBe(false);
    expect(survivalPredicate([...mixed], [])).toBe(false);
  });
});
