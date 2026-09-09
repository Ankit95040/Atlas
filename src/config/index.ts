import { z } from "zod";

export const AtlasConfigSchema = z.object({
  databaseUrl: z.string().min(1, "DATABASE_URL must not be empty"),
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
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AtlasConfig {
  return validateConfig({
    databaseUrl: env["DATABASE_URL"] ?? "file:./dev.db",
    nodeEnv: resolveNodeEnv(env["NODE_ENV"]),
    gitBinary: env["ATLAS_GIT_BINARY"] ?? "git",
    dockerBinary: env["ATLAS_DOCKER_BINARY"] ?? "docker",
  });
}
