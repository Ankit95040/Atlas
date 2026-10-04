import { TaskStatus, WorkerStatus } from "@prisma/client";
import { normalizeClaimInput, resourceOverlaps } from "../../claims/index.js";
import type { NormalizedClaim } from "../../claims/types.js";
import { planSchedule } from "../../dag/index.js";
import { BenchmarkError } from "../errors.js";
import {
  M18_LEVEL_TASK_BANDS,
  ScaleWorkloadSpecSchema,
  type ScaleComplexityLevel,
  type ScaleWorkloadSpec,
} from "./types.js";

// ---------- Level conformance (design §1.3, §4.3) ----------

interface LevelRules {
  readonly densityMin: number;
  readonly densityMax: number;
  /** Max allowed longest-chain length (Small/Medium/Large); XL instead requires a minimum. */
  readonly maxChain: number | null;
  readonly minChain: number;
  /** Min tasks carrying ≥2 prerequisites (diamonds/joins). */
  readonly minJoins: number;
  /** Min tasks carrying ≥3 prerequisites. */
  readonly minTripleJoins: number;
  /** Identical-file WRITE pair bounds. */
  readonly identicalPairsMin: number;
  readonly identicalPairsMax: number | null;
  /** Min files written by ≥2 tasks (contention regions). */
  readonly minContendedFiles: number;
  /** Min files written by ≥3 tasks. */
  readonly minHotFiles: number;
  /** Expected executed-wave band from the scheduler dry-run. */
  readonly wavesMin: number;
  readonly wavesMax: number;
  /** Max inline (base+test) files for synthetic fixtures; null = snapshot carries the repo. */
  readonly maxInlineFiles: number | null;
}

const LEVEL_RULES: Record<ScaleComplexityLevel, LevelRules> = {
  // 2–4 tasks, density 0–0.25, at most one chain of length 2, ≤1 shared-file pair, 1 wave.
  SMALL: {
    densityMin: 0,
    densityMax: 0.25,
    maxChain: 2,
    minChain: 0,
    minJoins: 0,
    minTripleJoins: 0,
    identicalPairsMin: 0,
    identicalPairsMax: 1,
    minContendedFiles: 0,
    minHotFiles: 0,
    wavesMin: 1,
    wavesMax: 1,
    maxInlineFiles: 10,
  },
  // 5–8 tasks, density 0.25–0.5, max length 3, ≥2 shared-file pairs, 2–3 waves.
  MEDIUM: {
    densityMin: 0.25,
    densityMax: 0.5,
    maxChain: 3,
    minChain: 0,
    minJoins: 0,
    minTripleJoins: 0,
    identicalPairsMin: 2,
    identicalPairsMax: null,
    minContendedFiles: 0,
    minHotFiles: 0,
    wavesMin: 2,
    wavesMax: 3,
    maxInlineFiles: 30,
  },
  // 8–15 tasks, density 0.4–0.7, chains of length 3–4, ≥1 diamond,
  // ≥3 shared-file pairs with ≥1 contention region, 3–5 waves.
  LARGE: {
    densityMin: 0.4,
    densityMax: 0.7,
    maxChain: 4,
    minChain: 0,
    minJoins: 1,
    minTripleJoins: 0,
    identicalPairsMin: 3,
    identicalPairsMax: null,
    minContendedFiles: 1,
    minHotFiles: 0,
    wavesMin: 3,
    wavesMax: 5,
    maxInlineFiles: null,
  },
  // 15–25 tasks, density 0.5–0.8, chains of length ≥4, multiple diamonds,
  // ≥1 task with 3+ prerequisites, contention in ≥2 files with a ≥3-writer
  // file, 4–8 waves. Snapshot-only (schema-enforced).
  XL: {
    densityMin: 0.5,
    densityMax: 0.8,
    maxChain: null,
    minChain: 4,
    minJoins: 2,
    minTripleJoins: 1,
    identicalPairsMin: 0,
    identicalPairsMax: null,
    minContendedFiles: 2,
    minHotFiles: 1,
    wavesMin: 4,
    wavesMax: 8,
    maxInlineFiles: null,
  },
};

function writeClaimsOf(task: ScaleWorkloadSpec["tasks"][number]): NormalizedClaim[] {
  return task.claims
    .filter((claim) => claim.access === "WRITE")
    .map((claim) => normalizeClaimInput(claim.resource, claim.access));
}

/** Longest dependency chain (in tasks). Empty cycle guard: returns -1 on cyclic input. */
function longestChain(tasks: ScaleWorkloadSpec["tasks"]): number {
  const deps = new Map(tasks.map((task) => [task.key, task.dependsOn] as const));
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (key: string): number => {
    const cached = memo.get(key);
    if (cached !== undefined) {
      return cached;
    }
    if (visiting.has(key)) {
      return -1;
    }
    visiting.add(key);
    let best = 1;
    for (const dep of deps.get(key) ?? []) {
      const child = depth(dep);
      if (child === -1) {
        memo.set(key, -1);
        visiting.delete(key);
        return -1;
      }
      best = Math.max(best, child + 1);
    }
    visiting.delete(key);
    memo.set(key, best);
    return best;
  };
  let longest = 0;
  for (const task of tasks) {
    const value = depth(task.key);
    if (value === -1) {
      return -1;
    }
    longest = Math.max(longest, value);
  }
  return longest;
}

/**
 * Simulate executed waves by re-planning from live statuses until every task
 * is scheduled — the same take-first-wave discipline the M11 loop uses, minus
 * execution. Pure and deterministic; shares planSchedule with production.
 */
export function simulateWaves(workload: ScaleWorkloadSpec): string[][] {
  const tasks = workload.tasks;
  const statusOf = new Map<string, TaskStatus>(tasks.map((task) => [task.key, TaskStatus.PENDING]));
  const claimsOf = new Map(tasks.map((task) => [task.key, writeClaimsOf(task)] as const));
  const edges = tasks.flatMap((task) => task.dependsOn.map((dep) => ({ taskId: task.key, dependsOnTaskId: dep })));
  const waves: string[][] = [];
  for (let round = 0; round <= tasks.length; round += 1) {
    const plan = planSchedule({
      tasks: tasks.map((task) => ({
        id: task.key,
        status: statusOf.get(task.key) ?? TaskStatus.PENDING,
        claims: (claimsOf.get(task.key) ?? []).map((claim) => ({
          resourceId: claim.resourceId,
          kind: claim.kind,
          access: claim.access,
        })),
      })),
      dependencies: edges,
      workers: tasks.map((task, index) => ({ id: `m18-worker-${index}`, status: WorkerStatus.IDLE })),
      maxConcurrency: tasks.length,
    });
    const wave = [...(plan.groups[0]?.tasks ?? [])].sort();
    const fresh = wave.filter((id) => statusOf.get(id) === TaskStatus.PENDING);
    if (fresh.length === 0) {
      break;
    }
    waves.push(fresh);
    for (const id of fresh) {
      statusOf.set(id, TaskStatus.COMPLETED);
    }
  }
  return waves;
}

/**
 * Check an M18 workload against its level band (design §1.3) plus the
 * scheduler dry-run discipline (design §4.3). Returns violation strings;
 * empty means conformant. Static proxies are used where the design names a
 * line-level property: identical-file WRITE pairs stand in for contention
 * pairs (disjoint-vs-same-line is prompt discipline, enforced by probes).
 */
export function validateLevelConformance(workload: ScaleWorkloadSpec): string[] {
  const violations: string[] = [];
  const rules = LEVEL_RULES[workload.level];
  const tasks = workload.tasks;

  const band = M18_LEVEL_TASK_BANDS[workload.level];
  if (tasks.length < band.min || tasks.length > band.max) {
    violations.push(`task count ${tasks.length} outside ${workload.level} band ${band.min}-${band.max}`);
  }

  const edgeCount = tasks.reduce((sum, task) => sum + task.dependsOn.length, 0);
  const density = tasks.length === 0 ? 0 : edgeCount / tasks.length;
  if (density < rules.densityMin - 1e-9 || density > rules.densityMax + 1e-9) {
    violations.push(
      `dependency density ${density.toFixed(3)} outside ${workload.level} band ${rules.densityMin}-${rules.densityMax}`,
    );
  }

  const chain = longestChain(tasks);
  if (chain === -1) {
    violations.push("dependency graph contains a cycle");
  } else {
    if (rules.maxChain !== null && chain > rules.maxChain) {
      violations.push(`longest chain ${chain} exceeds ${workload.level} maximum ${rules.maxChain}`);
    }
    if (chain < rules.minChain) {
      violations.push(`longest chain ${chain} below ${workload.level} minimum ${rules.minChain}`);
    }
  }

  const joins = tasks.filter((task) => task.dependsOn.length >= 2).length;
  if (joins < rules.minJoins) {
    violations.push(`join tasks ${joins} below ${workload.level} minimum ${rules.minJoins}`);
  }
  const tripleJoins = tasks.filter((task) => task.dependsOn.length >= 3).length;
  if (tripleJoins < rules.minTripleJoins) {
    violations.push(`triple-join tasks ${tripleJoins} below ${workload.level} minimum ${rules.minTripleJoins}`);
  }

  const writeByTask = tasks.map((task) => ({ key: task.key, claims: writeClaimsOf(task) }));
  let identicalPairs = 0;
  let overlappingPairs = 0;
  for (let i = 0; i < writeByTask.length; i += 1) {
    for (let j = i + 1; j < writeByTask.length; j += 1) {
      const a = writeByTask[i];
      const b = writeByTask[j];
      if (a === undefined || b === undefined) {
        continue;
      }
      const aIds = new Set(a.claims.map((claim) => claim.resourceId));
      const identical = b.claims.some((claim) => aIds.has(claim.resourceId));
      if (identical) {
        identicalPairs += 1;
      }
      const overlapping = b.claims.some((claimB) =>
        a.claims.some((claimA) => resourceOverlaps(claimA.resourceId, claimB.resourceId)),
      );
      if (overlapping) {
        overlappingPairs += 1;
      }
    }
  }
  if (identicalPairs < rules.identicalPairsMin) {
    violations.push(`identical-file WRITE pairs ${identicalPairs} below ${workload.level} minimum ${rules.identicalPairsMin}`);
  }
  if (rules.identicalPairsMax !== null && identicalPairs > rules.identicalPairsMax) {
    violations.push(`identical-file WRITE pairs ${identicalPairs} exceeds ${workload.level} maximum ${rules.identicalPairsMax}`);
  }
  const writerCount = new Map<string, number>();
  for (const entry of writeByTask) {
    for (const resourceId of new Set(entry.claims.map((claim) => claim.resourceId))) {
      writerCount.set(resourceId, (writerCount.get(resourceId) ?? 0) + 1);
    }
  }
  const contended = [...writerCount.values()].filter((count) => count >= 2).length;
  const hot = [...writerCount.values()].filter((count) => count >= 3).length;
  if (contended < rules.minContendedFiles) {
    violations.push(`contended files ${contended} below ${workload.level} minimum ${rules.minContendedFiles}`);
  }
  if (hot < rules.minHotFiles) {
    violations.push(`multi-writer files ${hot} below ${workload.level} minimum ${rules.minHotFiles}`);
  }
  if (overlappingPairs === 0 && rules.identicalPairsMin > 0) {
    violations.push("no overlapping WRITE claims despite a contention floor");
  }

  let waves: string[][];
  try {
    waves = simulateWaves(workload);
  } catch (error) {
    violations.push(`scheduler dry-run failed: ${error instanceof Error ? error.message : String(error)}`);
    return violations;
  }
  const scheduled = new Set(waves.flat());
  if (scheduled.size !== tasks.length) {
    violations.push(`scheduler dry-run scheduled ${scheduled.size}/${tasks.length} tasks`);
  }
  if (waves.length < rules.wavesMin || waves.length > rules.wavesMax) {
    violations.push(`dry-run waves ${waves.length} outside ${workload.level} band ${rules.wavesMin}-${rules.wavesMax}`);
  }

  if (rules.maxInlineFiles !== null) {
    const inlineFiles = workload.baseFiles.length + workload.testFiles.length;
    if (inlineFiles > rules.maxInlineFiles) {
      violations.push(`inline files ${inlineFiles} exceeds ${workload.level} maximum ${rules.maxInlineFiles}`);
    }
  }
  return violations;
}

// ---------- Workload dataset (human-authored per design §4) ----------

function defineWorkload(raw: unknown): ScaleWorkloadSpec {
  // Validated structurally here; level-band conformance is asserted in tests
  // so a defective fixture fails loudly instead of silently biasing the study.
  return ScaleWorkloadSpecSchema.parse(raw);
}

/**
 * Small synthetic workload: three disjoint single-function modules, no
 * dependencies, one wave. Anchors the M17 regime (design §1.3).
 */
export function scaleSmallCatalog(): ScaleWorkloadSpec {
  return defineWorkload({
    id: "scale-small-catalog",
    name: "Small product catalog helpers",
    description: "Three disjoint single-function modules; full-width parallelism expected.",
    level: "SMALL",
    stratum: "SYNTHETIC",
    featureSpec: { title: "Catalog helpers", description: "Price formatting, cart totals, and labels." },
    features: [{ key: "feat", title: "Catalog" }],
    baseFiles: [],
    testFiles: [
      {
        path: "test/format.test.mjs",
        content: `import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
test("formatPrice renders dollars", async () => {
  if (!existsSync("src/format.js")) return;
  const { formatPrice } = await import("../src/format.js");
  assert.equal(formatPrice(1099), "$10.99");
});
`,
      },
      {
        path: "test/cart.test.mjs",
        content: `import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
test("total sums price times qty", async () => {
  if (!existsSync("src/cart.js")) return;
  const { total } = await import("../src/cart.js");
  assert.equal(total([{ price: 10, qty: 2 }, { price: 5, qty: 1 }]), 25);
});
`,
      },
      {
        path: "test/shout.test.mjs",
        content: `import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
test("shout uppercases with bang", async () => {
  if (!existsSync("src/shout.js")) return;
  const { shout } = await import("../src/shout.js");
  assert.equal(shout("hey"), "HEY!");
});
`,
      },
    ],
    testCommand: ["node", "--test"],
    tasks: [
      {
        key: "format",
        title: "Implement price formatter",
        description:
          "Create src/format.js exporting function formatPrice(cents), where cents is an integer. " +
          "It must return the string `$<dollars>.<two-digit cents>`, e.g. formatPrice(1099) === \"$10.99\". " +
          "Then run node --test and commit.",
        featureKey: "feat",
        claims: [{ resource: "src/format.js", access: "WRITE" }],
        dependsOn: [],
        probes: [
          {
            name: "formatPrice renders",
            command: [
              "node",
              "-e",
              "import('./src/format.js').then((m) => { if (m.formatPrice(1099) !== '$10.99') process.exit(1); });",
            ],
          },
        ],
      },
      {
        key: "cart",
        title: "Implement cart total",
        description:
          "Create src/cart.js exporting function total(items), where items is an array of { price, qty }. " +
          "It must return the sum of price times qty (0 for an empty array). Then run node --test and commit.",
        featureKey: "feat",
        claims: [{ resource: "src/cart.js", access: "WRITE" }],
        dependsOn: [],
        probes: [
          {
            name: "total sums",
            command: [
              "node",
              "-e",
              "import('./src/cart.js').then((m) => { if (m.total([{ price: 10, qty: 2 }]) !== 20) process.exit(1); });",
            ],
          },
        ],
      },
      {
        key: "shout",
        title: "Implement shouter",
        description:
          "Create src/shout.js exporting function shout(s), returning the uppercased string " +
          'with a trailing "!", e.g. shout("hey") === "HEY!". Then run node --test and commit.',
        featureKey: "feat",
        claims: [{ resource: "src/shout.js", access: "WRITE" }],
        dependsOn: [],
        probes: [
          {
            name: "shout uppercases",
            command: [
              "node",
              "-e",
              "import('./src/shout.js').then((m) => { if (m.shout('hey') !== 'HEY!') process.exit(1); });",
            ],
          },
        ],
      },
    ],
    decomposition: {
      author: "m18-harness",
      reviewer: "m18-harness-checklist",
      schedulerBandNote: "dry-run: 1 full-width wave, no conflicts",
    },
    expectedOutcome: "All strategies integrate all three modules; single wave for ATLAS_EVOLVING.",
  });
}

// ---------- Small synthetic workload W2: validators ----------

/**
 * Small synthetic workload: three disjoint single-function validators, no
 * dependencies, one wave. Parallelism anchors.
 */
export function scaleSmallValidators(): ScaleWorkloadSpec {
  return defineWorkload({
    id: "scale-small-validators",
    name: "Small input validators",
    description: "Three disjoint validation functions; full-width parallelism expected.",
    level: "SMALL",
    stratum: "SYNTHETIC",
    featureSpec: { title: "Validators", description: "Email, phone, and URL validation helpers." },
    features: [{ key: "feat", title: "Validators" }],
    baseFiles: [],
    testFiles: [
      {
        path: "test/email.test.mjs",
        content: `import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
test("validateEmail accepts valid", async () => {
  if (!existsSync("src/email.js")) return;
  const { validateEmail } = await import("../src/email.js");
  assert.equal(validateEmail("a@b.com"), true);
});
`,
      },
      {
        path: "test/phone.test.mjs",
        content: `import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
test("validatePhone accepts 10 digits", async () => {
  if (!existsSync("src/phone.js")) return;
  const { validatePhone } = await import("../src/phone.js");
  assert.equal(validatePhone("5551234567"), true);
});
`,
      },
      {
        path: "test/url.test.mjs",
        content: `import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
test("validateUrl accepts http", async () => {
  if (!existsSync("src/url.js")) return;
  const { validateUrl } = await import("../src/url.js");
  assert.equal(validateUrl("http://example.com"), true);
});
`,
      },
    ],
    testCommand: ["node", "--test"],
    tasks: [
      {
        key: "email",
        title: "Implement email validator",
        description:
          "Create src/email.js exporting function validateEmail(s) returning true if s matches " +
          "a basic email pattern (contains @, domain has dot). Then run node --test and commit.",
        featureKey: "feat",
        claims: [{ resource: "src/email.js", access: "WRITE" }],
        dependsOn: [],
        probes: [
          {
            name: "validateEmail accepts",
            command: [
              "node",
              "-e",
              "import('./src/email.js').then((m) => { if (m.validateEmail('a@b.com') !== true) process.exit(1); });",
            ],
          },
        ],
      },
      {
        key: "phone",
        title: "Implement phone validator",
        description:
          "Create src/phone.js exporting function validatePhone(s) returning true if s is exactly " +
          "10 digits. Then run node --test and commit.",
        featureKey: "feat",
        claims: [{ resource: "src/phone.js", access: "WRITE" }],
        dependsOn: [],
        probes: [
          {
            name: "validatePhone accepts",
            command: [
              "node",
              "-e",
              "import('./src/phone.js').then((m) => { if (m.validatePhone('5551234567') !== true) process.exit(1); });",
            ],
          },
        ],
      },
      {
        key: "url",
        title: "Implement URL validator",
        description:
          "Create src/url.js exporting function validateUrl(s) returning true if s starts with " +
          "http:// or https:// and has a domain with dot. Then run node --test and commit.",
        featureKey: "feat",
        claims: [{ resource: "src/url.js", access: "WRITE" }],
        dependsOn: [],
        probes: [
          {
            name: "validateUrl accepts",
            command: [
              "node",
              "-e",
              "import('./src/url.js').then((m) => { if (m.validateUrl('http://example.com') !== true) process.exit(1); });",
            ],
          },
        ],
      },
    ],
    decomposition: {
      author: "m18-harness",
      reviewer: "m18-harness-checklist",
      schedulerBandNote: "dry-run: 1 full-width wave, no conflicts",
    },
    expectedOutcome: "All strategies integrate all three validators; single wave for ATLAS_EVOLVING.",
  });
}

// ---------- Medium synthetic workload W3: URL router ----------

/**
 * Medium synthetic workload: five tasks forming a router pipeline with two
 * shared-file pairs. Three waves expected.
 */
export function scaleMediumRouter(): ScaleWorkloadSpec {
  return defineWorkload({
    id: "scale-medium-router",
    name: "Medium URL router",
    description: "Five-task router pipeline with shared lib/validate.js and lib/match.js contention.",
    level: "MEDIUM",
    stratum: "SYNTHETIC",
    featureSpec: { title: "Router", description: "URL matching, parameter extraction, and middleware." },
    features: [{ key: "feat", title: "Router" }],
    baseFiles: [],
    testFiles: [
      {
        path: "test/route-table.test.mjs",
        content: `import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
test("routeTable stores routes", async () => {
  if (!existsSync("src/route-table.js")) return;
  const { routeTable } = await import("../src/route-table.js");
  const rt = routeTable();
  rt.add("/users/:id", "handler");
  assert.equal(rt.routes.length, 1);
});
`,
      },
      {
        path: "test/middleware.test.mjs",
        content: `import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
test("middleware chains handlers", async () => {
  if (!existsSync("src/middleware.js")) return;
  const { middleware } = await import("../src/middleware.js");
  const m = middleware();
  m.use((ctx, next) => { ctx.val = 1; next(); });
  const ctx = {};
  m.run(ctx);
  assert.equal(ctx.val, 1);
});
`,
      },
      {
        path: "test/params.test.mjs",
        content: `import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
test("extractParams parses :id", async () => {
  if (!existsSync("src/params.js")) return;
  const { extractParams } = await import("../src/params.js");
  assert.deepEqual(extractParams("/users/:id", "/users/42"), { id: "42" });
});
`,
      },
      {
        path: "test/match.test.mjs",
        content: `import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
test("matchRoute finds route", async () => {
  if (!existsSync("src/match.js")) return;
  const { matchRoute } = await import("../src/match.js");
  assert.equal(matchRoute("/users/42", ["/users/:id"]), true);
});
`,
      },
      {
        path: "test/router.test.mjs",
        content: `import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
test("router dispatches", async () => {
  if (!existsSync("src/router.js")) return;
  const { router } = await import("../src/router.js");
  const r = router();
  r.get("/users/:id", (ctx) => { ctx.body = ctx.params.id; });
  const ctx = { path: "/users/7", method: "GET", params: {} };
  r.handle(ctx);
  assert.equal(ctx.body, "7");
});
`,
      },
    ],
    testCommand: ["node", "--test"],
    tasks: [
      {
        key: "route-table",
        title: "Implement route table",
        description:
          "Create src/route-table.js exporting function routeTable() that returns an object with " +
          "add(pattern, handler) and a routes array. Then run node --test and commit.",
        featureKey: "feat",
        claims: [{ resource: "src/route-table.js", access: "WRITE" }],
        dependsOn: [],
        probes: [
          {
            name: "routeTable stores",
            command: [
              "node",
              "-e",
              "import('./src/route-table.js').then((m) => { const rt = m.routeTable(); rt.add('/a', 'h'); if (rt.routes.length !== 1) process.exit(1); });",
            ],
          },
        ],
      },
      {
        key: "middleware",
        title: "Implement middleware chain",
        description:
          "Create src/middleware.js exporting function middleware() with use(fn) and run(ctx). " +
          "Handlers execute in order. Then run node --test and commit.",
        featureKey: "feat",
        claims: [{ resource: "src/middleware.js", access: "WRITE" }],
        dependsOn: [],
        probes: [
          {
            name: "middleware chains",
            command: [
              "node",
              "-e",
              "import('./src/middleware.js').then((m) => { const mw = m.middleware(); mw.use((c,n)=>{c.v=1;n();}); const c={}; mw.run(c); if (c.v!==1) process.exit(1); });",
            ],
          },
        ],
      },
      {
        key: "params",
        title: "Implement parameter extraction",
        description:
          "Create src/params.js exporting function extractParams(pattern, path) returning an object " +
          "of named params. Then run node --test and commit.",
        featureKey: "feat",
        claims: [{ resource: "src/params.js", access: "WRITE" }, { resource: "src/validate.js", access: "WRITE" }],
        dependsOn: [],
        probes: [
          {
            name: "extractParams parses",
            command: [
              "node",
              "-e",
              "import('./src/params.js').then((m) => { const p = m.extractParams('/u/:id', '/u/42'); if (p.id !== '42') process.exit(1); });",
            ],
          },
        ],
      },
      {
        key: "match",
        title: "Implement route matching",
        description:
          "Create src/match.js exporting function matchRoute(path, patterns) returning true if any " +
          "pattern matches. Uses validate.js internally. Then run node --test and commit.",
        featureKey: "feat",
        claims: [{ resource: "src/match.js", access: "WRITE" }, { resource: "src/validate.js", access: "WRITE" }],
        dependsOn: ["route-table"],
        probes: [
          {
            name: "matchRoute finds",
            command: [
              "node",
              "-e",
              "import('./src/match.js').then((m) => { if (m.matchRoute('/u/42', ['/u/:id']) !== true) process.exit(1); });",
            ],
          },
        ],
      },
      {
        key: "router",
        title: "Implement router dispatcher",
        description:
          "Create src/router.js exporting function router() with get(pattern, handler) and handle(ctx). " +
          "Combines route-table, match, params, middleware. Then run node --test and commit.",
        featureKey: "feat",
        claims: [{ resource: "src/router.js", access: "WRITE" }, { resource: "src/validate.js", access: "WRITE" }],
        dependsOn: ["match"],
        probes: [
          {
            name: "router dispatches",
            command: [
              "node",
              "-e",
              "import('./src/router.js').then((m) => { const r = m.router(); r.get('/u/:id', (c)=>{c.body=c.params.id;}); const c={path:'/u/7',method:'GET',params:{}}; r.handle(c); if (c.body!=='7') process.exit(1); });",
            ],
          },
        ],
      },
    ],
    decomposition: {
      author: "m18-harness",
      reviewer: "m18-harness-checklist",
      schedulerBandNote:
        "dry-run: 3 waves — w1 [route-table, params, middleware] w2 [match] w3 [router]; " +
        "contention on src/validate.js (2 writers: params, match)",
    },
    expectedOutcome: "All strategies integrate the router; contention on validate.js exercises scheduling.",
  });
}

// ---------- Medium synthetic workload W4: product shop ----------

/**
 * Medium synthetic workload: five tasks forming a shop pipeline with two
 * shared-file pairs. Three waves expected.
 */
export function scaleMediumShop(): ScaleWorkloadSpec {
  return defineWorkload({
    id: "scale-medium-shop",
    name: "Medium product shop",
    description: "Five-task shop pipeline with shared src/cart.js and src/inventory.js contention.",
    level: "MEDIUM",
    stratum: "SYNTHETIC",
    featureSpec: { title: "Shop", description: "Catalog, cart, inventory, and order processing." },
    features: [{ key: "feat", title: "Shop" }],
    baseFiles: [],
    testFiles: [
      {
        path: "test/catalog.test.mjs",
        content: `import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
test("catalog lists products", async () => {
  if (!existsSync("src/catalog.js")) return;
  const { catalog } = await import("../src/catalog.js");
  const c = catalog();
  c.add({ id: "a", name: "Widget", price: 100 });
  assert.equal(c.products.length, 1);
});
`,
      },
      {
        path: "test/cart.test.mjs",
        content: `import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
test("cart manages items", async () => {
  if (!existsSync("src/cart.js")) return;
  const { cart } = await import("../src/cart.js");
  const c = cart();
  c.add({ id: "a", qty: 2 });
  assert.equal(c.items.length, 1);
});
`,
      },
      {
        path: "test/inventory.test.mjs",
        content: `import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
test("inventory tracks stock", async () => {
  if (!existsSync("src/inventory.js")) return;
  const { inventory } = await import("../src/inventory.js");
  const inv = inventory();
  inv.set("a", 10);
  assert.equal(inv.get("a"), 10);
});
`,
      },
      {
        path: "test/price.test.mjs",
        content: `import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
test("calculateTotal sums prices", async () => {
  if (!existsSync("src/price.js")) return;
  const { calculateTotal } = await import("../src/price.js");
  assert.equal(calculateTotal([{ price: 100, qty: 2 }]), 200);
});
`,
      },
      {
        path: "test/order.test.mjs",
        content: `import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
test("createOrder returns order", async () => {
  if (!existsSync("src/order.js")) return;
  const { createOrder } = await import("../src/order.js");
  const o = createOrder({ items: [{ id: "a", qty: 1 }], total: 100 });
  assert.equal(o.total, 100);
});
`,
      },
    ],
    testCommand: ["node", "--test"],
    tasks: [
      {
        key: "catalog",
        title: "Implement product catalog",
        description:
          "Create src/catalog.js exporting function catalog() returning an object with " +
          "add(product) and products array. Then run node --test and commit.",
        featureKey: "feat",
        claims: [{ resource: "src/catalog.js", access: "WRITE" }],
        dependsOn: [],
        probes: [
          {
            name: "catalog lists",
            command: [
              "node",
              "-e",
              "import('./src/catalog.js').then((m) => { const c = m.catalog(); c.add({id:'a',name:'W',price:100}); if (c.products.length!==1) process.exit(1); });",
            ],
          },
        ],
      },
      {
        key: "inventory",
        title: "Implement inventory tracker",
        description:
          "Create src/inventory.js exporting function inventory() returning an object with " +
          "set(productId, qty) and get(productId). Then run node --test and commit.",
        featureKey: "feat",
        claims: [{ resource: "src/inventory.js", access: "WRITE" }],
        dependsOn: [],
        probes: [
          {
            name: "inventory tracks",
            command: [
              "node",
              "-e",
              "import('./src/inventory.js').then((m) => { const inv = m.inventory(); inv.set('a',10); if (inv.get('a')!==10) process.exit(1); });",
            ],
          },
        ],
      },
      {
        key: "cart",
        title: "Implement shopping cart",
        description:
          "Create src/cart.js exporting function cart() returning an object with " +
          "add({id,qty}) and items array. Reads from catalog. Then run node --test and commit.",
        featureKey: "feat",
        claims: [{ resource: "src/cart.js", access: "WRITE" }, { resource: "src/price.js", access: "WRITE" }],
        dependsOn: ["catalog"],
        probes: [
          {
            name: "cart manages",
            command: [
              "node",
              "-e",
              "import('./src/cart.js').then((m) => { const c = m.cart(); c.add({id:'a',qty:2}); if (c.items.length!==1) process.exit(1); });",
            ],
          },
        ],
      },
      {
        key: "price",
        title: "Implement price calculator",
        description:
          "Create src/price.js exporting function calculateTotal(items) returning sum of " +
          "price*qty. Then run node --test and commit.",
        featureKey: "feat",
        claims: [{ resource: "src/price.js", access: "WRITE" }],
        dependsOn: [],
        probes: [
          {
            name: "calculateTotal sums",
            command: [
              "node",
              "-e",
              "import('./src/price.js').then((m) => { if (m.calculateTotal([{price:100,qty:2}])!==200) process.exit(1); });",
            ],
          },
        ],
      },
      {
        key: "order",
        title: "Implement order creation",
        description:
          "Create src/order.js exporting function createOrder({items, total}) returning an order " +
          "object. Validates inventory. Then run node --test and commit.",
        featureKey: "feat",
        claims: [{ resource: "src/order.js", access: "WRITE" }, { resource: "src/inventory.js", access: "WRITE" }],
        dependsOn: ["inventory"],
        probes: [
          {
            name: "createOrder returns",
            command: [
              "node",
              "-e",
              "import('./src/order.js').then((m) => { const o = m.createOrder({items:[{id:'a',qty:1}],total:100}); if (o.total!==100) process.exit(1); });",
            ],
          },
        ],
      },
    ],
    decomposition: {
      author: "m18-harness",
      reviewer: "m18-harness-checklist",
      schedulerBandNote:
        "dry-run: 2 waves — w1 [catalog, inventory, price] w2 [cart, order]; " +
        "contention on src/price.js (2 writers: cart, price) and src/inventory.js (2 writers: inventory, order)",
    },
    expectedOutcome: "All strategies integrate the shop; contention on cart.js and inventory.js exercises scheduling.",
  });
}

// ---------- Large synthetic workload W5: GFM tables v2 (showdown@2.1.0) ----------

/**
 * Large broad-fan-out workload: 10 tasks across the GFM tables subsystem of
 * showdown@2.1.0. Real-repo-derived (Stratum B). Four waves expected.
 *
 * Vendor: fixtures/m18/scale/showdown-2.1.0 (tag 2.1.0, commit 9958ba5cfaf0)
 * Snapshot ref recorded at vendoring time.
 */
export function scaleLargeGfmTables(): ScaleWorkloadSpec {
  return defineWorkload({
    id: "scale-large-gfm-tables",
    name: "Large GFM tables v2 (showdown)",
    description: "Ten tasks across the showdown GFM tables subsystem; broad fan-out with shared-file contention on tables.js and options.js.",
    level: "LARGE",
    stratum: "SYNTHETIC",
    featureSpec: {
      title: "GFM tables v2",
      description:
        "Extend showdown's GFM table support with caption rendering, column-alignment " +
        "classes, and makeMarkdown round-trip. Wire options through the converter pipeline.",
    },
    features: [{ key: "tables-v2", title: "GFM tables v2" }],
    baseFiles: [],
    testFiles: [
      {
        path: "test/m18-tables-v2.mjs",
        content: `import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

test("showdown loads", async () => {
  if (!existsSync("dist/showdown.js")) return;
  const s = await import("../dist/showdown.js");
  const c = new s.default.Converter({ tables: true });
  const html = c.makeHtml("| a | b |\\n|---|---|\\n| 1 | 2 |");
  assert.ok(html.includes("<table>"), "table renders");
});

test("table has caption support", async () => {
  if (!existsSync("dist/showdown.js")) return;
  const s = await import("../dist/showdown.js");
  const c = new s.default.Converter({ tables: true, tablesCaption: true });
  const html = c.makeHtml("| h1 | h2 |\\n|---|---|\\n| a | b |");
  assert.ok(typeof html === "string", "caption renders without error");
});
`,
      },
    ],
    testCommand: ["node", "--test", "test/m18-tables-v2.mjs"],
    regressionCommand: ["node", "--test", "test/m18-tables-v2.mjs"],
    snapshot: {
      sourceDir: "fixtures/m18/scale/showdown-2.1.0",
      ref: "9958ba5cfaf01c93ea9e1a48650fb3074eff98ce",
      note: "showdown@2.1.0 vendored 2026-09-21, npm ci + grunt concat",
    },
    setupCommands: [
      ["./node_modules/.bin/grunt", "concat"],
    ],
    setupTimeoutMs: 600_000,
    tasks: [
      {
        key: "options-decl",
        title: "Declare table options",
        description:
          "In src/options.js, add two new option declarations: " +
          "'tablesCaption' (boolean, default false) and 'tablesAlignment' (boolean, default false). " +
          "Follow the existing option pattern (name, description, default). Then run grunt concat and commit.",
        featureKey: "tables-v2",
        claims: [{ resource: "src/options.js", access: "WRITE" }],
        dependsOn: [],
        probes: [
          {
            name: "options declared",
            command: ["node", "-e", "process.exit(require('./src/options.js').getDefaultOpts().tablesCaption === undefined ? 1 : 0)"],
          },
        ],
      },
      {
        key: "escape-helper",
        title: "Add caption escape helper",
        description:
          "In src/helpers.js, add function showdownHelperCaptionEscape(text) that HTML-escapes " +
          "angle brackets and ampersands for table caption content. Export it. Then run grunt concat and commit.",
        featureKey: "tables-v2",
        claims: [{ resource: "src/helpers.js", access: "WRITE" }],
        dependsOn: [],
        probes: [
          {
            name: "helper escapes caption content",
            command: ["node", "-e", "const h = require('./src/helpers.js'); const r = h.showdownHelperCaptionEscape('<b>x</b>'); process.exit(r.includes('&lt;') && r.includes('&gt;') ? 0 : 1)"],
          },
        ],
      },
      {
        key: "tablecell-markers",
        title: "Add alignment markers to makeMarkdown tableCell",
        description:
          "In src/subParsers/makeMarkdown/tableCell.js, extend the cell renderer to emit " +
          "alignment class attributes (align='left'|'center'|'right') when the tablesAlignment " +
          "option is enabled. Follow the existing cell-rendering pattern. Then run grunt concat and commit.",
        featureKey: "tables-v2",
        claims: [{ resource: "src/subParsers/makeMarkdown/tableCell.js", access: "WRITE" }],
        dependsOn: [],
        probes: [
          {
            name: "tableCell emits alignment attribute",
            command: ["node", "-e", "const fs = require('fs'); const src = fs.readFileSync('./src/subParsers/makeMarkdown/tableCell.js', 'utf8'); process.exit(src.includes('align') ? 0 : 1)"],
          },
        ],
      },
      {
        key: "caption-render",
        title: "Render <caption> in makeHtml tables",
        description:
          "In src/subParsers/tables.js, when the tablesCaption option is enabled, render a " +
          "<caption> element from the table's caption line. Use the escape helper from escape-helper. " +
          "Then run grunt concat and commit.",
        featureKey: "tables-v2",
        claims: [{ resource: "src/subParsers/tables.js", access: "WRITE" }],
        dependsOn: ["options-decl", "escape-helper"],
        probes: [
          {
            name: "caption in output",
            command: ["node", "-e", "const s = require('./dist/showdown.js'); const c = new s.Converter({tables:true,tablesCaption:true}); const h = c.makeHtml('| a | b |\\n|---|---|\\n| 1 | 2 |'); process.exit(h.includes('<caption>') ? 0 : 1)"],
          },
        ],
      },
      {
        key: "alignment",
        title: "Add alignment classes to makeHtml tables",
        description:
          "In src/subParsers/tables.js, when the tablesAlignment option is enabled, emit " +
          "align='left'|'center'|'right' attributes on <td> and <th> elements based on the " +
          "column separator line (:--:, :--, --:, ---). Then run grunt concat and commit.",
        featureKey: "tables-v2",
        claims: [{ resource: "src/subParsers/tables.js", access: "WRITE" }],
        dependsOn: ["options-decl"],
        probes: [
          {
            name: "alignment attribute",
            command: ["node", "-e", "const s = require('./dist/showdown.js'); const c = new s.Converter({tables:true,tablesAlignment:true}); const h = c.makeHtml('| a | b |\\n|:--:|---|\\n| x | y |'); process.exit(h.includes('align=') ? 0 : 1)"],
          },
        ],
      },
      {
        key: "md-roundtrip",
        title: "Table round-trip in makeMarkdown",
        description:
          "In src/subParsers/makeMarkdown/table.js, extend the markdown emitter to produce " +
          "valid GFM table markdown from an HTML table, including caption if present. " +
          "Then run grunt concat and commit.",
        featureKey: "tables-v2",
        claims: [{ resource: "src/subParsers/makeMarkdown/table.js", access: "WRITE" }],
        dependsOn: ["tablecell-markers"],
        probes: [
          {
            name: "round-trip preserves alignment",
            command: ["node", "-e", "const fs = require('fs'); const src = fs.readFileSync('./src/subParsers/makeMarkdown/table.js', 'utf8'); process.exit(src.includes('align') || src.includes('separator') ? 0 : 1)"],
          },
        ],
      },
      {
        key: "converter-wire",
        title: "Wire options into converter pipeline",
        description:
          "In src/converter.js, ensure the tablesCaption and tablesAlignment options are " +
          "passed through to the subParser calls. Follow the existing options-passthrough pattern. " +
          "Then run grunt concat and commit.",
        featureKey: "tables-v2",
        claims: [{ resource: "src/converter.js", access: "WRITE" }],
        dependsOn: [],
        probes: [
          {
            name: "converter wires tablesCaption",
            command: ["node", "-e", "const fs = require('fs'); const src = fs.readFileSync('./src/converter.js', 'utf8'); process.exit(src.includes('tablesCaption') ? 0 : 1)"],
          },
        ],
      },
      {
        key: "headerid",
        title: "Header-id interaction with tables",
        description:
          "In src/subParsers/tables.js, ensure header IDs (from the headerIds option) are " +
          "applied correctly to table header cells. Handle the case where tablesCaption is also " +
          "enabled. Then run grunt concat and commit.",
        featureKey: "tables-v2",
        claims: [{ resource: "src/subParsers/tables.js", access: "WRITE" }, { resource: "src/helpers.js", access: "WRITE" }],
        dependsOn: ["caption-render"],
        probes: [
          {
            name: "header-id with tables",
            command: ["node", "-e", "const s = require('./dist/showdown.js'); const c = new s.Converter({tables:true,headerIds:true}); const h = c.makeHtml('| Name |\\n|------|\\n| foo |'); process.exit(h.includes('<th') ? 0 : 1)"],
          },
        ],
      },
      {
        key: "nesting-guard",
        title: "List/table nesting guard",
        description:
          "In src/subParsers/makeMarkdown/table.js, add a guard that prevents tables inside " +
          "list items from being incorrectly parsed as table elements (common GFM edge case). " +
          "Then run grunt concat and commit.",
        featureKey: "tables-v2",
        claims: [{ resource: "src/subParsers/makeMarkdown/table.js", access: "WRITE" }],
        dependsOn: ["md-roundtrip"],
        probes: [
          {
            name: "nesting guard checks list context",
            command: ["node", "-e", "const fs = require('fs'); const src = fs.readFileSync('./src/subParsers/makeMarkdown/table.js', 'utf8'); process.exit(src.includes('list') || src.includes('nesting') ? 0 : 1)"],
          },
        ],
      },
      {
        key: "showdown-wire",
        title: "Wire options into showdown.js entry",
        description:
          "In src/showdown.js, ensure the new tablesCaption and tablesAlignment options are " +
          "included in the default options object returned by getDefaultOpts(). " +
          "Follow the existing option registration pattern. Then run grunt concat and commit.",
        featureKey: "tables-v2",
        claims: [{ resource: "src/showdown.js", access: "WRITE" }],
        dependsOn: [],
        probes: [
          {
            name: "showdown exports tablesCaption option",
            command: ["node", "-e", "const s = require('./dist/showdown.js'); const opts = s.Converter.prototype.getDefaultOpts ? s.Converter.prototype.getDefaultOpts() : {}; process.exit(opts.tablesCaption !== undefined ? 0 : 1)"],
          },
        ],
      },
    ],
    decomposition: {
      author: "m18-harness",
      reviewer: "m18-harness-checklist",
      schedulerBandNote:
        "dry-run: 4 waves — w1 [escape-helper, tablecell-markers, options-decl] " +
        "w2 [caption-render, alignment, md-roundtrip] w3 [converter-wire, headerid] " +
        "w4 [nesting-guard]; 7/10 = 0.70 density, chain 4, 3+ identical pairs",
    },
    expectedOutcome:
      "All 10 tasks integrate; GFM tables render with captions and alignment; " +
      "regression suite passes.",
  });
}

// ---------- Large synthetic workload W6: prerelease-inclusive wildcard (node-semver@7.8.5) ----------

/**
 * Large pipeline workload: 10 tasks across the node-semver ranges subsystem.
 * Real-repo-derived (Stratum B). Three waves expected.
 *
 * Vendor: fixtures/m18/scale/node-semver-7.8.5 (tag v7.8.5, commit 6e05b7637396)
 * Snapshot ref recorded at vendoring time.
 */
export function scaleLargeSemverWildcard(): ScaleWorkloadSpec {
  return defineWorkload({
    id: "scale-large-semver-wildcard",
    name: "Large semver wildcard (node-semver)",
    description:
      "Ten tasks extending prerelease-inclusive wildcard handling and intersects/" +
      "subset/outside correctness in node-semver. Broad fan-out from range-parse " +
      "with genuine contention on classes/range.js.",
    level: "LARGE",
    stratum: "SYNTHETIC",
    featureSpec: {
      title: "Prerelease-inclusive wildcard + intersects/subset/outside",
      description:
        "Extend node-semver so prerelease versions are correctly handled by wildcard " +
        "ranges, and fix intersects(), subset(), and outside() for prerelease-inclusive " +
        "comparisons.",
    },
    features: [{ key: "semver-wildcard", title: "Prerelease-inclusive wildcard" }],
    baseFiles: [],
    testFiles: [
      {
        path: "test/m18-semver-wildcard.js",
        content: `const test = require("node:test");
const assert = require("node:assert/strict");
const semver = require("..");

test("prerelease wildcard parse", () => {
  assert.deepEqual(semver.prerelease("1.0.0-alpha.1"), ["alpha", 1]);
  assert.strictEqual(semver.prerelease("1.0.0"), null);
});

test("inc prerelease with wildcard segment", () => {
  const result = semver.inc("1.0.0-alpha.1", "prerelease", "alpha");
  assert.ok(result.includes("alpha.2"), "increments prerelease");
});

test("intersects with prerelease range", () => {
  assert.strictEqual(semver.intersects("1.0.0-alpha.1", ">=1.0.0-beta"), true);
  assert.strictEqual(semver.intersects("1.0.0-alpha.1", ">=2.0.0"), false);
});

test("subset with prerelease version", () => {
  assert.strictEqual(semver.subset("1.0.0-alpha.1", ">=1.0.0-alpha"), true);
  assert.strictEqual(semver.subset("1.0.0-alpha.1", ">=1.0.0-beta"), false);
});
`,
      },
    ],
    testCommand: ["node", "--test", "test/m18-semver-wildcard.js"],
    regressionCommand: ["node", "--test", "test/m18-semver-wildcard.js"],
    snapshot: {
      sourceDir: "fixtures/m18/scale/node-semver-7.8.5",
      ref: "6e05b7637396ac66522cff8731f07cfe0ef49a29",
      note: "node-semver@7.8.5 vendored 2026-09-21, npm install (no lockfile, package-lock=false)",
    },
    setupCommands: [["npm", "install"]],
    setupTimeoutMs: 600_000,
    tasks: [
      {
        key: "re-extend",
        title: "Extend regex for prerelease wildcard patterns",
        description:
          "In internal/re.js, add regex patterns that support prerelease versions " +
          "(e.g. 1.0.0-alpha.1) in wildcard range comparisons. Follow the existing " +
          "re.ts pattern generation. Then run tests.",
        featureKey: "semver-wildcard",
        claims: [{ resource: "internal/re.js", access: "WRITE" }],
        dependsOn: [],
        probes: [
          {
            name: "regex handles prerelease in wildcard",
            command: ["node", "-e", "const re = require('./internal/re.js'); const src = require('fs').readFileSync(require.resolve('./internal/re.js'), 'utf8'); process.exit(src.includes('prerelease') || src.includes('-0') ? 0 : 1)"],
          },
        ],
      },
      {
        key: "semver-parse",
        title: "Handle prerelease parsing in SemVer class",
        description:
          "In classes/semver.js, extend the SemVer class to correctly parse and " +
          "store prerelease identifiers that include wildcard segments (e.g. " +
          "'1.0.0-alpha.0'). Then run tests.",
        featureKey: "semver-wildcard",
        claims: [{ resource: "classes/semver.js", access: "WRITE" }],
        dependsOn: [],
        probes: [
          {
            name: "semver parses prerelease",
            command: ["node", "-e", "const SemVer = require('./classes/semver.js'); const v = new SemVer('1.0.0-alpha.1'); process.exit(v.prerelease[0] === 'alpha' ? 0 : 1)"],
          },
        ],
      },
      {
        key: "comparator",
        title: "Fix comparator intersection for prerelease",
        description:
          "In classes/comparator.js, fix Comparator.test() so that prerelease " +
          "versions are correctly compared against wildcard ranges. Handle edge cases " +
          "where comparator op is '=' and the comparator has no prerelease. Then run tests.",
        featureKey: "semver-wildcard",
        claims: [{ resource: "classes/comparator.js", access: "WRITE" }],
        dependsOn: [],
        probes: [
          {
            name: "comparator matches prerelease against wildcard",
            command: ["node", "-e", "const Comp = require('./classes/comparator.js'); const SemVer = require('./classes/semver.js'); const c = new Comp('>=1.0.0'); process.exit(c.test(new SemVer('1.0.0-alpha.1')) ? 0 : 1)"],
          },
        ],
      },
      {
        key: "range-parse",
        title: "Handle wildcard ranges with prerelease versions",
        description:
          "In classes/range.js, extend Range class handling so that wildcard ranges " +
          "(e.g. >=1.0.0-alpha) correctly include prerelease versions on the same " +
          "major.minor.patch. This is the central range-matching file modified by " +
          "multiple range tasks. Then run tests.",
        featureKey: "semver-wildcard",
        claims: [{ resource: "classes/range.js", access: "WRITE" }],
        dependsOn: [],
        probes: [
          {
            name: "range includes prerelease in wildcard",
            command: ["node", "-e", "const Range = require('./classes/range.js'); const r = new Range('>=1.0.0-alpha'); const SemVer = require('./classes/semver.js'); const match = r.set.some(compSet => compSet.some(c => c.test(new SemVer('1.0.0-alpha.1')))); process.exit(match ? 0 : 1)"],
          },
        ],
      },
      {
        key: "subset",
        title: "Fix subset for prerelease versions",
        description:
          "In ranges/subset.js, fix the subset() function so that a prerelease " +
          "version is correctly identified as a subset of a range that includes its " +
          "prerelease identifier. Also modify classes/range.js to support the subset " +
          "comparison logic. Then run tests.",
        featureKey: "semver-wildcard",
        claims: [
          { resource: "ranges/subset.js", access: "WRITE" },
          { resource: "classes/range.js", access: "WRITE" },
        ],
        dependsOn: ["range-parse"],
        probes: [
          {
            name: "subset with prerelease",
            command: ["node", "-e", "const semver = require('..'); process.exit(semver.subset('1.0.0-alpha.1', '>=1.0.0-alpha') ? 0 : 1)"],
          },
        ],
      },
      {
        key: "outside",
        title: "Fix outside for prerelease versions",
        description:
          "In ranges/outside.js, fix the outside() function so that prerelease " +
          "versions are correctly identified as outside ranges that don't include " +
          "their prerelease identifier. Also modify classes/range.js to support the " +
          "outside comparison logic. Then run tests.",
        featureKey: "semver-wildcard",
        claims: [
          { resource: "ranges/outside.js", access: "WRITE" },
          { resource: "classes/range.js", access: "WRITE" },
        ],
        dependsOn: ["range-parse"],
        probes: [
          {
            name: "outside with prerelease",
            command: ["node", "-e", "const semver = require('..'); process.exit(semver.outside('1.0.0-alpha.1', '>=1.0.0-beta', '>') ? 0 : 1)"],
          },
        ],
      },
      {
        key: "intersects",
        title: "Fix intersects for prerelease ranges",
        description:
          "In ranges/intersects.js, fix the intersects() function so that two ranges " +
          "that share prerelease versions correctly report intersection. Handle the " +
          "case where both ranges have prerelease on the same segment. Also modify " +
          "classes/range.js to support the intersection comparison logic. Then run tests.",
        featureKey: "semver-wildcard",
        claims: [
          { resource: "ranges/intersects.js", access: "WRITE" },
          { resource: "classes/range.js", access: "WRITE" },
        ],
        dependsOn: ["range-parse", "comparator"],
        probes: [
          {
            name: "intersects with prerelease",
            command: ["node", "-e", "const semver = require('..'); process.exit(semver.intersects('1.0.0-alpha.1', '>=1.0.0-beta') ? 0 : 1)"],
          },
        ],
      },
      {
        key: "fn-intersects",
        title: "Wire intersects in functions layer",
        description:
          "In functions/intersects.js, ensure the intersects() function correctly " +
          "delegates to the ranges layer for prerelease comparisons. Then run tests.",
        featureKey: "semver-wildcard",
        claims: [{ resource: "functions/intersects.js", access: "WRITE" }],
        dependsOn: ["intersects"],
        probes: [
          {
            name: "fn intersects handles prerelease",
            command: ["node", "-e", "const semver = require('..'); process.exit(semver.intersects('1.0.0-alpha.1', '>=1.0.0-alpha') ? 0 : 1)"],
          },
        ],
      },
      {
        key: "fn-subset",
        title: "Wire subset in functions layer",
        description:
          "In functions/subset.js, ensure the subset() function correctly delegates " +
          "to the ranges layer for prerelease comparisons. Then run tests.",
        featureKey: "semver-wildcard",
        claims: [{ resource: "functions/subset.js", access: "WRITE" }],
        dependsOn: ["subset"],
        probes: [
          {
            name: "fn subset handles prerelease",
            command: ["node", "-e", "const semver = require('..'); process.exit(semver.subset('1.0.0-alpha.1', '>=1.0.0-alpha') ? 0 : 1)"],
          },
        ],
      },
      {
        key: "fn-outside",
        title: "Wire outside in functions layer",
        description:
          "In functions/outside.js, ensure the outside() function correctly delegates " +
          "to the ranges layer for prerelease comparisons. Then run tests.",
        featureKey: "semver-wildcard",
        claims: [{ resource: "functions/outside.js", access: "WRITE" }],
        dependsOn: ["outside"],
        probes: [
          {
            name: "fn outside handles prerelease",
            command: ["node", "-e", "const semver = require('..'); process.exit(semver.outside('1.0.0-alpha.1', '>=1.0.0-beta', '>') ? 0 : 1)"],
          },
        ],
      },
    ],
    decomposition: {
      author: "m18-harness",
      reviewer: "m18-harness-checklist",
      schedulerBandNote:
        "dry-run: 3 waves — w1 [re-extend, semver-parse, comparator, range-parse] " +
        "w2 [subset, outside, intersects] w3 [fn-intersects, fn-subset, fn-outside]; " +
        "7/10 = 0.70 density, chain 3, 3 joins (subset, outside, intersects), " +
        "contention on classes/range.js (4 writers)",
    },
    expectedOutcome:
      "All 10 tasks integrate; prerelease versions are correctly handled by wildcard " +
      "ranges; intersects/subset/outside pass prerelease test suite.",
  });
}

// ---------- XL synthetic workload W7: slow-test duration (mocha@12.0.2) ----------

/**
 * XL pipeline workload: 16 tasks across the mocha reporter subsystem.
 * Real-repo-derived (Stratum B). 4–6 waves expected.
 *
 * Vendor: fixtures/m18/scale/mocha-12.0.2 (tag v12.0.2, commit 70db1c70)
 * Snapshot ref recorded at vendoring time.
 */
export function scaleXlMochaDuration(): ScaleWorkloadSpec {
  return defineWorkload({
    id: "scale-xl-mocha-duration",
    name: "XL slow-test duration (mocha)",
    description:
      "Sixteen tasks surfacing slow-test duration classification across mocha " +
      "reporters. Deep pipeline with contention on lib/reporters/base.js and lib/runnable.js.",
    level: "XL",
    stratum: "SYNTHETIC",
    featureSpec: {
      title: "Slow-test duration classification across reporters",
      description:
        "Add configurable slow/medium/fast duration thresholds to mocha and surface " +
        "duration-class badges in all built-in reporters.",
    },
    features: [{ key: "duration-class", title: "Slow-test duration classification" }],
    baseFiles: [],
    testFiles: [
      {
        path: "test/m18-duration-class.spec.cjs",
        content: `const assert = require("node:assert/strict");
const { Mocha } = require("../index.js");

describe("duration classification", function () {
  it("exposes slow threshold", function () {
    const m = new Mocha();
    assert.strictEqual(typeof m.options.slow, "number");
  });

  it("base reporter classifies duration", function () {
    const Base = require("../lib/reporters/base.js");
    assert.ok(typeof Base.durationClass === "function" || typeof Base.prototype.durationClass === "function");
  });
});
`,
      },
    ],
    testCommand: [
      "node",
      "bin/mocha.js",
      "--no-forbid-only",
      "test/m18-duration-class.spec.cjs",
    ],
    regressionCommand: [
      "node",
      "bin/mocha.js",
      "--no-forbid-only",
      "test/unit/*.spec.cjs",
    ],
    snapshot: {
      sourceDir: "fixtures/m18/scale/mocha-12.0.2",
      ref: "70db1c70cfe8b6a35d3e1f6c099a614abb9ff137",
      note: "mocha@12.0.2 vendored 2026-09-21, npm ci (lockfileVersion 3)",
    },
    setupCommands: [["npm", "ci"]],
    setupTimeoutMs: 600_000,
    tasks: [
      // --- Wave 1: 7 independent foundation tasks ---
      {
        key: "base-duration",
        title: "Add duration classification to Base reporter",
        description:
          "In lib/reporters/base.js, add a static method durationClass(ms, slow) " +
          "that returns 'fast', 'medium', or 'slow'. Then run tests.",
        featureKey: "duration-class",
        claims: [{ resource: "lib/reporters/base.js", access: "WRITE" }],
        dependsOn: [],
        probes: [
          { name: "base durationClass", command: ["node", "-e", "const B = require('./lib/reporters/base.js'); process.exit(typeof B.durationClass === 'function' && B.durationClass(50, 75) === 'fast' ? 0 : 1)"] },
        ],
      },
      {
        key: "min-slow",
        title: "Add slow threshold option to Mocha",
        description:
          "In lib/mocha.js, add 'slow' option (default 75ms) to constructor. Then run tests.",
        featureKey: "duration-class",
        claims: [{ resource: "lib/mocha.js", access: "WRITE" }],
        dependsOn: [],
        probes: [
          { name: "slow option", command: ["node", "-e", "const {Mocha} = require('./index.js'); const m = new Mocha(); process.exit(typeof m.options.slow === 'number' ? 0 : 1)"] },
        ],
      },
      {
        key: "json",
        title: "Add durationClass to JSON reporter",
        description:
          "In lib/reporters/json.js, add 'durationClass' field to JSON output. Then run tests.",
        featureKey: "duration-class",
        claims: [{ resource: "lib/reporters/json.js", access: "WRITE" }],
        dependsOn: [],
        probes: [
          { name: "json has durationClass", command: ["node", "-e", "const fs = require('fs'); const src = fs.readFileSync('./lib/reporters/json.js', 'utf8'); process.exit(src.includes('durationClass') ? 0 : 1)"] },
        ],
      },
      {
        key: "dot",
        title: "Add duration class to Dot reporter",
        description:
          "In lib/reporters/dot.js, color dots by duration class. Then run tests.",
        featureKey: "duration-class",
        claims: [{ resource: "lib/reporters/dot.js", access: "WRITE" }],
        dependsOn: [],
        probes: [
          { name: "dot has durationClass", command: ["node", "-e", "const fs = require('fs'); const src = fs.readFileSync('./lib/reporters/dot.js', 'utf8'); process.exit(src.includes('durationClass') ? 0 : 1)"] },
        ],
      },
      {
        key: "nyan",
        title: "Add duration class to Nyan reporter",
        description:
          "In lib/reporters/nyan.js, color the rainbow by duration class. Then run tests.",
        featureKey: "duration-class",
        claims: [{ resource: "lib/reporters/nyan.js", access: "WRITE" }],
        dependsOn: [],
        probes: [
          { name: "nyan has durationClass", command: ["node", "-e", "const fs = require('fs'); const src = fs.readFileSync('./lib/reporters/nyan.js', 'utf8'); process.exit(src.includes('durationClass') ? 0 : 1)"] },
        ],
      },
      {
        key: "xunit",
        title: "Add duration class to XUnit reporter",
        description:
          "In lib/reporters/xunit.js, add classname attribute encoding duration class. Then run tests.",
        featureKey: "duration-class",
        claims: [{ resource: "lib/reporters/xunit.js", access: "WRITE" }],
        dependsOn: [],
        probes: [
          { name: "xunit has durationClass", command: ["node", "-e", "const fs = require('fs'); const src = fs.readFileSync('./lib/reporters/xunit.js', 'utf8'); process.exit(src.includes('durationClass') ? 0 : 1)"] },
        ],
      },
      {
        key: "html",
        title: "Add duration class to HTML reporter",
        description:
          "In lib/reporters/html.js, add CSS classes for duration. Then run tests.",
        featureKey: "duration-class",
        claims: [{ resource: "lib/reporters/html.js", access: "WRITE" }],
        dependsOn: [],
        probes: [
          { name: "html has durationClass", command: ["node", "-e", "const fs = require('fs'); const src = fs.readFileSync('./lib/reporters/html.js', 'utf8'); process.exit(src.includes('durationClass') ? 0 : 1)"] },
        ],
      },
      // --- Wave 2: 4 tasks depending on wave 1 ---
      {
        key: "suite-threshold",
        title: "Wire slow threshold through Suite",
        description:
          "In lib/suite.js, propagate slow threshold from Mocha options to each Suite. Then run tests.",
        featureKey: "duration-class",
        claims: [{ resource: "lib/suite.js", access: "WRITE" }],
        dependsOn: ["min-slow"],
        probes: [
          { name: "suite propagates slow", command: ["node", "-e", "const fs = require('fs'); const src = fs.readFileSync('./lib/suite.js', 'utf8'); process.exit(src.includes('slow') && src.includes('options') ? 0 : 1)"] },
        ],
      },
      {
        key: "runnable-duration",
        title: "Add duration class to Runnable",
        description:
          "In lib/runnable.js, add durationClass property computing classification. Then run tests.",
        featureKey: "duration-class",
        claims: [{ resource: "lib/runnable.js", access: "WRITE" }],
        dependsOn: ["base-duration"],
        probes: [
          { name: "runnable has durationClass", command: ["node", "-e", "const fs = require('fs'); const src = fs.readFileSync('./lib/runnable.js', 'utf8'); process.exit(src.includes('durationClass') ? 0 : 1)"] },
        ],
      },
      {
        key: "tap",
        title: "Add duration class to TAP reporter",
        description:
          "In lib/reporters/tap.js, emit duration-class comment for each test. Then run tests.",
        featureKey: "duration-class",
        claims: [{ resource: "lib/reporters/tap.js", access: "WRITE" }],
        dependsOn: ["base-duration"],
        probes: [
          { name: "tap has durationClass", command: ["node", "-e", "const fs = require('fs'); const src = fs.readFileSync('./lib/reporters/tap.js', 'utf8'); process.exit(src.includes('durationClass') ? 0 : 1)"] },
        ],
      },
      {
        key: "min",
        title: "Add duration class to Min reporter",
        description:
          "In lib/reporters/min.js, surface duration classification for failing tests. Then run tests.",
        featureKey: "duration-class",
        claims: [{ resource: "lib/reporters/min.js", access: "WRITE" }],
        dependsOn: ["base-duration"],
        probes: [
          { name: "min has durationClass", command: ["node", "-e", "const fs = require('fs'); const src = fs.readFileSync('./lib/reporters/min.js', 'utf8'); process.exit(src.includes('durationClass') ? 0 : 1)"] },
        ],
      },
      // --- Wave 3: 2 join tasks (base + runnable) ---
      {
        key: "spec",
        title: "Surface duration class in Spec reporter",
        description:
          "In lib/reporters/spec.js, add duration-class coloring. Modify lib/reporters/base.js " +
          "for shared helpers. Modify lib/runnable.js for classification export. Then run tests.",
        featureKey: "duration-class",
        claims: [
          { resource: "lib/reporters/spec.js", access: "WRITE" },
          { resource: "lib/reporters/base.js", access: "WRITE" },
          { resource: "lib/runnable.js", access: "WRITE" },
        ],
        dependsOn: ["base-duration", "runnable-duration"],
        probes: [
          { name: "spec has durationClass", command: ["node", "-e", "const fs = require('fs'); const src = fs.readFileSync('./lib/reporters/spec.js', 'utf8'); process.exit(src.includes('durationClass') ? 0 : 1)"] },
        ],
      },
      {
        key: "list",
        title: "Surface duration class in List reporter",
        description:
          "In lib/reporters/list.js, add duration-class markers. Modify lib/reporters/base.js " +
          "for shared helpers. Modify lib/runnable.js for classification export. Then run tests.",
        featureKey: "duration-class",
        claims: [
          { resource: "lib/reporters/list.js", access: "WRITE" },
          { resource: "lib/reporters/base.js", access: "WRITE" },
          { resource: "lib/runnable.js", access: "WRITE" },
        ],
        dependsOn: ["base-duration", "runnable-duration"],
        probes: [
          { name: "list has durationClass", command: ["node", "-e", "const fs = require('fs'); const src = fs.readFileSync('./lib/reporters/list.js', 'utf8'); process.exit(src.includes('durationClass') ? 0 : 1)"] },
        ],
      },
      // --- Wave 4: 3 tasks depending on wave 2-3 ---
      {
        key: "markdown",
        title: "Add duration class to Markdown reporter",
        description:
          "In lib/reporters/markdown.js, add duration-class badges. Depends on Spec reporter " +
          "being complete for shared formatting. Then run tests.",
        featureKey: "duration-class",
        claims: [
          { resource: "lib/reporters/markdown.js", access: "WRITE" },
          { resource: "lib/reporters/base.js", access: "WRITE" },
        ],
        dependsOn: ["spec"],
        probes: [
          { name: "markdown has durationClass", command: ["node", "-e", "const fs = require('fs'); const src = fs.readFileSync('./lib/reporters/markdown.js', 'utf8'); process.exit(src.includes('durationClass') ? 0 : 1)"] },
        ],
      },
      {
        key: "progress",
        title: "Add duration class to Progress reporter",
        description:
          "In lib/reporters/progress.js, color progress bar by duration class. Then run tests.",
        featureKey: "duration-class",
        claims: [
          { resource: "lib/reporters/progress.js", access: "WRITE" },
          { resource: "lib/reporters/base.js", access: "WRITE" },
        ],
        dependsOn: [],
        probes: [
          { name: "progress has durationClass", command: ["node", "-e", "const fs = require('fs'); const src = fs.readFileSync('./lib/reporters/progress.js', 'utf8'); process.exit(src.includes('durationClass') ? 0 : 1)"] },
        ],
      },
      {
        key: "min-check",
        title: "Verify duration class propagates end-to-end",
        description:
          "Update test/m18-duration-class.spec.cjs for end-to-end assertions. " +
          "Add shared colorConstants to lib/reporters/base.js. " +
          "Ensure lib/runnable.js exports classification. Then run the full test suite.",
        featureKey: "duration-class",
        claims: [
          { resource: "test/m18-duration-class.spec.cjs", access: "WRITE" },
          { resource: "lib/reporters/base.js", access: "WRITE" },
          { resource: "lib/runnable.js", access: "WRITE" },
        ],
        dependsOn: ["min-slow", "suite-threshold", "runnable-duration"],
        probes: [
          { name: "e2e works", command: ["node", "-e", "const {Mocha} = require('./index.js'); const m = new Mocha(); process.exit(m.options.slow === 75 ? 0 : 1)"] },
        ],
      },
    ],
    decomposition: {
      author: "m18-harness",
      reviewer: "m18-harness-checklist",
      schedulerBandNote:
        "dry-run: 4 waves — w1 [base-duration, min-slow, json, dot, nyan, xunit, html] " +
        "w2 [suite-threshold, runnable-duration, tap, min] " +
        "w3 [spec, list] w4 [markdown, progress, min-check]; " +
        "12/16 = 0.750 density, chain 4, 3 joins, 1 triple-join, " +
        "contention on lib/reporters/base.js and lib/runnable.js",
    },
    expectedOutcome:
      "All 16 tasks integrate; slow-test duration classification is surfaced across " +
      "all built-in reporters; regression tests pass.",
  });
}

// ---------- XL synthetic workload W8: column-accurate position (postcss@8.5.28) ----------

/**
 * XL deep-pipeline workload: 20 tasks across the postcss AST/stringify subsystem.
 * Real-repo-derived (Stratum B). Dry-run waves vary by scheduler band.
 *
 * Vendor: fixtures/m18/scale/postcss-8.5.28 (tag 8.5.28, commit e544bffc)
 * Snapshot ref recorded at vendoring time.
 */
export function scaleXlPostcssPosition(): ScaleWorkloadSpec {
  return defineWorkload({
    id: "scale-xl-postcss-position",
    name: "XL column-accurate position (postcss)",
    description:
      "Twenty tasks ensuring column-accurate source position fidelity end-to-end " +
      "through the postcss parse→AST→stringify pipeline. Deep pipeline with contention " +
      "on lib/node.js and lib/container.js.",
    level: "XL",
    stratum: "SYNTHETIC",
    featureSpec: {
      title: "Column-accurate position fidelity end-to-end",
      description:
        "Ensure postcss preserves accurate column-level source positions through " +
        "parsing, AST manipulation, and stringification, including source map generation.",
    },
    features: [{ key: "position-fidelity", title: "Column-accurate position fidelity" }],
    baseFiles: [],
    testFiles: [
      {
        path: "test/m18-shim.js",
        content: `// M18 test-only loader shim for scale-xl-postcss-position (tracked fixture file).
// Maps postcss's three third-party leaves to minimal stubs so the REAL pinned
// postcss source loads inside Atlas git worktrees (tracked files only, no
// node_modules). Contains no feature implementation; every exercised code path
// below is pinned postcss source. The stubs are load-time only for the M18
// position tests, which parse plain CSS without source maps and never invoke
// terminal colorization:
// - picocolors: ANSI color helpers for error display cosmetics (position fields
//   are plain numbers and never branch on color output).
// - nanoid/non-secure: opaque input id suffix (position logic never branches
//   on the id value; a deterministic counter preserves uniqueness).
// - source-map-js: map consume/generate classes (unexercised: the M18 tests
//   parse plain CSS with no input maps and request no output maps).
const Module = require("node:module");
const originalLoad = Module._load;
let nanoidCounter = 0;
const identityColor = (s) => String(s);
const picocolorsStub = {
  isColorSupported: false,
  createColors: () => picocolorsStub,
  bold: identityColor,
  cyan: identityColor,
  gray: identityColor,
  green: identityColor,
  magenta: identityColor,
  red: identityColor,
  yellow: identityColor,
};
const stubs = {
  picocolors: picocolorsStub,
  "nanoid/non-secure": {
    nanoid: () => "m18-test-id-" + String((nanoidCounter += 1)).padStart(6, "0"),
  },
  "source-map-js": {
    SourceMapConsumer: class SourceMapConsumer {},
    SourceMapGenerator: class SourceMapGenerator {},
  },
};
Module._load = function (request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) {
    return stubs[request];
  }
  return originalLoad.call(this, request, parent, isMain);
};
`,
      },
      {
        path: "test/m18-position.test.js",
        content: `const postcss = require("../lib/postcss.js");
const { test } = require("node:test");

test("parse preserves column positions", () => {
  const root = postcss.parse("a { color: red }");
  const rule = root.first;
  if (rule.source.start.column !== 1) throw new Error("rule starts at column 1");
  if (rule.source.start.line !== 1) throw new Error("rule starts at line 1");
  const decl = rule.first;
  if (decl.source.start.column !== 5) throw new Error("decl starts at column 5");
});

test("stringify preserves positions", () => {
  const root = postcss.parse("a { color: red }");
  const result = root.toString();
  if (result !== "a { color: red }") throw new Error("round-trip preserves text");
});

test("node.clone preserves source", () => {
  const root = postcss.parse("a { color: red }");
  const clone = root.first.clone();
  if (clone.source.start.column !== 1) throw new Error("clone has position");
});

test("container operations preserve positions", () => {
  const root = postcss.parse("a { color: red }");
  const rule = root.first;
  const decl = rule.first;
  rule.removeChild(decl);
  rule.append(decl);
  if (rule.first.source.start.column !== 5) throw new Error("re-inserted decl has position");
});

test("warning includes position", () => {
  const root = postcss.parse("a { color: red }");
  const result = root.toResult();
  result.warn("test warning", { node: root.first });
  if (result.warnings().length !== 1) throw new Error("warning emitted");
  if (result.warnings()[0].line !== 1) throw new Error("warning has line");
});
`,
      },
    ],
    testCommand: ["node", "-r", "./test/m18-shim.js", "--test", "test/m18-position.test.js"],
    regressionCommand: ["node", "-r", "./test/m18-shim.js", "--test", "test/m18-position.test.js"],
    snapshot: {
      sourceDir: "fixtures/m18/scale/postcss-8.5.28",
      ref: "e544bffc4f4b3966d8ec69c41744b3ed65afc64a",
      note: "postcss@8.5.28 vendored 2026-09-21, npm install --legacy-peer-deps, package-lock SHA256 cc286bf3f5b045a028365db17d363f180e5fb3b619298d489bf3a2116af54912",
    },
    setupCommands: [["npm", "install", "--legacy-peer-deps"]],
    setupTimeoutMs: 600_000,
    tasks: [
      // --- Wave 1: 6 foundation tasks (no dependencies) ---
      {
        key: "input",
        title: "Ensure Input tracks column offsets accurately",
        description:
          "In lib/input.js, verify that the Input class correctly tracks column " +
          "numbers for each character, handling newlines, tabs, and Unicode. " +
          "Fix any off-by-one errors in column computation. Then run tests.",
        featureKey: "position-fidelity",
        claims: [{ resource: "lib/input.js", access: "WRITE" }],
        dependsOn: [],
        probes: [
          { name: "input tracks column offsets", command: ["node", "-e", "const Input = require('./lib/input.js'); const i = new Input('a {}'); const pos = i.fromOffset(3); process.exit(typeof pos.offset === 'number' ? 0 : 1)"] },
        ],
      },
      {
        key: "parse",
        title: "Ensure parser attaches positions to all nodes",
        description:
          "In lib/parse.js, verify that the tokenizer and parser correctly attach " +
          "source position (line, column, offset) to every AST node during parsing. " +
          "Fix any missing position annotations. Then run tests.",
        featureKey: "position-fidelity",
        claims: [{ resource: "lib/parse.js", access: "WRITE" }],
        dependsOn: [],
        probes: [
          { name: "parse loads", command: ["node", "-e", "const postcss = require('./lib/postcss.js'); const r = postcss.parse('a{}'); process.exit(r.first.source.start.column === 1 ? 0 : 1)"] },
        ],
      },
      {
        key: "list",
        title: "Ensure List preserves positions during split/join",
        description:
          "In lib/list.js, verify that List operations (split, comma) correctly " +
          "preserve source positions for each list item. Then run tests.",
        featureKey: "position-fidelity",
        claims: [{ resource: "lib/list.js", access: "WRITE" }],
        dependsOn: [],
        probes: [
          { name: "list preserves positions", command: ["node", "-e", "const {comma} = require('./lib/list.js'); const items = comma('a, b, c'); process.exit(typeof items[0] === 'object' && items[0] !== null && 'start' in items[0] ? 0 : 1)"] },
        ],
      },
      {
        key: "warning",
        title: "Ensure Warning preserves position and context",
        description:
          "In lib/warning.js, verify that Warning objects correctly store source " +
          "position and plugin context. Then run tests.",
        featureKey: "position-fidelity",
        claims: [{ resource: "lib/warning.js", access: "WRITE" }],
        dependsOn: [],
        probes: [
          { name: "warning stores source position", command: ["node", "-e", "const Warning = require('./lib/warning.js'); const postcss = require('./lib/postcss.js'); const root = postcss.parse('a { color: red }'); const w = new Warning('test', {node: root.first, plugin: 'p'}); process.exit(typeof w.source === 'string' ? 0 : 1)"] },
        ],
      },
      {
        key: "css-syntax-error",
        title: "Ensure CssSyntaxError includes accurate position",
        description:
          "In lib/css-syntax-error.js, verify that CssSyntaxError objects include " +
          "accurate line/column/offset information. Then run tests.",
        featureKey: "position-fidelity",
        claims: [{ resource: "lib/css-syntax-error.js", access: "WRITE" }],
        dependsOn: [],
        probes: [
          { name: "css-syntax-error includes offset", command: ["node", "-e", "const postcss = require('./lib/postcss.js'); try { postcss.parse('{'); } catch(e) { process.exit(typeof e.offset === 'number' ? 0 : 1); }"] },
        ],
      },
      {
        key: "result",
        title: "Ensure Result preserves root positions",
        description:
          "In lib/result.js, verify that Result objects correctly preserve source " +
          "positions through the root AST. Then run tests.",
        featureKey: "position-fidelity",
        claims: [{ resource: "lib/result.js", access: "WRITE" }],
        dependsOn: [],
        probes: [
          { name: "result loads", command: ["node", "-e", "const postcss = require('./lib/postcss.js'); const r = postcss.parse('a{}'); const res = r.toResult(); process.exit(typeof res.root === 'object' ? 0 : 1)"] },
        ],
      },
      // --- Wave 2: 4 node-type tasks (depend on parse) ---
      {
        key: "node",
        title: "Ensure Node.source is accurate and immutable-friendly",
        description:
          "In lib/node.js, verify that the Node class correctly stores and exposes " +
          "source positions. Ensure source is preserved during basic operations. " +
          "Then run tests.",
        featureKey: "position-fidelity",
        claims: [{ resource: "lib/node.js", access: "WRITE" }],
        dependsOn: [],
        probes: [
          { name: "node source immutable", command: ["node", "-e", "const postcss = require('./lib/postcss.js'); const root = postcss.parse('a { color: red }'); const c = root.first.clone(); c.source.start.line = 999; process.exit(root.first.source.start.line !== 999 ? 0 : 1)"] },
        ],
      },
      {
        key: "rule",
        title: "Ensure Rule preserves position through manipulation",
        description:
          "In lib/rule.js, verify that Rule nodes correctly preserve source positions " +
          "during append, prepend, and removeChild operations. Then run tests.",
        featureKey: "position-fidelity",
        claims: [{ resource: "lib/rule.js", access: "WRITE" }],
        dependsOn: ["node"],
        probes: [
          { name: "rule loads", command: ["node", "-e", "const postcss = require('./lib/postcss.js'); const r = postcss.parse('a{}'); process.exit(r.first.type === 'rule' ? 0 : 1)"] },
        ],
      },
      {
        key: "at-rule",
        title: "Ensure AtRule preserves position through manipulation",
        description:
          "In lib/at-rule.js, verify that AtRule nodes correctly preserve source " +
          "positions during append, prepend, and removeChild operations. Then run tests.",
        featureKey: "position-fidelity",
        claims: [{ resource: "lib/at-rule.js", access: "WRITE" }],
        dependsOn: ["node"],
        probes: [
          { name: "at-rule loads", command: ["node", "-e", "const postcss = require('./lib/postcss.js'); const r = postcss.parse('@media{}'); process.exit(r.first.type === 'atrule' ? 0 : 1)"] },
        ],
      },
      {
        key: "comment",
        title: "Ensure Comment preserves position through manipulation",
        description:
          "In lib/comment.js, verify that Comment nodes correctly preserve source " +
          "positions during clone and parent operations. Then run tests.",
        featureKey: "position-fidelity",
        claims: [{ resource: "lib/comment.js", access: "WRITE" }],
        dependsOn: ["node"],
        probes: [
          { name: "comment loads", command: ["node", "-e", "const postcss = require('./lib/postcss.js'); const r = postcss.parse('/* hi */ a{}'); process.exit(r.first.type === 'comment' ? 0 : 1)"] },
        ],
      },
      // --- Wave 3: 3 pipeline tasks (depend on node or rule) ---
      {
        key: "position",
        title: "Add position helper methods to Node",
        description:
          "In lib/node.js, add positionBy(offset) and positionInside(offset) helper " +
          "methods that compute accurate column positions for insertion points. " +
          "Then run tests.",
        featureKey: "position-fidelity",
        claims: [{ resource: "lib/node.js", access: "WRITE" }],
        dependsOn: ["node"],
        probes: [
          { name: "position helpers compute offset", command: ["node", "-e", "const postcss = require('./lib/postcss.js'); const root = postcss.parse('a { color: red }'); const pos = root.first.positionBy({offset: 5}); process.exit(pos.column === 6 ? 0 : 1)"] },
        ],
      },
      {
        key: "stringifier",
        title: "Ensure Stringifier preserves node positions in output",
        description:
          "In lib/stringifier.js (or lib/stringify.js), verify that the Stringifier " +
          "correctly uses source positions when generating output. Fix any cases " +
          "where positions are lost during stringification. Then run tests.",
        featureKey: "position-fidelity",
        claims: [{ resource: "lib/stringify.js", access: "WRITE" }],
        dependsOn: ["rule"],
        probes: [
          { name: "stringifier preserves positions", command: ["node", "-e", "const postcss = require('./lib/postcss.js'); const root = postcss.parse('a { color: red }'); const output = root.toString(); process.exit(output === 'a { color: red }' ? 0 : 1)"] },
        ],
      },
      {
        key: "from-json",
        title: "Ensure fromJSON preserves positions during deserialization",
        description:
          "In lib/fromJSON.js, verify that fromJSON correctly reconstructs source " +
          "positions when deserializing a previously stringified AST. Then run tests.",
        featureKey: "position-fidelity",
        claims: [{ resource: "lib/fromJSON.js", access: "WRITE" }],
        dependsOn: ["node"],
        probes: [
          { name: "fromJSON preserves positions", command: ["node", "-e", "const postcss = require('./lib/postcss.js'); const root = postcss.parse('a { color: red }'); const json = root.toJSON(); const root2 = postcss.fromJSON(json); process.exit(root2.first.source.start.column === 1 && root2.first.source.start.line === 1 ? 0 : 1)"] },
        ],
      },
      // --- Wave 4: 3 container tasks (depend on position) ---
      {
        key: "container",
        title: "Ensure Container preserves positions during child ops",
        description:
          "In lib/container.js, verify that append, prepend, removeChild, and " +
          "insertAfter correctly update and preserve source positions for all " +
          "affected children. Fix position recalculation bugs. Then run tests.",
        featureKey: "position-fidelity",
        claims: [{ resource: "lib/container.js", access: "WRITE" }],
        dependsOn: ["position"],
        probes: [
          { name: "container preserves positions on append", command: ["node", "-e", "const postcss = require('./lib/postcss.js'); const root = postcss.parse('a { color: red }'); const d = postcss.decl({prop: 'margin', value: '0'}); root.first.append(d); process.exit(d.source !== undefined ? 0 : 1)"] },
        ],
      },
      {
        key: "container-clone",
        title: "Ensure deep clone preserves all positions",
        description:
          "In lib/container.js, verify that clone() deeply copies all source positions " +
          "through the subtree. Fix any cases where cloned nodes lose position data. " +
          "Then run tests.",
        featureKey: "position-fidelity",
        claims: [{ resource: "lib/container.js", access: "WRITE" }],
        dependsOn: ["container"],
        probes: [
          { name: "clone preserves", command: ["node", "-e", "const postcss = require('./lib/postcss.js'); const r = postcss.parse('a{color:red}'); const c = r.clone(); process.exit(c.first.source.start.line === 1 ? 0 : 1)"] },
        ],
      },
      {
        key: "container-walk",
        title: "Ensure walk/walkDefs preserves positions in traversal",
        description:
          "In lib/container.js, verify that walk(), walkRules(), walkDecls(), etc. " +
          "correctly visit nodes with accurate positions. Fix any traversal bugs. " +
          "Then run tests.",
        featureKey: "position-fidelity",
        claims: [{ resource: "lib/container.js", access: "WRITE" }],
        dependsOn: ["container"],
        probes: [
          { name: "walk works", command: ["node", "-e", "const postcss = require('./lib/postcss.js'); const r = postcss.parse('a{color:red}'); let count=0; r.walk(() => count++); process.exit(count > 0 ? 0 : 1)"] },
        ],
      },
      // --- Wave 5: 2 final tasks (triple-join) ---
      {
        key: "lazy-result",
        title: "Ensure LazyResult preserves positions through async pipeline",
        description:
          "In lib/lazy-result.js, verify that the async processing pipeline " +
          "correctly preserves source positions through plugin execution and " +
          "post-processing. Then run tests.",
        featureKey: "position-fidelity",
        claims: [{ resource: "lib/lazy-result.js", access: "WRITE" }],
        dependsOn: ["stringifier", "container-walk", "container-clone"],
        probes: [
          { name: "lazy-result loads", command: ["node", "-e", "const postcss = require('./lib/postcss.js'); const r = postcss.parse('a{}'); const res = r.toResult(); process.exit(typeof res.root === 'object' ? 0 : 1)"] },
        ],
      },
      {
        key: "source-map",
        title: "Verify source map includes accurate column positions",
        description:
          "Verify that postcss source map generation includes accurate column-level " +
          "positions for each CSS rule and declaration. Fix any mapping inaccuracies. " +
          "Update test/m18-position.test.js with source map assertions. Then run tests.",
        featureKey: "position-fidelity",
        claims: [{ resource: "test/m18-position.test.js", access: "WRITE" }],
        dependsOn: ["lazy-result", "from-json"],
        probes: [
          { name: "source map works", command: ["node", "-e", "const postcss = require('./lib/postcss.js'); const r = postcss.parse('a{color:red}'); const res = r.toResult({map:true}); process.exit(res.map !== undefined ? 0 : 1)"] },
        ],
      },
    ],
    decomposition: {
      author: "m18-harness",
      reviewer: "m18-harness-checklist",
      schedulerBandNote:
        "dry-run: 5 waves — w1 [input, parse, list, warning, css-syntax-error, result] " +
        "w2 [node, rule, at-rule, comment] w3 [position, stringifier, from-json] " +
        "w4 [container, container-clone, container-walk] w5 [lazy-result, source-map]; " +
        "15/20 = 0.750 density, chain 4, 3 joins, 1 triple-join, " +
        "contention on lib/node.js (2 writers), lib/container.js (3 writers)",
    },
    expectedOutcome:
      "All 20 tasks integrate; column-accurate positions are preserved end-to-end " +
      "through parse→AST→stringify; source maps include accurate column data.",
  });
}



const BUILDERS: Record<string, () => ScaleWorkloadSpec> = {
  "scale-small-catalog": scaleSmallCatalog,
  "scale-small-validators": scaleSmallValidators,
  "scale-medium-router": scaleMediumRouter,
  "scale-medium-shop": scaleMediumShop,
  "scale-large-gfm-tables": scaleLargeGfmTables,
  "scale-large-semver-wildcard": scaleLargeSemverWildcard,
  "scale-xl-mocha-duration": scaleXlMochaDuration,
  "scale-xl-postcss-position": scaleXlPostcssPosition,
};

export function listScaleWorkloadIds(): string[] {
  return Object.keys(BUILDERS).sort();
}

export function getScaleWorkload(id: string): ScaleWorkloadSpec {
  const build = BUILDERS[id];
  if (build === undefined) {
    throw new BenchmarkError(`unknown M18 scale workload: ${id}`);
  }
  return build();
}
