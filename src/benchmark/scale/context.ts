import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { renderSingleAgentPrompt, renderTaskPrompt, type PromptTaskView } from "../real/prompts.js";
import { TOKEN_ESTIMATOR_VERSION, type ScaleWorkloadSpec } from "./types.js";

export { TOKEN_ESTIMATOR_VERSION } from "./types.js";

// ---------- Token estimator (Amendment A.2) ----------

/**
 * Deterministic token estimator: ceil(UTF-16-byte-length / 4).
 * Versioned (TOKEN_ESTIMATOR_VERSION = 1); increment when the formula changes.
 * Known ±30% absolute error — acceptable because M18 comparisons are relative.
 * Provider-reported usage recorded alongside when observed, never mixed in.
 */
export function estimateTokens(text: string): number {
  const bytes = Buffer.byteLength(text, "utf16le");
  return Math.ceil(bytes / 4);
}

// ---------- Snapshot exclusion rules (Amendment A.2 §R) ----------

const SNAPSHOT_EXCLUDE_DIRS = new Set(["node_modules", ".git", "dist", "build"]);
const SNAPSHOT_EXCLUDE_FILES = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml"]);
const MAX_FILE_SIZE_BYTES = 1_000_000; // 1 MB

async function collectTextFiles(dir: string, root: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SNAPSHOT_EXCLUDE_DIRS.has(entry.name)) {
        continue;
      }
      files.push(...(await collectTextFiles(fullPath, root)));
    } else if (entry.isFile()) {
      if (SNAPSHOT_EXCLUDE_FILES.has(entry.name)) {
        continue;
      }
      const s = await stat(fullPath).catch(() => null);
      if (s === null || s.size > MAX_FILE_SIZE_BYTES || s.size === 0) {
        continue;
      }
      files.push(relative(root, fullPath));
    }
  }
  return files;
}

// ---------- §R: Repository token count ----------

/**
 * Measure §R: tokens over vendored snapshot text files (excl. node_modules,
 * .git, dist, build, lockfiles, files >1 MB).
 * Returns { totalTokens, fileCount } or null if sourceDir does not exist.
 */
export async function measureRepoTokens(sourceDir: string): Promise<{ totalTokens: number; fileCount: number } | null> {
  const sourceStat = await stat(sourceDir).catch(() => null);
  if (sourceStat === null || !sourceStat.isDirectory()) {
    return null;
  }
  const files = await collectTextFiles(sourceDir, sourceDir);
  let totalTokens = 0;
  for (const relPath of files) {
    const content = await readFile(join(sourceDir, relPath), "utf8").catch(() => null);
    if (content !== null) {
      totalTokens += estimateTokens(content);
    }
  }
  return { totalTokens, fileCount: files.length };
}

// ---------- §T: Task-relevant token count ----------

/**
 * Measure §T: tokens over the union of task-claimed WRITE paths (expanded to
 * files) + testCommand scope files + feature-spec fixture files.
 * Computed from the frozen spec; no agent involved.
 */
export async function measureTaskRelevantTokens(args: {
  readonly workload: ScaleWorkloadSpec;
  readonly fixtureDir: string;
}): Promise<number> {
  const { workload, fixtureDir } = args;
  const sourceStat = await stat(fixtureDir).catch(() => null);
  if (sourceStat === null || !sourceStat.isDirectory()) {
    return 0;
  }

  // Collect all paths from claims, test files, and base files
  const claimedPaths = new Set<string>();
  for (const task of workload.tasks) {
    for (const claim of task.claims) {
      claimedPaths.add(claim.resource);
    }
  }
  // Add test file paths
  for (const file of workload.testFiles) {
    claimedPaths.add(file.path);
  }
  // Add base file paths
  for (const file of workload.baseFiles) {
    claimedPaths.add(file.path);
  }

  // Expand paths to actual files in the fixture
  const relevantFiles = new Set<string>();
  for (const claimedPath of claimedPaths) {
    const fullPath = join(fixtureDir, claimedPath);
    const s = await stat(fullPath).catch(() => null);
    if (s === null) {
      continue;
    }
    if (s.isFile()) {
      relevantFiles.add(claimedPath);
    }
    // If it's a directory, expand to files within it (non-recursive for now)
    if (s.isDirectory()) {
      const files = await readdir(fullPath, { withFileTypes: true }).catch(() => []);
      for (const entry of files) {
        if (entry.isFile()) {
          relevantFiles.add(join(claimedPath, entry.name));
        }
      }
    }
  }

  let totalTokens = 0;
  for (const relPath of relevantFiles) {
    const content = await readFile(join(fixtureDir, relPath), "utf8").catch(() => null);
    if (content !== null) {
      totalTokens += estimateTokens(content);
    }
  }
  return totalTokens;
}

// ---------- §V: Prompt token computation (exact renderer output) ----------

/**
 * Build a PromptTaskView from a ScaleWorkloadSpec task, matching the
 * transformation used by the frozen arms (strategies.ts promptView helper).
 */
function scaleTaskToPromptView(task: ScaleWorkloadSpec["tasks"][number]): PromptTaskView {
  return {
    key: task.key,
    title: task.title,
    description: task.description,
    claims: task.claims.map((c) => ({ ...c })),
  };
}

/**
 * Render the exact SINGLE_AGENT union prompt via the frozen renderer
 * (renderSingleAgentPrompt from real/prompts.ts). Returns the prompt string
 * whose byte length is measured as §V for the SA arm.
 */
export function renderSaUnionPrompt(scale: ScaleWorkloadSpec): string {
  const ordered = [...scale.tasks].sort((a, b) => (a.key < b.key ? -1 : 1));
  return renderSingleAgentPrompt(ordered.map(scaleTaskToPromptView), scale.featureSpec.title);
}

/**
 * Render the exact per-task prompt via the frozen renderer
 * (renderTaskPrompt from real/prompts.ts). Returns the prompt string
 * whose byte length is measured as §V for one AE invocation.
 */
export function renderAeTaskPrompt(task: ScaleWorkloadSpec["tasks"][number], featureTitle: string): string {
  return renderTaskPrompt(scaleTaskToPromptView(task), featureTitle);
}

/**
 * Measure prompt tokens from the exact prompt string the harness passes to
 * the provider. This is §V: "tokens in the exact prompt argv bytes the
 * harness passes to the provider." The prompt string is the renderer output;
 * the harness appends it as the final argv element via buildAgentCommand.
 */
export function measurePromptTokensFromPromptString(promptString: string): number {
  return estimateTokens(promptString);
}

// ---------- Context record assembly ----------

export interface ContextRecord {
  readonly estimatorVersion: typeof TOKEN_ESTIMATOR_VERSION;
  readonly modelCapacityTokens: number;
  readonly repoTokens: number;
  readonly taskRelevantTokens: number;
  readonly promptTokensMax: number;
  readonly promptTokensMean: number;
  readonly utilizationMax: number;
}

/**
 * Assemble the context record for a single run.
 * Call after all prompt argvs are known (one for SA, one or more for AE).
 */
export function assembleContextRecord(args: {
  readonly modelCapacityTokens: number;
  readonly repoTokens: number;
  readonly taskRelevantTokens: number;
  readonly promptTokenCounts: readonly number[];
}): ContextRecord {
  const { modelCapacityTokens, repoTokens, taskRelevantTokens, promptTokenCounts } = args;
  if (promptTokenCounts.length === 0) {
    return {
      estimatorVersion: TOKEN_ESTIMATOR_VERSION,
      modelCapacityTokens,
      repoTokens,
      taskRelevantTokens,
      promptTokensMax: 0,
      promptTokensMean: 0,
      utilizationMax: 0,
    };
  }
  const promptTokensMax = Math.max(...promptTokenCounts);
  const promptTokensMean = promptTokenCounts.reduce((sum, t) => sum + t, 0) / promptTokenCounts.length;
  const utilizationMax = modelCapacityTokens > 0 ? promptTokensMax / modelCapacityTokens : 0;
  return {
    estimatorVersion: TOKEN_ESTIMATOR_VERSION,
    modelCapacityTokens,
    repoTokens,
    taskRelevantTokens,
    promptTokensMax,
    promptTokensMean,
    utilizationMax,
  };
}
