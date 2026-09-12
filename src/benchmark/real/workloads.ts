import { BenchmarkError } from "../errors.js";
import { RealWorkloadSpecSchema, type RealWorkloadSpec } from "./types.js";

function defineWorkload(raw: unknown): RealWorkloadSpec {
  return RealWorkloadSpecSchema.parse(raw);
}

const NODE_TEST = ["node", "--test"];

export function realisticIndependent(): RealWorkloadSpec {
  return defineWorkload({
    id: "realistic-independent",
    name: "Independent auth and billing modules",
    description: "Two disjoint modules with real node:test suites; safe parallelism is expected.",
    kind: "REALISTIC_INDEPENDENT",
    featureSpec: { title: "Auth and billing modules", description: "Implement login and invoice total helpers." },
    features: [{ key: "feat", title: "Modules" }],
    baseFiles: [],
    testFiles: [
      {
        path: "test/auth.test.mjs",
        content: `import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
test("login returns a token for valid passwords", async () => {
  if (!existsSync("src/auth/login.js")) return;
  const { login } = await import("../src/auth/login.js");
  assert.equal(login("alice", "s3cret"), "TOKEN-alice");
});
test("login rejects weak passwords", async () => {
  if (!existsSync("src/auth/login.js")) return;
  const { login } = await import("../src/auth/login.js");
  assert.throws(() => login("alice", "x"), /weak password/);
});
`,
      },
      {
        path: "test/billing.test.mjs",
        content: `import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
test("total sums price times quantity", async () => {
  if (!existsSync("src/billing/invoice.js")) return;
  const { total } = await import("../src/billing/invoice.js");
  assert.equal(total([{ price: 10, qty: 2 }, { price: 5, qty: 1 }]), 25);
});
test("total of an empty list is zero", async () => {
  if (!existsSync("src/billing/invoice.js")) return;
  const { total } = await import("../src/billing/invoice.js");
  assert.equal(total([]), 0);
});
`,
      },
    ],
    testCommand: NODE_TEST,
    tasks: [
      {
        key: "login",
        title: "Implement login helper",
        description:
          "Create src/auth/login.js exporting function login(username, password). " +
          "It must return the string `TOKEN-${username}` when password has length >= 4, " +
          "and throw an Error mentioning weak password otherwise. Then run node --test and commit.",
        featureKey: "feat",
        claims: [{ resource: "src/auth", access: "WRITE" }],
        dependsOn: [],
      },
      {
        key: "billing",
        title: "Implement invoice total helper",
        description:
          "Create src/billing/invoice.js exporting function total(items), where items is an array " +
          "of { price, qty }. It must return the sum of price times qty (0 for an empty array). " +
          "Then run node --test and commit.",
        featureKey: "feat",
        claims: [{ resource: "src/billing", access: "WRITE" }],
        dependsOn: [],
      },
    ],
    expectedOutcome: "All strategies integrate both modules; ATLAS and DUMB_PARALLEL run them concurrently.",
  });
}

export function realisticSharedConfig(): RealWorkloadSpec {
  return defineWorkload({
    id: "realistic-shared-config",
    name: "Shared JSON config, disjoint keys",
    description: "Two tasks tune different keys of one pretty-printed config; clean merge is expected.",
    kind: "REALISTIC_SHARED_RESOURCE",
    featureSpec: { title: "Tune service config", description: "Set retries and timeout in config.json." },
    features: [{ key: "feat", title: "Config" }],
    baseFiles: [{ path: "config.json", content: `{\n  "retries": 0,\n  "timeoutMs": 1000\n}\n` }],
    testFiles: [
      {
        path: "test/config.test.mjs",
        content: `import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
// Allowed-set semantics: each tuner owns one key, so a lone workspace may
// still hold the other key's base value. The train union proves the pair.
test("config carries tuned values", () => {
  const config = JSON.parse(readFileSync("config.json", "utf8"));
  assert.ok(config.retries === 0 || config.retries === 3);
  assert.ok(config.timeoutMs === 1000 || config.timeoutMs === 5000);
});
`,
      },
    ],
    testCommand: NODE_TEST,
    tasks: [
      {
        key: "retries",
        title: "Tune retry count",
        description:
          "In config.json set retries to 3. Preserve every other line exactly " +
          "(especially the timeoutMs line). Then run node --test and commit. " +
          "The cumulative suite also checks timeoutMs, which another task owns.",
        featureKey: "feat",
        claims: [{ resource: "config.json", access: "WRITE" }],
        dependsOn: [],
      },
      {
        key: "timeout",
        title: "Tune request timeout",
        description:
          "In config.json set timeoutMs to 5000. Preserve every other line exactly " +
          "(especially the retries line). Then run node --test and commit. " +
          "The cumulative suite also checks retries, which another task owns.",
        featureKey: "feat",
        claims: [{ resource: "config.json", access: "WRITE" }],
        dependsOn: [],
      },
    ],
    expectedOutcome: "Disjoint-line edits merge cleanly; every strategy integrates both tunings.",
  });
}

export function realisticSchemaApi(): RealWorkloadSpec {
  return defineWorkload({
    id: "realistic-schema-api",
    name: "Schema then validator",
    description: "A validator task depends on a schema task; ordering must be respected.",
    kind: "REALISTIC_DEPENDENCY_CHAIN",
    featureSpec: { title: "User validation", description: "Define a user schema, then a validator built on it." },
    features: [{ key: "feat", title: "Validation" }],
    baseFiles: [],
    testFiles: [
      {
        path: "test/schema.test.mjs",
        content: `import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
test("schema requires name and email", async () => {
  if (!existsSync("src/schema.js")) return;
  const { userSchema } = await import("../src/schema.js");
  assert.deepEqual(userSchema.required, ["name", "email"]);
});
`,
      },
      {
        path: "test/validate.test.mjs",
        content: `import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
// Dependency injection keeps this task independently testable: the schema
// arrives as a parameter, so no cross-worktree import is needed.
test("validate accepts complete users", async () => {
  if (!existsSync("src/validate.js")) return;
  const { validate } = await import("../src/validate.js");
  assert.equal(validate({ name: "a", email: "b" }, { required: ["name", "email"] }), true);
});
test("validate rejects incomplete users", async () => {
  if (!existsSync("src/validate.js")) return;
  const { validate } = await import("../src/validate.js");
  assert.equal(validate({ name: "a" }, { required: ["name", "email"] }), false);
});
`,
      },
    ],
    testCommand: NODE_TEST,
    tasks: [
      {
        key: "schema",
        title: "Define user schema",
        description:
          "Create src/schema.js exporting const userSchema = { required: [\"name\", \"email\"] }. " +
          "Then run node --test and commit. The validator task builds on this file.",
        featureKey: "feat",
        claims: [{ resource: "src/schema.js", access: "WRITE" }],
        dependsOn: [],
      },
      {
        key: "validator",
        title: "Implement validator",
        description:
          "Create src/validate.js exporting function validate(obj, schema), which returns true " +
          "only when every key in schema.required is present on obj. Take the schema as a " +
          "parameter (dependency injection) rather than importing it. " +
          "Then run node --test and commit.",
        featureKey: "feat",
        claims: [{ resource: "src/validate.js", access: "WRITE" }],
        dependsOn: ["schema"],
      },
    ],
    expectedOutcome: "ATLAS schedules waves [[schema],[validator]]; every strategy integrates both tasks.",
  });
}

export function realisticMixed(): RealWorkloadSpec {
  return defineWorkload({
    id: "realistic-mixed",
    name: "Mixed modules with one collision",
    description: "Two independent modules plus a third depending on one and colliding with the other.",
    kind: "REALISTIC_MIXED",
    featureSpec: { title: "Mixed modules", description: "Partial parallelism with one serialization point." },
    features: [{ key: "feat", title: "Mixed" }],
    baseFiles: [],
    testFiles: [
      {
        path: "test/a.test.mjs",
        content: `import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
test("a doubles", async () => {
  if (!existsSync("src/a.js")) return;
  const { a } = await import("../src/a.js");
  assert.equal(a(21), 42);
});
`,
      },
      {
        path: "test/b.test.mjs",
        content: `import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
test("b is either implementation", async () => {
  if (!existsSync("src/b.js")) return;
  const { b } = await import("../src/b.js");
  assert.ok(b(1) === 3 || b(1) === 4);
});
`,
      },
    ],
    testCommand: NODE_TEST,
    tasks: [
      {
        key: "a",
        title: "Implement doubler",
        description:
          "Create src/a.js exporting function a(n) returning n * 2. Then run node --test and commit.",
        featureKey: "feat",
        claims: [{ resource: "src/a.js", access: "WRITE" }],
        dependsOn: [],
      },
      {
        key: "b",
        title: "Implement tripler",
        description:
          "Create src/b.js exporting function b(n) returning n * 3. Then run node --test and commit. " +
          "Another task may rewrite this file; the suite accepts either implementation in isolation.",
        featureKey: "feat",
        claims: [{ resource: "src/b.js", access: "WRITE" }],
        dependsOn: [],
      },
      {
        key: "c",
        title: "Implement quadrupler",
        description:
          "Create src/b.js exporting function b(n) returning n * 4 (an alternative implementation " +
          "of the same module). Depends on task a. Then run node --test and commit.",
        featureKey: "feat",
        claims: [{ resource: "src/b.js", access: "WRITE" }],
        dependsOn: ["a"],
      },
    ],
    expectedOutcome:
      "ATLAS finds partial parallelism ([a,b] then [c]); b and c collide in the train, " +
      "so integration halts with exactly one genuine conflict.",
  });
}

export function realisticFalseParallelism(): RealWorkloadSpec {
  return defineWorkload({
    id: "realistic-false-parallelism",
    name: "Overhauls sharing one settings module",
    description: "Domain labels suggest independence, but both tasks edit disjoint lines of one module.",
    kind: "REALISTIC_FALSE_PARALLELISM",
    featureSpec: { title: "Settings overhauls", description: "Two misleadingly unrelated overhauls share settings." },
    features: [{ key: "feat", title: "Overhauls" }],
    baseFiles: [{ path: "src/settings.js", content: `export const settings = { theme: "light", pageSize: 10 };\n` }],
    testFiles: [
      {
        path: "test/settings.test.mjs",
        content: `import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
// Allowed-set semantics: each overhaul owns one key. The train union proves
// the pair; run success additionally requires a non-empty diff per task.
test("settings carry tuned values", () => {
  const text = readFileSync("src/settings.js", "utf8");
  assert.ok(text.includes('"light"') || text.includes('"dark"'));
  assert.ok(text.includes("pageSize: 10") || text.includes("pageSize: 25"));
});
`,
      },
    ],
    testCommand: NODE_TEST,
    tasks: [
      {
        key: "auth",
        title: "Auth overhaul",
        description:
          "In src/settings.js set theme to \"dark\". Preserve every other line exactly " +
          "(especially pageSize). Then run node --test and commit.",
        featureKey: "feat",
        claims: [{ resource: "src/settings.js", access: "WRITE" }],
        dependsOn: [],
      },
      {
        key: "billing",
        title: "Billing overhaul",
        description:
          "In src/settings.js set pageSize to 25. Preserve every other line exactly " +
          "(especially theme). Then run node --test and commit.",
        featureKey: "feat",
        claims: [{ resource: "src/settings.js", access: "WRITE" }],
        dependsOn: [],
      },
    ],
    expectedOutcome:
      "ATLAS serializes on the resource conflict despite unrelated labels, but disjoint lines " +
      "merge cleanly, so every strategy integrates both overhauls; the comparison measures " +
      "serialization overhead, not conflict.",
  });
}

export function realisticOrderSensitive(): RealWorkloadSpec {
  return defineWorkload({
    id: "realistic-order-sensitive",
    name: "Order-sensitive integration",
    description: "Two writers collide on one module; the survivor depends on integration order, not execution timing.",
    kind: "REALISTIC_INTEGRATION_CONFLICT",
    featureSpec: { title: "Contended module", description: "One independent module plus two contenders for another." },
    features: [{ key: "feat", title: "Contention" }],
    baseFiles: [],
    testFiles: [
      {
        path: "test/x.test.mjs",
        content: `import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
test("x marks the spot", async () => {
  if (!existsSync("src/x.js")) return;
  const { x } = await import("../src/x.js");
  assert.equal(x(), "x");
});
`,
      },
      {
        path: "test/y.test.mjs",
        content: `import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
test("y is either contender", async () => {
  if (!existsSync("src/y.js")) return;
  const { y } = await import("../src/y.js");
  assert.ok(y() === "v2" || y() === "v3");
});
`,
      },
    ],
    testCommand: NODE_TEST,
    tasks: [
      {
        key: "x",
        title: "Implement x",
        description: "Create src/x.js exporting function x() returning \"x\". Then run node --test and commit.",
        featureKey: "feat",
        claims: [{ resource: "src/x.js", access: "WRITE" }],
        dependsOn: [],
      },
      {
        key: "y",
        title: "Implement y as v2",
        description:
          "Create src/y.js exporting function y() returning \"v2\". Depends on task x. " +
          "Then run node --test and commit. The suite accepts v2 or v3 in isolation.",
        featureKey: "feat",
        claims: [{ resource: "src/y.js", access: "WRITE" }],
        dependsOn: ["x"],
      },
      {
        key: "z",
        title: "Implement y as v3",
        description:
          "Create src/y.js exporting function y() returning \"v3\" (a competing implementation). " +
          "Then run node --test and commit. The suite accepts v2 or v3 in isolation.",
        featureKey: "feat",
        claims: [{ resource: "src/y.js", access: "WRITE" }],
        dependsOn: [],
      },
    ],
    expectedOutcome:
      "ATLAS waves are [[x,z],[y]] so z survives and y conflicts; DUMB_PARALLEL sorted order " +
      "[x,y,z] integrates y and conflicts on z. Both halt; the survivor differs by order alone, " +
      "which the comparison records without declaring a winner.",
  });
}

const BUILDERS: Record<string, () => RealWorkloadSpec> = {
  "realistic-independent": realisticIndependent,
  "realistic-shared-config": realisticSharedConfig,
  "realistic-schema-api": realisticSchemaApi,
  "realistic-mixed": realisticMixed,
  "realistic-false-parallelism": realisticFalseParallelism,
  "realistic-order-sensitive": realisticOrderSensitive,
};

export function listWorkloadIds(): string[] {
  return Object.keys(BUILDERS).sort();
}

export function getWorkload(id: string): RealWorkloadSpec {
  const build = BUILDERS[id];
  if (build === undefined) {
    throw new BenchmarkError(`unknown real benchmark workload: ${id}`);
  }
  return build();
}
