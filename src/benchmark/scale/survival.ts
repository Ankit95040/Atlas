import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runGit } from "../../git/index.js";
import type { ScaleProbe, ScaleSurvivalStatus, ScaleTaskSurvival } from "./types.js";

const execFileAsync = promisify(execFile);

const PROBE_MAX_BUFFER = 1024 * 1024;
const OUTPUT_TAIL_CAP = 2000;

function tail(text: string, cap: number): string {
  return text.length <= cap ? text : text.slice(-cap);
}

// ---------- Behavioral probes (design §7, checks 1–2) ----------

export interface ProbeObservation {
  readonly passed: boolean;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly stdoutTail: string;
  readonly stderrTail: string;
}

interface ExecFailure {
  readonly code?: unknown;
  readonly killed?: unknown;
  readonly stdout?: unknown;
  readonly stderr?: unknown;
}

/**
 * Execute one behavioral probe argv (never a shell string) with cwd set to
 * the train-head worktree. Exit 0 means the contribution is present and
 * operative. Timeouts and spawn failures are probe failures, never hangs:
 * every probe is bounded by its own timeoutMs.
 *
 * NODE_PATH support (Amendment A.6): when fixtureNodeModulesPath is provided,
 * it is set as NODE_PATH in the child env so the probe can resolve runner
 * modules from the vendored fixture's node_modules.
 */
export async function runBehavioralProbe(args: {
  workdir: string;
  probe: ScaleProbe;
  fixtureNodeModulesPath?: string;
}): Promise<ProbeObservation> {
  const [executable, ...argv] = args.probe.command;
  if (executable === undefined) {
    return { passed: false, exitCode: null, timedOut: false, stdoutTail: "", stderrTail: "empty probe command" };
  }
  const execOptions: Record<string, unknown> = {
    cwd: args.workdir,
    timeout: args.probe.timeoutMs,
    maxBuffer: PROBE_MAX_BUFFER,
  };
  if (args.fixtureNodeModulesPath !== undefined) {
    execOptions.env = { ...process.env, NODE_PATH: args.fixtureNodeModulesPath };
  }
  try {
    const { stdout, stderr } = await execFileAsync(executable, argv, execOptions);
    return { passed: true, exitCode: 0, timedOut: false, stdoutTail: tail(stdout, OUTPUT_TAIL_CAP), stderrTail: tail(stderr, OUTPUT_TAIL_CAP) };
  } catch (error) {
    const failure = (error ?? {}) as ExecFailure;
    const stdout = typeof failure.stdout === "string" ? failure.stdout : "";
    const stderr = typeof failure.stderr === "string" ? failure.stderr : "";
    return {
      passed: false,
      exitCode: typeof failure.code === "number" ? failure.code : null,
      timedOut: failure.killed === true,
      stdoutTail: tail(stdout, OUTPUT_TAIL_CAP),
      stderrTail: tail(stderr, OUTPUT_TAIL_CAP),
    };
  }
}

/**
 * Run all probes for a task against a baseline (pristine) directory.
 * Returns true when every probe passes on pristine, meaning the feature
 * already exists before any worker intervention.
 */
export async function runBaselineProbes(args: {
  baselineDir: string;
  probes: readonly ScaleProbe[];
  fixtureNodeModulesPath?: string;
}): Promise<boolean> {
  for (const probe of args.probes) {
    const probeArgs: { workdir: string; probe: ScaleProbe; fixtureNodeModulesPath?: string } = {
      workdir: args.baselineDir,
      probe,
    };
    if (args.fixtureNodeModulesPath !== undefined) {
      probeArgs.fixtureNodeModulesPath = args.fixtureNodeModulesPath;
    }
    const observed = await runBehavioralProbe(probeArgs);
    if (!observed.passed) {
      return false;
    }
  }
  return true;
}

// ---------- Diff presence (design §7, check 1) ----------

export interface DiffPresence {
  readonly nonEmpty: boolean;
  readonly files: number;
  readonly added: number;
  readonly removed: number;
  readonly detail: string;
}

/**
 * `git diff --numstat base head -- paths`: is there any effective change on
 * the task's claimed paths? Git failures degrade to empty (never throws):
 * an unobservable diff cannot attest survival.
 */
export async function diffPresence(args: {
  repoDir: string;
  base: string;
  head: string;
  paths: readonly string[];
}): Promise<DiffPresence> {
  if (args.paths.length === 0) {
    return { nonEmpty: false, files: 0, added: 0, removed: 0, detail: "no claimed paths to diff" };
  }
  try {
    const result = await runGit(["diff", "--numstat", args.base, args.head, "--", ...args.paths], { cwd: args.repoDir });
    let files = 0;
    let added = 0;
    let removed = 0;
    for (const line of result.stdout.split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 3) {
        continue;
      }
      files += 1;
      const add = Number(parts[0]);
      const del = Number(parts[1]);
      if (Number.isInteger(add) && add >= 0) {
        added += add;
      }
      if (Number.isInteger(del) && del >= 0) {
        removed += del;
      }
    }
    return {
      nonEmpty: files > 0,
      files,
      added,
      removed,
      detail: files > 0 ? `${files} files changed over claimed paths` : "no diff over claimed paths",
    };
  } catch (error) {
    return {
      nonEmpty: false,
      files: 0,
      added: 0,
      removed: 0,
      detail: `diff failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// ---------- Attribution (design §7, check 3) ----------

export interface Attribution {
  /** Commits in base..head touching the paths, oldest first; empty on git failure. */
  readonly touching: readonly string[];
  /**
   * Own merges that contributed path changes (non-empty `M^1..M` diff over
   * the paths). Merge-level, not log-level: `git log -- paths` prunes merge
   * commits by history simplification, so attribution must ask each merge
   * what it brought in instead of looking for it in the log.
   */
  readonly own: readonly string[];
  readonly attributed: boolean;
  /** Any own merge is an ancestor of the train head (landed, effective or not). */
  readonly landed: boolean;
}

/** Did this merge change the paths relative to its first parent? Works for regular commits too. */
async function mergeContributedToPaths(args: { repoDir: string; mergeSha: string; paths: readonly string[] }): Promise<boolean> {
  if (args.paths.length === 0) {
    return false;
  }
  try {
    const result = await runGit(["diff", "--numstat", `${args.mergeSha}^1`, args.mergeSha, "--", ...args.paths], {
      cwd: args.repoDir,
    });
    return result.stdout
      .split("\n")
      .some((line) => line.trim().split(/\s+/).length >= 3);
  } catch {
    return false;
  }
}

async function isAncestor(args: { repoDir: string; ancestor: string; head: string }): Promise<boolean> {
  try {
    await runGit(["merge-base", "--is-ancestor", args.ancestor, args.head], { cwd: args.repoDir });
    return true;
  } catch {
    return false;
  }
}

async function pathsChangedSince(args: { repoDir: string; since: string; head: string; paths: readonly string[] }): Promise<boolean> {
  if (args.paths.length === 0 || args.since === args.head) {
    return false;
  }
  try {
    const result = await runGit(["diff", "--numstat", args.since, args.head, "--", ...args.paths], { cwd: args.repoDir });
    return result.stdout
      .split("\n")
      .some((line) => line.trim().split(/\s+/).length >= 3);
  } catch {
    return false;
  }
}

/**
 * `git log base..head -- paths` traces which commits shaped the probed files.
 * Attribution holds when one of the task's own recorded merges both landed
 * in the head's history and contributed path changes (worker-branch merge or
 * a train merge containing it).
 */
export async function attribution(args: {
  repoDir: string;
  base: string;
  head: string;
  paths: readonly string[];
  ownMergeShas: ReadonlySet<string>;
}): Promise<Attribution> {
  let touching: readonly string[] = [];
  if (args.paths.length > 0) {
    try {
      const result = await runGit(["log", "--reverse", "--format=%H", `${args.base}..${args.head}`, "--", ...args.paths], {
        cwd: args.repoDir,
      });
      touching = result.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    } catch {
      touching = [];
    }
  }
  const own: string[] = [];
  let landed = false;
  for (const sha of args.ownMergeShas) {
    const [ancestor, contributed] = await Promise.all([
      isAncestor({ repoDir: args.repoDir, ancestor: sha, head: args.head }),
      mergeContributedToPaths({ repoDir: args.repoDir, mergeSha: sha, paths: args.paths }),
    ]);
    landed = landed || ancestor;
    if (ancestor && contributed) {
      own.push(sha);
    }
  }
  return { touching, own, attributed: own.length > 0, landed };
}

// ---------- Per-task survival verdict (design §7) ----------

/**
 * Decide one task's survival outcome from git evidence plus probe runs:
 * - nothing ever touched the paths and nothing of ours landed → NEVER_MERGED
 * - probe passes + own merge contributed the paths → SURVIVED
 * - probe passes without own contribution → SURVIVED_WITH_REIMPLEMENTATION
 * - probe fails + own contribution landed but the paths changed again
 *   afterwards → REVERTED
 * - probe fails otherwise → OVERWRITTEN
 *
 * All inputs are mechanical (git + process exit codes); no LLM judgment.
 */
export async function evaluateTaskSurvival(args: {
  repoDir: string;
  trainPath: string;
  baseCommit: string;
  trainHead: string;
  taskKey: string;
  /** WRITE-claimed paths of the task. */
  claimedPaths: readonly string[];
  probes: readonly ScaleProbe[];
  /** Merge SHAs attributable to this task (its train merge commits). */
  ownMergeShas: ReadonlySet<string>;
  /** Path to fixture node_modules for NODE_PATH (Amendment A.6). */
  fixtureNodeModulesPath?: string;
  /** True when all probes already pass on pristine baseline. */
  baselinePassed?: boolean;
}): Promise<ScaleTaskSurvival> {
  const common = { repoDir: args.repoDir, base: args.baseCommit, head: args.trainHead, paths: args.claimedPaths };
  const [diff, attr] = await Promise.all([
    diffPresence(common),
    attribution({ ...common, ownMergeShas: args.ownMergeShas }),
  ]);

  let probePassed = true;
  const probeNotes: string[] = [];
  for (const probe of args.probes) {
    const probeArgs: { workdir: string; probe: ScaleProbe; fixtureNodeModulesPath?: string } = { workdir: args.trainPath, probe };
    if (args.fixtureNodeModulesPath !== undefined) {
      probeArgs.fixtureNodeModulesPath = args.fixtureNodeModulesPath;
    }
    const observed = await runBehavioralProbe(probeArgs);
    if (!observed.passed) {
      probePassed = false;
      probeNotes.push(
        `${probe.name}: exit=${observed.exitCode === null ? "null" : observed.exitCode}${observed.timedOut ? " timed out" : ""}`,
      );
    }
  }

  let changedAfterOwn = false;
  if (!probePassed && attr.attributed) {
    for (const sha of attr.own) {
      if (await pathsChangedSince({ repoDir: args.repoDir, since: sha, head: args.trainHead, paths: args.claimedPaths })) {
        changedAfterOwn = true;
        break;
      }
    }
  }

  let status: ScaleSurvivalStatus;
  let detail: string;
  if (attr.touching.length === 0 && !attr.landed) {
    status = "NEVER_MERGED";
    detail = `no commits in base..head touch claimed paths (${diff.detail})`;
  } else if (probePassed && attr.attributed) {
    status = "SURVIVED";
    detail = `probe(s) pass; ${attr.own.length} own merge(s) contributed the paths`;
  } else if (probePassed) {
    status = "SURVIVED_WITH_REIMPLEMENTATION";
    detail = `probe(s) pass but no own merge contributed the paths (${attr.touching.length} other touching commit(s))`;
  } else if (attr.attributed && changedAfterOwn) {
    status = "REVERTED";
    detail = `own work landed (${attr.own.length} own merge(s)) but the paths changed again afterwards; ${probeNotes.join("; ")}`;
  } else {
    status = "OVERWRITTEN";
    detail = `${attr.touching.length} touching commit(s), behavior probe failed; ${probeNotes.join("; ")}`;
  }
  return { key: args.taskKey, status, probePassed, diffNonEmpty: diff.nonEmpty, attributed: attr.attributed, detail, baselinePassed: args.baselinePassed ?? false };
}

/**
 * SURVIVED(+REIMPLEMENTATION) / intended tasks; null only when nothing was intended.
 * Baseline-passing tasks (baselinePassed=true) are excluded from both numerator
 * and denominator: they are valid behavioral verification but not evidence of
 * contribution survival.
 */
export function survivalRate(survivals: readonly ScaleTaskSurvival[]): number | null {
  const eligible = survivals.filter((s) => !s.baselinePassed);
  if (eligible.length === 0) {
    return null;
  }
  const lived = eligible.filter((s) => s.status === "SURVIVED" || s.status === "SURVIVED_WITH_REIMPLEMENTATION").length;
  return lived / eligible.length;
}

/**
 * §6.4 predicate: every intended task survived (reimplementation counts as survival).
 * Baseline-passing tasks are excluded: they were already verified before any
 * worker intervention. Tasks not present in survivals always return false.
 */
export function survivalPredicate(survivals: readonly ScaleTaskSurvival[], intendedKeys: readonly string[]): boolean {
  if (intendedKeys.length === 0) {
    return false;
  }
  const byKey = new Map(survivals.map((s) => [s.key, s] as const));
  return intendedKeys.every((key) => {
    const entry = byKey.get(key);
    if (entry === undefined) {
      return false;
    }
    if (entry.baselinePassed) {
      return true;
    }
    return entry.status === "SURVIVED" || entry.status === "SURVIVED_WITH_REIMPLEMENTATION";
  });
}
