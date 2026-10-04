import { z } from "zod";
import { LEGACY_DATABASE_URL, resolveDatabaseUrl, type StateSource } from "./state.js";

export const AtlasConfigSchema = z.object({
  databaseUrl: z.string().min(1, "DATABASE_URL must not be empty"),
  stateSource: z.enum(["env", "project", "legacy"]).default("legacy"),
  nodeEnv: z.enum(["development", "test", "production"]).default("development"),
  gitBinary: z.string().min(1).default("git"),
  dockerBinary: z.string().min(1).default("docker"),
});

export type AtlasConfig = z.infer<typeof AtlasConfigSchema>;

export function validateConfig(data: unknown): AtlasConfig {
  return AtlasConfigSchema.parse(data);
}

function resolveNodeEnv(value: string | undefined): "development" | "test" | "production" {
  if (value === "development" || value === "test" || value === "production") {
    return value;
  }
  // Zod will reject unknown values via validateConfig; fall back so the
  // error surfaces as a ZodError rather than an implicit default.
  return (value ?? "development") as "development" | "test" | "production";
}

/**
 * Load Atlas configuration from environment variables.
 * Defaults keep a fresh clone working; invalid values throw a ZodError.
 *
 * Database URL resolution (M28.1): explicit `DATABASE_URL` wins, else the
 * nearest `.atlas/atlas.db` walking up from cwd, else the legacy
 * `file:./dev.db` default. Pass `{ cwd }` to resolve for another directory
 * (used by tests and by commands operating on a repository path).
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, options: { cwd?: string } = {}): AtlasConfig {
  const resolved =
    options.cwd === undefined
      ? resolveDatabaseUrl({ env })
      : resolveDatabaseUrl({ cwd: options.cwd, env });
  return validateConfig({
    databaseUrl: resolved.databaseUrl,
    stateSource: resolved.source as StateSource,
    nodeEnv: resolveNodeEnv(env["NODE_ENV"]),
    gitBinary: env["ATLAS_GIT_BINARY"] ?? "git",
    dockerBinary: env["ATLAS_DOCKER_BINARY"] ?? "docker",
  });
}

export { LEGACY_DATABASE_URL };
export type { StateSource };
