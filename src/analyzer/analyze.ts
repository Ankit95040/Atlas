import { GitCommandError, getCurrentCommit, getRepositoryRoot, runGit } from "../git/index.js";
import { classifyResourceDirectory, classifyResourceFile } from "./classify.js";
import { RepositoryAnalysisError } from "./errors.js";
import type { RepositoryAnalysis, ResourceEntry } from "./types.js";

// Deliberately excluded even when tracked: dependency payloads are never Atlas
// resources, and OS droppings are noise. Everything else tracked is real repo
// content (including committed build dirs — hiding those would lie about the
// repo). `.git/` internals can never appear: `git ls-files` never lists them.
const EXCLUDED_DIRNAMES = new Set(["node_modules"]);
const EXCLUDED_BASENAMES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

function isExcluded(relativePath: string): boolean {
  const segments = relativePath.split("/");
  const last = segments[segments.length - 1];
  if (last !== undefined && EXCLUDED_BASENAMES.has(last)) {
    return true;
  }
  return segments.some((segment) => EXCLUDED_DIRNAMES.has(segment));
}

/**
 * Tracked files as repository-relative POSIX paths, via `git ls-files`.
 * Tracked-only for V0.1: untracked/scratch files are not Atlas resources.
 */
export async function listTrackedFiles(repositoryRoot: string): Promise<string[]> {
  const result = await runGit(["ls-files", "-z"], { cwd: repositoryRoot });
  return result.stdout
    .split("\0")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && !isExcluded(entry));
}

function ancestorDirectories(fileId: string): string[] {
  const segments = fileId.split("/").slice(0, -1);
  const dirs: string[] = [];
  for (let depth = 1; depth <= segments.length; depth += 1) {
    dirs.push(segments.slice(0, depth).join("/"));
  }
  return dirs;
}

function compareById(a: ResourceEntry, b: ResourceEntry): number {
  if (a.id < b.id) {
    return -1;
  }
  if (a.id > b.id) {
    return 1;
  }
  return 0;
}

/**
 * Deterministic structural analysis pinned to the current HEAD commit.
 * Same repository + same commit + same analyzer = same resource map:
 * resources are re-sorted explicitly, never in traversal order.
 */
export async function analyzeRepository(repoPath: string): Promise<RepositoryAnalysis> {
  const repositoryRoot = await getRepositoryRoot(repoPath);
  let analyzedCommit: string;
  try {
    analyzedCommit = await getCurrentCommit(repositoryRoot);
  } catch (error) {
    if (error instanceof GitCommandError) {
      throw new RepositoryAnalysisError(
        `cannot analyze ${repositoryRoot} without a committed HEAD: ${error.message}`,
      );
    }
    throw error;
  }

  const byId = new Map<string, ResourceEntry>();
  for (const file of await listTrackedFiles(repositoryRoot)) {
    byId.set(file, { id: file, kind: classifyResourceFile(file) });
    for (const dir of ancestorDirectories(file)) {
      const existing = byId.get(dir);
      if (existing === undefined) {
        byId.set(dir, { id: dir, kind: classifyResourceDirectory(dir) });
      }
    }
  }

  const resources = [...byId.values()].sort(compareById);
  return { repositoryRoot, analyzedCommit, resourceCount: resources.length, resources };
}
