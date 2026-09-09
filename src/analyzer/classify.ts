import type { ResourceKind } from "./types.js";

// ---------- Filename vocabularies (bounded, documented) ----------

const LOCKFILE_BASENAMES = new Set([
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "Cargo.lock",
  "poetry.lock",
  "Pipfile.lock",
  "go.sum",
  "Gemfile.lock",
]);

const MANIFEST_BASENAMES = new Set([
  "package.json",
  "Cargo.toml",
  "pyproject.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
]);

const CONFIG_BASENAMES = new Set([
  "tsconfig.json",
  ".eslintrc.json",
  ".prettierrc.json",
  "opencode.json",
  ".npmrc",
  ".nvmrc",
  ".editorconfig",
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
]);

const TEST_DIRNAMES = new Set(["__tests__", "tests", "test", "spec", "specs", "e2e"]);

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".swift",
  ".c",
  ".h",
  ".hpp",
  ".cc",
  ".cpp",
  ".cs",
  ".php",
  ".vue",
  ".svelte",
]);

function basename(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? path : path.slice(slash + 1);
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  // Leading-dot files (`.env`) have no extension; trailing dots have none either.
  if (dot <= 0 || dot === name.length - 1) {
    return "";
  }
  return name.slice(dot).toLowerCase();
}

function isTestBasename(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.includes(".test.") || lower.includes(".spec.") || lower.endsWith("_test.go") || lower.startsWith("test_")
  );
}

function isConfigBasename(name: string): boolean {
  if (CONFIG_BASENAMES.has(name)) {
    return true;
  }
  const lower = name.toLowerCase();
  if (lower === "dockerfile" || lower.startsWith("dockerfile.")) {
    return true;
  }
  if (lower === "tsconfig.json" || (lower.startsWith("tsconfig.") && lower.endsWith(".json"))) {
    return true;
  }
  if (lower === "eslint.config.js" || lower === "eslint.config.mjs" || lower.startsWith(".eslintrc")) {
    return true;
  }
  // `<name>.config.<ext>` convention (vite, vitest, prettier, jest, ...).
  return /\.config\.(js|mjs|cjs|ts|mts|json|yaml|yml|toml)$/.test(lower);
}

/**
 * Classify one repository-relative file path. Pure and deterministic.
 * Precedence: SCHEMA > MIGRATION > LOCKFILE > PACKAGE_MANIFEST > CONFIG >
 * TEST > SOURCE > FILE, so `src/foo.test.ts` is TEST, not SOURCE.
 */
export function classifyResourceFile(path: string): ResourceKind {
  const segments = path.split("/");
  const name = basename(path);
  if (name === "schema.prisma") {
    return "SCHEMA";
  }
  if (segments.length > 1 && segments[0] === "prisma" && segments[1] === "migrations") {
    return "MIGRATION";
  }
  if (LOCKFILE_BASENAMES.has(name)) {
    return "LOCKFILE";
  }
  if (MANIFEST_BASENAMES.has(name)) {
    return "PACKAGE_MANIFEST";
  }
  if (isConfigBasename(name)) {
    return "CONFIG";
  }
  if (segments.some((segment) => TEST_DIRNAMES.has(segment)) || isTestBasename(name)) {
    return "TEST";
  }
  if (segments[0] === "src" || SOURCE_EXTENSIONS.has(extensionOf(name))) {
    return "SOURCE";
  }
  return "FILE";
}

/**
 * Classify an ancestor directory id. Directories are DIRECTORY, except the
 * Prisma migrations tree, which is migration territory (matches the
 * `prisma/migrations/` resource convention).
 */
export function classifyResourceDirectory(id: string): ResourceKind {
  return id === "prisma/migrations" || id.startsWith("prisma/migrations/") ? "MIGRATION" : "DIRECTORY";
}
