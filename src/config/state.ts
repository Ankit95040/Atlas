import { existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

// Per-project state isolation (M28.1 Phase B).
//
// Atlas historically used one checkout-fixed database (`file:./dev.db`,
// resolved by Prisma relative to prisma/schema.prisma) no matter where it
// was invoked. That silently shares project state across repositories.
// Resolution order below is explicit and documented:
//
//   1. `DATABASE_URL` env var — explicit operator intent, always wins.
//   2. Nearest `<dir>/.atlas/atlas.db` walking up from cwd — a provisioned
//      per-project state home. The FILE must exist; a bare `.atlas/`
//      directory alone never redirects (avoids hijacking by stray dirs).
//   3. Legacy default `file:./dev.db` — existing single-repo installs keep
//      working with zero behavior change and zero data-loss risk.
//
// No destructive migration, no auto-provisioning: a missing project DB
// file is an actionable error at the call site that requires one, never
// a silent fallback in the other direction.

export const ATLAS_STATE_DIRNAME = ".atlas";
export const ATLAS_STATE_FILENAME = "atlas.db";
export const LEGACY_DATABASE_URL = "file:./dev.db";

export type StateSource = "env" | "project" | "legacy";

export interface ResolvedState {
  readonly databaseUrl: string;
  readonly source: StateSource;
  /** Absolute directory holding the project DB file, or null for env/legacy. */
  readonly stateDir: string | null;
}

function isFileSystemRoot(dir: string): boolean {
  return dirname(dir) === dir;
}

/**
 * Nearest ancestor-or-self directory whose `.atlas/atlas.db` file exists.
 * Pure filesystem walk, no I/O beyond existence checks; stops at the root.
 */
export function findProjectStateDir(startDir: string): string | null {
  let dir = resolve(startDir);
  while (true) {
    if (existsSync(join(dir, ATLAS_STATE_DIRNAME, ATLAS_STATE_FILENAME))) {
      return dir;
    }
    if (isFileSystemRoot(dir)) {
      return null;
    }
    dir = dirname(dir);
  }
}

export function stateDatabaseUrlForDir(dir: string): string {
  return `file:${join(dir, ATLAS_STATE_DIRNAME, ATLAS_STATE_FILENAME)}`;
}

export function resolveDatabaseUrl(options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): ResolvedState {
  const env = options.env ?? process.env;
  const explicit = env["DATABASE_URL"];
  // Only an ABSENT variable falls through to project/legacy resolution.
  // An explicitly empty DATABASE_URL keeps its historical meaning: invalid,
  // rejected downstream by schema validation (never silently defaulted).
  if (explicit !== undefined) {
    return { databaseUrl: explicit, source: "env", stateDir: null };
  }
  const cwd = options.cwd ?? process.cwd();
  const projectDir = findProjectStateDir(cwd);
  if (projectDir !== null) {
    return { databaseUrl: stateDatabaseUrlForDir(projectDir), source: "project", stateDir: join(projectDir, ATLAS_STATE_DIRNAME) };
  }
  return { databaseUrl: LEGACY_DATABASE_URL, source: "legacy", stateDir: null };
}

/**
 * Resolve an explicit `--state-dir` into a usable database URL. The
 * directory is created (harmless, non-destructive); a missing database
 * file is an actionable error, never silent auto-provisioning: schema
 * application (`prisma db push`) is a deliberate operator step.
 */
export function resolveExplicitStateDir(stateDir: string): { databaseUrl: string; stateDir: string } {
  const absolute = isAbsolute(stateDir) ? stateDir : resolve(process.cwd(), stateDir);
  mkdirSync(absolute, { recursive: true });
  const dbFile = join(absolute, ATLAS_STATE_FILENAME);
  if (!existsSync(dbFile)) {
    throw new Error(
      `atlas state database not found at ${dbFile}. ` +
        `Provision it first (e.g. DATABASE_URL='file:${dbFile}' prisma db push --schema <atlas-checkout>/prisma/schema.prisma), ` +
        `then re-run with --state-dir ${absolute}.`,
    );
  }
  return { databaseUrl: `file:${dbFile}`, stateDir: absolute };
}
