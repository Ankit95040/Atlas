import type { PrismaClient } from "@prisma/client";
import { getPrismaClient } from "../db/client.js";
import { resolveExplicitStateDir } from "../config/state.js";
import { createFeature, createProject, createRepository } from "../core/service.js";
import { validateRepository } from "../git/index.js";
import { EXIT_OK, type CommandOutput } from "./output.js";

function usageError(message: string): Error {
  const error = new Error(message);
  error.name = "InitUsageError";
  return error;
}

export interface InitCommandOptions {
  readonly name?: string;
  readonly repoPath?: string;
  readonly featureTitle?: string;
  readonly description?: string;
  readonly featureDescription?: string;
  readonly remoteUrl?: string;
  readonly defaultBranch?: string;
  /**
   * Explicit per-project state directory (M28.1). Its `atlas.db` is used
   * for all init writes; a missing file is an actionable error, never
   * silent provisioning. Omit to use ambient resolution.
   */
  readonly stateDir?: string;
}

/**
 * `atlas init`: the supported path from a fresh clone to a first plan.
 * Validates the repository path is a Git checkout, then creates the three
 * prerequisite rows (`atlas plan` needs a feature; `atlas run` needs a
 * feature plus a repository) by reusing the existing core service functions.
 * No new semantics: creation validation lives in `src/core/inputs.ts`.
 */
export async function runInitCommand(
  options: InitCommandOptions & { db?: PrismaClient; stateDatabaseUrl?: string },
  db: PrismaClient = getPrismaClient(),
): Promise<CommandOutput> {
  const store = options.db ?? db;  const name = options.name?.trim() ?? "";
  const repoPath = options.repoPath?.trim() ?? "";
  const featureTitle = options.featureTitle?.trim() ?? "";
  if (name.length === 0) {
    throw usageError("init requires --name <project-name>");
  }
  if (repoPath.length === 0) {
    throw usageError("init requires --repo-path <path-to-git-checkout>");
  }
  if (featureTitle.length === 0) {
    throw usageError("init requires --feature-title <title>");
  }
  // Fail fast before any database writes when the path is not a Git checkout.
  const repoRoot = await validateRepository(repoPath);
  const project = await createProject(
    {
      name,
      ...(options.description !== undefined ? { description: options.description } : {}),
    },
    store,
  );
  const repository = await createRepository(
    {
      projectId: project.id,
      name: "main",
      localPath: repoRoot,
      ...(options.remoteUrl !== undefined ? { remoteUrl: options.remoteUrl } : {}),
      ...(options.defaultBranch !== undefined ? { defaultBranch: options.defaultBranch } : {}),
    },
    store,
  );
  const feature = await createFeature(
    {
      projectId: project.id,
      title: featureTitle,
      ...(options.featureDescription !== undefined ? { description: options.featureDescription } : {}),
    },
    store,
  );
  const human = [
    "atlas init",
    `project: ${project.id} (${project.name})`,
    `repository: ${repository.id} (${repository.localPath})`,
    `feature: ${feature.id} (${feature.title})`,
    ...(options.stateDatabaseUrl !== undefined ? [`state: ${options.stateDatabaseUrl}`] : []),
    `next: atlas plan --feature ${feature.id} --proposal <proposal-file>`,
  ].join("\n");
  return {
    exitCode: EXIT_OK,
    human,
    data: {
      projectId: project.id,
      repositoryId: repository.id,
      featureId: feature.id,
      ...(options.stateDatabaseUrl !== undefined ? { stateDatabaseUrl: options.stateDatabaseUrl } : {}),
      nextCommand: `atlas plan --feature ${feature.id} --proposal <proposal-file>`,
    },
  };
}
