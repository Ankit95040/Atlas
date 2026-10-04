import type { ArticleBlock } from "./article.jsx";

export const START_ARTICLES: Record<string, ArticleBlock[]> = {
  "what-is-atlas": [
    {
      kind: "intro",
      text: "Atlas is an experimental control plane for orchestrating AI coding agents. It coordinates isolated coding work, enforces task boundaries, verifies results, and keeps developers in control — without claiming to make agents faster or better.",
    },
    { kind: "h2", id: "pipeline", text: "The pipeline" },
    {
      kind: "p",
      text: "Every Atlas run follows the same shape: a feature specification is decomposed into tasks, dependencies are analyzed, resource claims are recorded, isolated workers execute, results are verified, and verified work integrates through an ordered merge train. A human approves the plan and the merge; nothing proceeds silently.",
    },
    {
      kind: "code",
      language: "text",
      title: "The Atlas pipeline",
      code: "Feature specification\n→ task decomposition\n→ dependency analysis\n→ resource claims\n→ isolated AI workers\n→ verification\n→ ordered integration",
    },
    { kind: "h2", id: "principles", text: "Principles that constrain the design" },
    {
      kind: "list",
      items: [
        "The human remains the final authority — approvals are explicit, actor-stamped decisions.",
        "Git is the source of truth for code; Atlas state lives separately in SQLite.",
        "Workers use isolated workspaces; Atlas never silently modifies a running workspace.",
        "Resource claims matter more than domain labels — enforcement happens after the fact from Git diffs.",
        "Deterministic validation is preferred over model judgment everywhere it can apply.",
        "Atlas never automatically merges into main and never trusts an AI-generated plan without validation.",
      ],
    },
    {
      kind: "callout",
      tone: "honest",
      title: "Experimental status",
      text: "Atlas is experimental open-source research software. Benchmark evidence shows verified-success parity with single-agent workflows on tested fixtures — not superiority. See [Project status](/docs/reference/project-status) before relying on Atlas for anything important.",
    },
  ],
  prerequisites: [
    {
      kind: "intro",
      text: "Atlas runs from its own checkout today: a Node.js runtime, pnpm workspace, Git binary, and an authenticated coding-agent CLI for real execution.",
    },
    { kind: "h2", id: "required", text: "Required" },
    {
      kind: "list",
      items: [
        "Node.js ≥ 20 and pnpm (the repo pins engines at node >=20).",
        "Git with a configured identity — workers commit in isolated worktrees.",
        "A coding-agent CLI for real execution (for example `opencode`), already authenticated. Atlas forwards ambient credentials; it never stores provider secrets.",
        "Docker is listed by `atlas doctor` but is informational only — Docker is not used for isolation.",
      ],
    },
    { kind: "h2", id: "agent", text: "Agent and model" },
    {
      kind: "p",
      text: "Atlas invokes the agent as an argv-only subprocess with no shell, bounded output, a configurable timeout, and a minimal environment. Record the exact model label you run — it becomes part of the run's provenance metadata.",
    },
    {
      kind: "callout",
      tone: "info",
      title: "No sandbox",
      text: "Workers run as subprocesses with claim enforcement after the fact, not prevention. There is no filesystem or network sandbox — see [Security model](/docs/architecture/security).",
    },
  ],
  configuration: [
    {
      kind: "intro",
      text: "Atlas resolves its SQLite state in a documented precedence order. Understanding it prevents the most common confusion: two checkouts silently sharing one database.",
    },
    { kind: "h2", id: "resolution", text: "State resolution order" },
    {
      kind: "list",
      items: [
        "`DATABASE_URL` environment variable wins when set.",
        "Otherwise the nearest `.atlas/atlas.db` walking up from the working directory.",
        "Otherwise the legacy default `file:./dev.db`, resolved relative to the Atlas checkout.",
      ],
    },
    {
      kind: "code",
      language: "sh",
      title: "Configure state",
      code: "cp .env.example .env   # then set DATABASE_URL (default: file:./dev.db)\nnpx prisma migrate dev\nnpx prisma generate",
    },
    { kind: "h2", id: "per-project", text: "Per-project state" },
    {
      kind: "p",
      text: "`atlas init --state-dir <dir>` points a project at its own `<dir>/atlas.db`, which must already be provisioned. The file — not the directory alone — is what the resolver looks for, so a bare `.atlas/` folder never hijacks resolution.",
    },
    {
      kind: "callout",
      tone: "warn",
      title: "Never hand-edit the database",
      text: "Every supported transition has a CLI path. Hand edits bypass validation, break the event history, and can strand assignments. If no CLI path covers your case, that is a deliberate gap — report it instead of working around it.",
    },
  ],
  "first-run": [
    {
      kind: "intro",
      text: "The full loop on a scratch repository: register it, propose tasks, approve the plan, execute, and observe. Use a throwaway checkout — never your first run against work you care about.",
    },
    { kind: "h2", id: "install", text: "Install and check" },
    {
      kind: "code",
      language: "sh",
      title: "Build and verify the toolchain",
      code: "pnpm install\nnpm run build\nnode ./dist/cli/run.js doctor",
    },
    {
      kind: "p",
      text: "`doctor` checks Node, Git, Docker (informational), configuration, and database connectivity. Fix anything it reports before continuing.",
    },
    { kind: "h2", id: "init", text: "Register the repository" },
    {
      kind: "code",
      language: "sh",
      title: "Create project, repository, and feature rows",
      code: 'node ./dist/cli/run.js init \\\n  --name "my-project" \\\n  --repo-path /path/to/your/checkout \\\n  --feature-title "first feature"',
    },
    {
      kind: "p",
      text: "`init` validates the path is a Git checkout, then prints `project:`, `repository:`, and `feature:` IDs plus the exact next command. Keep the feature ID — everything else keys off it.",
    },
    { kind: "h2", id: "proposal", text: "Write a proposal" },
    {
      kind: "p",
      text: "A proposal is untrusted JSON: tasks with filesystem-path claims and dependencies. Atlas validates it deterministically and rejects anything malformed without writing.",
    },
    {
      kind: "code",
      language: "json",
      title: "proposal.json",
      code: '{\n  "featureId": "<feature-id-from-init>",\n  "tasks": [\n    {\n      "id": "t1",\n      "title": "Add input validation",\n      "claims": [{ "resource": "src/validate.ts", "access": "WRITE" }]\n    },\n    {\n      "id": "t2",\n      "title": "Cover validation with tests",\n      "claims": [{ "resource": "test/validate.test.ts", "access": "WRITE" }]\n    }\n  ],\n  "dependencies": [{ "taskId": "t2", "dependsOnTaskId": "t1" }]\n}',
    },
    {
      kind: "p",
      text: "Rules: at least one task, unique task ids, no self-dependencies, no unknown references, claims are paths (never file contents). Keep claims tight — workers may only touch claimed paths.",
    },
    { kind: "h2", id: "execute", text: "Plan, approve, run" },
    {
      kind: "code",
      language: "sh",
      title: "Preview, approve, execute",
      code: "node ./dist/cli/run.js plan --feature <feature-id> --proposal proposal.json\n\nnode ./dist/cli/run.js plan --feature <feature-id> --proposal proposal.json \\\n  --approve --actor <your-name>\n\nnode ./dist/cli/run.js run \\\n  --feature <feature-id> \\\n  --repository <repository-id> \\\n  --plan-approval <approval-id> \\\n  --actor <your-name> \\\n  --agent opencode --agent-arg run --agent-arg --agent --agent-arg build \\\n  --approve-merge",
    },
    {
      kind: "p",
      text: "Both approvals are required and both record the human actor. Verified work lands on a train branch you merge yourself — Atlas never merges into `main`. Tune with `--max-concurrency`, `--agent-timeout-ms`, `--agent-env`, `--test-command`/`--test-arg`, `--train-branch`, `--workspace-root`. Exit codes: `0` success, `1` completed with failures, `2` blocked.",
    },
    {
      kind: "callout",
      tone: "info",
      title: "Routing advisory",
      text: "`plan` prints a routing recommendation (SINGLE_AGENT, ORCHESTRATED, or REQUIRES_REVIEW) with reasons. It is advisory only — automatic routing is disabled and execution always follows the approved plan shape.",
    },
  ],
  "inspecting-output": [
    {
      kind: "intro",
      text: "Every run leaves a complete evidence trail. These read-only commands are how you find out what actually happened — start here before touching anything.",
    },
    {
      kind: "code",
      language: "sh",
      title: "Observation commands",
      code: "node ./dist/cli/run.js status <feature-id>          # overview + visible failures\nnode ./dist/cli/run.js show run <feature-id>        # tasks, timing, failures\nnode ./dist/cli/run.js show task <task-id>          # evidence for one task\nnode ./dist/cli/run.js history <feature-id>         # chronological events\nnode ./dist/cli/run.js claims <feature-id>          # claims + overlaps\nnode ./dist/cli/run.js diagnose <feature-id>        # failure analysis + next steps",
    },
    { kind: "h2", id: "timing", text: "Reading timing" },
    {
      kind: "p",
      text: "`show run` includes a timing block (total, scheduling, assign, worker, tests, verify, train) with an explicit `missing` list for phases that did not run. Absent measurements are named, never zero-filled — a zero means the phase ran in under a millisecond.",
    },
    { kind: "h2", id: "task-results", text: "Understanding task results" },
    {
      kind: "list",
      items: [
        "`COMPLETED` — verified work with a real contribution.",
        "`COMPLETED_EMPTY` — valid execution with no effective source contribution; terminal, distinct from both success and failure.",
        "`FAILED` — execution, test, verification, or claim failure, each with structured evidence.",
        "`BLOCKED` — waiting on dependencies or a halted train, not an error in itself.",
      ],
    },
  ],
  cleanup: [
    {
      kind: "intro",
      text: "Atlas creates worktrees, train branches, and state rows. Cleaning up means removing the disposable copies while leaving history intact.",
    },
    { kind: "h2", id: "worktrees", text: "Worktrees and train branches" },
    {
      kind: "p",
      text: "Worker workspaces and train worktrees live under `.atlas/` in the target checkout (or your explicit `--workspace-root`). Remove them with Git worktree commands once the run is complete and merged or abandoned — never `rm -rf` a registered worktree while Atlas still references it.",
    },
    { kind: "h2", id: "never", text: "What never to delete by hand" },
    {
      kind: "list",
      items: [
        "The SQLite state file while any run references it — history is append-only by design.",
        "Train branches before merging or deliberately abandoning their commits.",
        "A running worker's workspace — Atlas never modifies one silently, and neither should you.",
      ],
    },
    {
      kind: "callout",
      tone: "warn",
      title: "Destructive Git cleanup",
      text: "Never run broad cleanup (`git clean -fdx`, worktree pruning across projects) to fix an Atlas state problem. Diagnose first with `diagnose`, then use `recover` or `task transition` — both record actor and reason.",
    },
  ],
  "common-errors": [
    {
      kind: "intro",
      text: "The errors you will actually see, what each one means, and the safe next step. Full symptom-first index lives in [Troubleshooting](/docs/reference/troubleshooting).",
    },
    {
      kind: "table",
      head: ["Message", "Meaning", "Next step"],
      rows: [
        ["`plan approval not found`", "The approval ID is wrong, belongs to another feature, or was never APPROVED.", "Re-run `plan` and use the printed approval ID."],
        ["`CLAIM_VIOLATION`", "The worker touched paths outside its claims.", "Narrow the task or widen claims deliberately, then replan."],
        ["`NOT_AUTHORIZED`", "No APPROVED execution approval exists for the task.", "Approve the plan with `--approve --actor`; never bypass."],
        ["`TIMEOUT` / SIGTERM", "The provider exceeded its timeout and was killed with escalation.", "Inspect partial work, raise `--agent-timeout-ms`, or split the task."],
        ["`train HALTED ... CONFLICT`", "Two verified commits genuinely conflict; main is untouched.", "Resolve in Git yourself, or replan the overlapping tasks."],
        ["`unknown run scope`", "The feature ID does not exist in the resolved database.", "Check `DATABASE_URL` resolution and the ID."],
      ],
    },
  ],
};
