import type { ArticleBlock } from "./article.jsx";

export const ARCH_ARTICLES: Record<string, ArticleBlock[]> = {
  overview: [
    {
      kind: "intro",
      text: "Atlas is a TypeScript CLI plus a set of engine services over SQLite state and Git worktrees. There is no server process, no queue, no daemon — every command loads state, acts through services, and exits.",
    },
    { kind: "h2", id: "layers", text: "Layers" },
    {
      kind: "table",
      head: ["Layer", "Location", "Role"],
      rows: [
        ["CLI", "`src/cli/`", "Argument parsing, approval gating, human/machine output."],
        ["Core domain", "`src/core/`", "Entities, state machines, approval and event records."],
        ["Planner", "`src/planner/`", "Untrusted proposal validation; providers return data, never authority."],
        ["Scheduler", "`src/dag/`", "Deterministic claim-aware wave planning."],
        ["Workers", "`src/workers/`", "Assignment, subprocess execution, Git-diff evidence."],
        ["Verification + train", "`src/verification/`", "Atlas-executed tests, verdicts, ordered integration."],
        ["Git engine", "`src/git/`", "Repository inspection and worktree lifecycle via CLI."],
        ["State", "`prisma/`, SQLite", "Orchestration metadata only — never source code."],
      ],
    },
    { kind: "h2", id: "git-truth", text: "Git is the source of truth" },
    {
      kind: "p",
      text: "Source code lives in Git; Atlas stores lifecycle state, references (paths, SHAs, branch names), and append-only events. The database never holds file contents, and every consequential claim — what changed, what was tested, what merged — is re-derivable from repositories.",
    },
  ],
  lifecycle: [
    {
      kind: "intro",
      text: "One approved feature, end to end. Each stage has an explicit gate; skipping a gate is not possible through the CLI.",
    },
    {
      kind: "code",
      language: "text",
      title: "Execution lifecycle",
      code: "proposal file\n  → plan validates + persists tasks (PLAN_CREATED)\n  → human approves plan (APPROVED, actor-stamped)\n  → run: human approves merge upfront (--approve-merge)\n  → wave loop: schedule → assign → execute → test → verify\n  → VERIFIED tasks enter the merge train in wave order\n  → per-item re-verification → merge commit per item\n  → halt on first conflict (named, persisted) or complete\n  → human merges the train branch into main themselves",
    },
    { kind: "h2", id: "waves", text: "Waves and re-planning" },
    {
      kind: "p",
      text: "Each round re-plans from fresh state: completed tasks unblock dependents for the next wave, and verified work feeds the train. Later workers stay based on the run's base commit, so overlapping writes can genuinely conflict in the train — that behavior is intentional, not a bug.",
    },
  ],
  boundaries: [
    {
      kind: "intro",
      text: "Three boundaries carry the entire safety model. Each one answers a single question: who is never trusted here?",
    },
    { kind: "h2", id: "planner", text: "Planner boundary: proposals are untrusted" },
    {
      kind: "p",
      text: "AI-generated plans arrive as JSON and must pass deterministic validation (shape, claim normalization, acyclicity) before they can influence execution. Validation failure writes nothing.",
    },
    { kind: "h2", id: "provider", text: "Provider boundary: agents produce bytes, not truth" },
    {
      kind: "p",
      text: "The provider subprocess returns a summary and notes through a strict schema. Stdout is captured and bounded; exit codes, timeouts, and spawn failures are classified structurally. What the agent claims to have changed is informational — Atlas recomputes changes from Git.",
    },
    { kind: "h2", id: "verification", text: "Verification boundary: evidence over self-report" },
    {
      kind: "p",
      text: "Tests execute under Atlas's control inside the worker workspace, and the verdict cites the Atlas-executed run. Provider `testsPassed` flags are metadata. The merge train re-verifies each item at integration time against the cited run.",
    },
  ],
  state: [
    {
      kind: "intro",
      text: "Thirteen entities, explicit state machines, deterministic invariants. State answers operational questions; it never substitutes for repository content.",
    },
    { kind: "h2", id: "resolution", text: "Where state lives" },
    {
      kind: "p",
      text: "SQLite via Prisma, resolved as: explicit `DATABASE_URL`, then nearest `.atlas/atlas.db` walking up from the working directory, then the legacy checkout-relative default. Per-project isolation is by file, chosen explicitly — see [Configuration](/docs/start/configuration).",
    },
    { kind: "h2", id: "migrations", text: "Schema changes" },
    {
      kind: "p",
      text: "Schema evolves through Prisma migrations (`prisma migrate dev` in development). There is no auto-migration at runtime and no destructive migration path — a missing database is provisioned deliberately, never silently.",
    },
  ],
  security: [
    {
      kind: "intro",
      text: "Atlas's security model is stated as guarantees and explicit non-guarantees. Read both before running untrusted agents.",
    },
    { kind: "h2", id: "guarantees", text: "What Atlas guarantees" },
    {
      kind: "list",
      items: [
        "Workers execute only in their assigned worktree, on their assigned branch.",
        "Modifications outside declared WRITE claims fail the task after the fact.",
        "Provider output is schema-validated; malformed output fails safely.",
        "State transitions require approval or narrow human-confirmed commands with recorded actors.",
        "Main is never merged by Atlas; train branches are separate by construction.",
        "Credentials are never stored — ambient environment is forwarded allowlist-only.",
      ],
    },
    { kind: "h2", id: "non-guarantees", text: "What Atlas does not guarantee" },
    {
      kind: "list",
      items: [
        "No filesystem or network sandbox: a hostile worker process can touch the wider filesystem.",
        "No multi-user access control: a single operator per database is the model.",
        "No secret scanning: do not put secrets in proposals, prompts, or claims.",
        "No supply-chain verification of the agent executable itself.",
      ],
    },
    {
      kind: "callout",
      tone: "warn",
      title: "Reporting vulnerabilities",
      text: "Do not file public issues for suspected vulnerabilities. Use the contact address on the [Contact](/docs/reference/contact) page with a private description, reproduction scope, and affected version.",
    },
  ],
};
