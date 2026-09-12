import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getCurrentCommit, runGit } from "../git/index.js";
import { BenchmarkError } from "./errors.js";
import { BenchmarkScenarioSchema, type BenchmarkScenario } from "./types.js";

const CHECK_PREAMBLE = `import { existsSync, readFileSync } from "node:fs";
function assertFile(rel, expected) {
  const actual = readFileSync(rel, "utf8");
  if (actual !== expected) {
    console.error("mismatch in " + rel + ": " + JSON.stringify(actual));
    process.exit(1);
  }
}
function assertAllowed(rel, allowed) {
  const actual = readFileSync(rel, "utf8");
  if (!allowed.includes(actual)) {
    console.error("unexpected content in " + rel + ": " + JSON.stringify(actual));
    process.exit(1);
  }
}
`;

function scopedCheck(scopes: Record<string, string[]>, full: Array<{ rel: string; allowed: string[] }>): string {
  const cases = Object.entries(scopes)
    .map(([scope, lines]) => `if (scope === ${JSON.stringify(scope)}) {\n${lines.join("\n")}\n  process.exit(0);\n}`)
    .join("\n");
  const cumulative = full
    .map(({ rel, allowed }) => {
      const list = allowed.map((value) => JSON.stringify(value)).join(", ");
      return `if (existsSync(${JSON.stringify(rel)})) assertAllowed(${JSON.stringify(rel)}, [${list}]);`;
    })
    .join("\n");
  return `${CHECK_PREAMBLE}const scope = process.argv[2];\n${cases}\n${cumulative}\nprocess.exit(0);\n`;
}

const PACKAGE_JSON = JSON.stringify({ name: "benchmark-fixture", scripts: { test: "node check.mjs" } });

function defineScenario(raw: unknown): BenchmarkScenario {
  return BenchmarkScenarioSchema.parse(raw);
}

export function separateAuthAndBilling(): BenchmarkScenario {
  return defineScenario({
    id: "separate-auth-and-billing",
    name: "Separate auth and billing",
    description: "Two tasks write disjoint files; safe parallelism is expected.",
    kind: "INDEPENDENT_TASKS",
    featureSpec: { title: "Auth and billing pages", description: "Add a login page and an invoice page." },
    features: [{ key: "feat", title: "Pages" }],
    files: [
      { path: "src/auth/login.ts", content: "base\n" },
      { path: "src/billing/invoice.ts", content: "base\n" },
    ],
    testScript: scopedCheck(
      {
        auth: [`  assertFile("src/auth/login.ts", "auth-v2\\n");`],
        billing: [`  assertFile("src/billing/invoice.ts", "billing-v2\\n");`],
      },
      [
        { rel: "src/auth/login.ts", allowed: ["base\n", "auth-v2\n"] },
        { rel: "src/billing/invoice.ts", allowed: ["base\n", "billing-v2\n"] },
      ],
    ),
    tasks: [
      {
        key: "auth",
        title: "Build login page",
        featureKey: "feat",
        files: [{ path: "src/auth/login.ts", content: "auth-v2\n" }],
        claims: [{ resource: "src/auth/login.ts", access: "WRITE" }],
        dependsOn: [],
        simulatedDurationMs: 200,
        simulatedCostUsd: 0.01,
        testScope: "auth",
      },
      {
        key: "billing",
        title: "Build invoice page",
        featureKey: "feat",
        files: [{ path: "src/billing/invoice.ts", content: "billing-v2\n" }],
        claims: [{ resource: "src/billing/invoice.ts", access: "WRITE" }],
        dependsOn: [],
        simulatedDurationMs: 200,
        simulatedCostUsd: 0.01,
        testScope: "billing",
      },
    ],
    expectedOutcome: "ATLAS schedules one wave of two; all strategies integrate successfully.",
  });
}

export function sharedCounter(): BenchmarkScenario {
  return defineScenario({
    id: "shared-counter",
    name: "Shared counter file",
    description: "Two tasks rewrite the same line of one file; serialization is expected.",
    kind: "SHARED_RESOURCE",
    featureSpec: { title: "Counter updates", description: "Two writers update one counter file." },
    features: [{ key: "feat", title: "Counter" }],
    files: [{ path: "shared/counter.txt", content: "count: 0\nupdated: never\ntotal: 0\n" }],
    testScript: scopedCheck(
      {
        alpha: [`  assertFile("shared/counter.txt", "count: 0\\nupdated: alpha\\ntotal: 0\\n");`],
        beta: [`  assertFile("shared/counter.txt", "count: 0\\nupdated: beta\\ntotal: 0\\n");`],
      },
      [{ rel: "shared/counter.txt", allowed: ["count: 0\nupdated: never\ntotal: 0\n", "count: 0\nupdated: alpha\ntotal: 0\n", "count: 0\nupdated: beta\ntotal: 0\n"] }],
    ),
    tasks: [
      {
        key: "alpha",
        title: "Alpha writer",
        featureKey: "feat",
        files: [{ path: "shared/counter.txt", content: "count: 0\nupdated: alpha\ntotal: 0\n" }],
        claims: [{ resource: "shared/counter.txt", access: "WRITE" }],
        dependsOn: [],
        simulatedDurationMs: 200,
        simulatedCostUsd: 0.01,
        testScope: "alpha",
      },
      {
        key: "beta",
        title: "Beta writer",
        featureKey: "feat",
        files: [{ path: "shared/counter.txt", content: "count: 0\nupdated: beta\ntotal: 0\n" }],
        claims: [{ resource: "shared/counter.txt", access: "WRITE" }],
        dependsOn: [],
        simulatedDurationMs: 200,
        simulatedCostUsd: 0.01,
        testScope: "beta",
      },
    ],
    expectedOutcome:
      "ATLAS serializes via the resource-claim conflict; DUMB_PARALLEL halts with a genuine Git merge conflict. " +
      "Serialization is execution-only (both worktrees stay based on the same commit), so the ATLAS train also " +
      "halts with exactly one conflict: expected result is HALTED + CONFLICT, integrated in scheduler wave order.",
  });
}

export function migrateThenUse(): BenchmarkScenario {
  return defineScenario({
    id: "migrate-then-use",
    name: "Migrate then use",
    description: "Task B depends on task A; ordering must be respected.",
    kind: "DEPENDENCY_CHAIN",
    featureSpec: { title: "Schema then client", description: "Write a schema file, then a client that uses it." },
    features: [{ key: "feat", title: "Chain" }],
    files: [],
    testScript: scopedCheck(
      {
        schema: [`  assertFile("src/schema.txt", "v2\\n");`],
        client: [`  assertFile("src/client.txt", "client\\n");`],
      },
      [{ rel: "src/schema.txt", allowed: ["v2\n"] }, { rel: "src/client.txt", allowed: ["client\n"] }],
    ),
    tasks: [
      {
        key: "schema",
        title: "Write schema",
        featureKey: "feat",
        files: [{ path: "src/schema.txt", content: "v2\n" }],
        claims: [{ resource: "src/schema.txt", access: "WRITE" }],
        dependsOn: [],
        simulatedDurationMs: 200,
        simulatedCostUsd: 0.01,
        testScope: "schema",
      },
      {
        key: "client",
        title: "Write client",
        featureKey: "feat",
        files: [{ path: "src/client.txt", content: "client\n" }],
        claims: [{ resource: "src/client.txt", access: "WRITE" }],
        dependsOn: ["schema"],
        simulatedDurationMs: 200,
        simulatedCostUsd: 0.01,
        testScope: "client",
      },
    ],
    expectedOutcome: "ATLAS schedules waves [[schema],[client]]; every strategy integrates both tasks.",
  });
}

export function mixedPipeline(): BenchmarkScenario {
  return defineScenario({
    id: "mixed-pipeline",
    name: "Mixed pipeline",
    description: "Two independent tasks plus a third depending on one and conflicting with the other.",
    kind: "MIXED",
    featureSpec: { title: "Mixed work", description: "Partial parallelism with one serialization point." },
    features: [{ key: "feat", title: "Mixed" }],
    files: [{ path: "src/a.txt", content: "base\n" }, { path: "src/b.txt", content: "line1: base\n" }],
    testScript: scopedCheck(
      {
        a: [`  assertFile("src/a.txt", "a\\n");`],
        b: [`  assertFile("src/b.txt", "line1: bbb\\n");`],
        c: [`  assertFile("src/b.txt", "line1: ccc\\n");`],
      },
      [
        { rel: "src/a.txt", allowed: ["base\n", "a\n"] },
        { rel: "src/b.txt", allowed: ["line1: base\n", "line1: bbb\n", "line1: ccc\n"] },
      ],
    ),
    tasks: [
      {
        key: "a",
        title: "Task A",
        featureKey: "feat",
        files: [{ path: "src/a.txt", content: "a\n" }],
        claims: [{ resource: "src/a.txt", access: "WRITE" }],
        dependsOn: [],
        simulatedDurationMs: 200,
        simulatedCostUsd: 0.01,
        testScope: "a",
      },
      {
        key: "b",
        title: "Task B",
        featureKey: "feat",
        files: [{ path: "src/b.txt", content: "line1: bbb\n" }],
        claims: [{ resource: "src/b.txt", access: "WRITE" }],
        dependsOn: [],
        simulatedDurationMs: 200,
        simulatedCostUsd: 0.01,
        testScope: "b",
      },
      {
        key: "c",
        title: "Task C",
        featureKey: "feat",
        files: [{ path: "src/b.txt", content: "line1: ccc\n" }],
        claims: [{ resource: "src/b.txt", access: "WRITE" }],
        dependsOn: ["a"],
        simulatedDurationMs: 200,
        simulatedCostUsd: 0.01,
        testScope: "c",
      },
    ],
    expectedOutcome:
      "ATLAS finds partial parallelism ([a,b] then [c]); integration yields exactly two merges and one genuine conflict " +
      "(c always conflicts with b regardless of order; A itself never conflicts).",
  });
}

export function crossFeatureApiWeb(): BenchmarkScenario {
  return defineScenario({
    id: "cross-feature-api-web",
    name: "Cross-feature API and web",
    description: "A web task depends on an API task in a different feature.",
    kind: "CROSS_FEATURE_DEPENDENCY",
    featureSpec: { title: "API and web", description: "API work enables web work across features." },
    features: [
      { key: "api", title: "API" },
      { key: "web", title: "Web" },
    ],
    files: [],
    testScript: scopedCheck(
      {
        api: [`  assertFile("src/api.txt", "api\\n");`],
        web: [`  assertFile("src/web.txt", "web\\n");`],
      },
      [{ rel: "src/api.txt", allowed: ["api\n"] }, { rel: "src/web.txt", allowed: ["web\n"] }],
    ),
    tasks: [
      {
        key: "api",
        title: "API task",
        featureKey: "api",
        files: [{ path: "src/api.txt", content: "api\n" }],
        claims: [{ resource: "src/api.txt", access: "WRITE" }],
        dependsOn: [],
        simulatedDurationMs: 200,
        simulatedCostUsd: 0.01,
        testScope: "api",
      },
      {
        key: "web",
        title: "Web task",
        featureKey: "web",
        files: [{ path: "src/web.txt", content: "web\n" }],
        claims: [{ resource: "src/web.txt", access: "WRITE" }],
        dependsOn: ["api"],
        simulatedDurationMs: 200,
        simulatedCostUsd: 0.01,
        testScope: "web",
      },
    ],
    expectedOutcome: "ATLAS handles the cross-feature edge; all strategies integrate both tasks.",
  });
}

export function authBillingSharedConfig(): BenchmarkScenario {
  return defineScenario({
    id: "auth-billing-shared-config",
    name: "Auth/billing shared config",
    description: "Domain labels suggest independence, but both tasks rewrite one config file.",
    kind: "FALSE_PARALLELISM",
    featureSpec: { title: "Overhauls", description: "Two misleadingly unrelated overhauls share one config." },
    features: [{ key: "feat", title: "Overhauls" }],
    files: [{ path: "shared/config.txt", content: "mode: base\nretries: 0\nlog: off\n" }],
    testScript: scopedCheck(
      {
        auth: [`  assertFile("shared/config.txt", "mode: auth\\nretries: 0\\nlog: off\\n");`],
        billing: [`  assertFile("shared/config.txt", "mode: billing\\nretries: 0\\nlog: off\\n");`],
      },
      [
        { rel: "shared/config.txt", allowed: ["mode: base\nretries: 0\nlog: off\n", "mode: auth\nretries: 0\nlog: off\n", "mode: billing\nretries: 0\nlog: off\n"] },
      ],
    ),
    tasks: [
      {
        key: "auth",
        title: "Auth overhaul",
        featureKey: "feat",
        files: [{ path: "shared/config.txt", content: "mode: auth\nretries: 0\nlog: off\n" }],
        claims: [{ resource: "shared/config.txt", access: "WRITE" }],
        dependsOn: [],
        simulatedDurationMs: 200,
        simulatedCostUsd: 0.01,
        testScope: "auth",
      },
      {
        key: "billing",
        title: "Billing overhaul",
        featureKey: "feat",
        files: [{ path: "shared/config.txt", content: "mode: billing\nretries: 0\nlog: off\n" }],
        claims: [{ resource: "shared/config.txt", access: "WRITE" }],
        dependsOn: [],
        simulatedDurationMs: 200,
        simulatedCostUsd: 0.01,
        testScope: "billing",
      },
    ],
    expectedOutcome:
      "ATLAS serializes on the resource conflict despite unrelated domain labels; DUMB_PARALLEL halts with a genuine Git merge conflict. " +
      "Expected ATLAS result is HALTED + CONFLICT, integrated in scheduler wave order (first wave's task wins).",
  });
}

const BUILDERS: Record<string, () => BenchmarkScenario> = {
  "separate-auth-and-billing": separateAuthAndBilling,
  "shared-counter": sharedCounter,
  "migrate-then-use": migrateThenUse,
  "mixed-pipeline": mixedPipeline,
  "cross-feature-api-web": crossFeatureApiWeb,
  "auth-billing-shared-config": authBillingSharedConfig,
};

export function listScenarioIds(): string[] {
  return Object.keys(BUILDERS).sort();
}

export function getScenario(id: string): BenchmarkScenario {
  const build = BUILDERS[id];
  if (build === undefined) {
    throw new BenchmarkError(`unknown benchmark scenario: ${id}`);
  }
  return build();
}

/**
 * Materialize a scenario fixture: fresh temp repo, scenario files plus a
 * package.json test harness, single base commit. Returns the repo dir and
 * the base commit every strategy in the run must start from.
 */
export async function buildScenarioRepo(
  scenario: BenchmarkScenario,
  dir: string,
): Promise<{ repoDir: string; baseCommit: string }> {
  try {
    await writeFile(join(dir, "package.json"), PACKAGE_JSON);
    await writeFile(join(dir, "check.mjs"), scenario.testScript);
    for (const file of scenario.files) {
      const absolute = join(dir, file.path);
      await mkdir(join(absolute, ".."), { recursive: true });
      await writeFile(absolute, file.content);
    }
    await runGit(["init", "-b", "main"], { cwd: dir });
    await runGit(["config", "user.email", "atlas-benchmark@example.invalid"], { cwd: dir });
    await runGit(["config", "user.name", "Atlas Benchmark"], { cwd: dir });
    await runGit(["add", "-A"], { cwd: dir });
    await runGit(["-c", "commit.gpgsign=false", "commit", "-m", `benchmark fixture ${scenario.id}`], { cwd: dir });
    return { repoDir: dir, baseCommit: await getCurrentCommit(dir) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new BenchmarkError(`fixture setup failed for scenario ${scenario.id}: ${message}`);
  }
}
