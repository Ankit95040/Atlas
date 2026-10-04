import type { ArticleBlock } from "./article.jsx";

export const CONCEPTS_ARTICLES: Record<string, ArticleBlock[]> = {
  plans: [
    {
      kind: "intro",
      text: "Plans begin as untrusted JSON and become executable only after deterministic validation plus explicit human approval. An AI-generated plan is never authority — it is a proposal that must survive validation.",
    },
    { kind: "h2", id: "proposal", text: "Proposals are untrusted input" },
    {
      kind: "p",
      text: "A proposal file carries tasks (ids, titles, descriptions), resource claims, and dependencies. The planner boundary validates shape, normalizes claims, checks the dependency graph for cycles, and rejects anything malformed — without writing anything.",
    },
    { kind: "h2", id: "approval", text: "Approval is a human decision" },
    {
      kind: "p",
      text: "`plan --approve --actor <name>` records an APPROVED decision with a human author. Approvals are never silent, never defaulted, and never inferred from exit codes. The run command refuses to execute without one.",
    },
    {
      kind: "callout",
      tone: "info",
      title: "Preview, not execution",
      text: "`plan` also prints a schedule preview (waves, conflicts, blocked tasks) computed with hypothetical workers. It creates nothing, assigns nothing, and executes nothing.",
    },
  ],
  tasks: [
    {
      kind: "intro",
      text: "Tasks are the unit of scheduled, claimed, executed, and verified work. Dependencies between tasks form a directed graph the scheduler plans over deterministically.",
    },
    { kind: "h2", id: "lifecycle", text: "Lifecycle" },
    {
      kind: "p",
      text: "Tasks move through explicit states — pending, ready, claimed, in progress, verification, completed or failed — with blocked tasks waiting on dependencies or a halted train. Every transition is an event with an actor.",
    },
    { kind: "h2", id: "scheduler", text: "Claim-aware scheduling" },
    {
      kind: "p",
      text: "The scheduler plans waves from the dependency graph and resource claims: tasks that write overlapping paths cannot run in the same wave. Plans are deterministic — the same validated proposal always yields the same schedule, with machine-readable reasons for every blocked task.",
    },
    {
      kind: "callout",
      tone: "warn",
      title: "Stuck states",
      text: "A task stuck outside the normal flow (orphaned assignment, verification limbo) is moved only by `task transition`, which allows a single edge with a recorded actor and reason — never an arbitrary jump.",
    },
  ],
  workers: [
    {
      kind: "intro",
      text: "A worker is an approved task bound to an isolated Git worktree and executed as a provider subprocess. Git diffs — not provider claims — determine what changed.",
    },
    { kind: "h2", id: "isolation", text: "Isolation model" },
    {
      kind: "p",
      text: "Each worker gets its own worktree on its own branch, created outside the repository root and never inside it. The provider runs with the workspace as its working directory, argv-only commands (no shell), bounded output, timeouts with escalation, and a minimal allowlisted environment.",
    },
    { kind: "h2", id: "evidence", text: "Evidence over self-report" },
    {
      kind: "p",
      text: "After execution, Atlas inspects the worktree itself: the diff against the base commit, claim coverage of every changed path, and the resulting commit. Provider summaries are echoed verbatim into the record but never treated as evidence.",
    },
    {
      kind: "callout",
      tone: "honest",
      title: "Not a sandbox",
      text: "Isolation is process and filesystem separation for honest bookkeeping — a hostile process can still touch the wider filesystem. OS or container sandboxing remains future work and is never claimed here.",
    },
  ],
  claims: [
    {
      kind: "intro",
      text: "Every task declares the filesystem paths it will read or write. Claims are the security and scheduling primitive of Atlas — more important than any domain label.",
    },
    { kind: "h2", id: "semantics", text: "Claim semantics" },
    {
      kind: "p",
      text: "Claims name repo-relative paths with `READ` or `WRITE` access. They drive scheduling (overlapping writes serialize), verification (changed paths must be covered by WRITE claims), and the pairwise-overlap view in `atlas claims`. Anything a worker modifies outside its claims is rejected after the fact as a claim violation.",
    },
    { kind: "h2", id: "tight", text: "Keep claims tight" },
    {
      kind: "p",
      text: "Overly broad claims serialize work that could run in parallel and weaken the meaning of enforcement. Claim exactly the files the task needs — no more.",
    },
  ],
  verification: [
    {
      kind: "intro",
      text: "Verification is Atlas executing the repository's own tests against the worker's work — never the provider grading its own homework.",
    },
    { kind: "h2", id: "process", text: "How it works" },
    {
      kind: "p",
      text: "After a task completes, Atlas runs the configured test command (defaulting to the repository's `scripts.test`) inside the worker's workspace and records the run. An independent verification step then cites that Atlas-executed run to reach a `VERIFIED` or `REJECTED` verdict with reasons. Only verified tasks become candidates for the merge train.",
    },
    { kind: "h2", id: "empty", text: "Empty contributions" },
    {
      kind: "p",
      text: "Valid execution that produces no effective diff yields `COMPLETED_EMPTY` — terminal, honest, and distinct from both success and failure. It never enters the train.",
    },
  ],
  "merge-train": [
    {
      kind: "intro",
      text: "Verified work integrates through an ordered, approval-gated merge train onto a dedicated branch. Main is never merged — you merge the train yourself.",
    },
    { kind: "h2", id: "order", text: "Ordered integration" },
    {
      kind: "p",
      text: "Train items integrate in wave order with per-item re-verification at merge time. Each merge is a real Git merge (no fast-forward) onto the train branch, recorded with the source commit so every record identifies exactly what was merged.",
    },
    { kind: "h2", id: "halt", text: "Conflicts halt, loudly" },
    {
      kind: "p",
      text: "A genuine conflict halts the train with the conflicting item named — integrated items stay integrated, unattempted items stay unattempted. The halt is a persisted event with a reason, diagnosable via `diagnose`. Atlas never force-merges, rebases, or resolves conflicts on your behalf.",
    },
  ],
  events: [
    {
      kind: "intro",
      text: "Every state change in Atlas is an append-only event with an actor. History is the product: `history` shows the chronological record of a run, and `diagnose` reads it to explain failures.",
    },
    { kind: "h2", id: "approvals", text: "Approvals as decisions" },
    {
      kind: "p",
      text: "Plan approval and merge approval are created PENDING and decided exactly once — APPROVED or REJECTED — with actor and timestamp. Decision rows are the audit trail that makes human authority verifiable rather than asserted.",
    },
    { kind: "h2", id: "timing", text: "Timing as evidence" },
    {
      kind: "p",
      text: "Scheduling, assignment, worker, test, verification, and train spans are recorded per task and rolled up per run, with absent phases named explicitly instead of zero-filled. Timing is measurement for bottleneck analysis — never a performance claim.",
    },
  ],
  recovery: [
    {
      kind: "intro",
      text: "When execution stalls — stranded assignments, orphaned workers, verification limbo — Atlas provides explicit, human-confirmed exits. Nothing recovers silently.",
    },
    { kind: "h2", id: "stranded", text: "Stranded assignments" },
    {
      kind: "p",
      text: "`recover task` releases a CLAIMED or ASSIGNED task whose worker will never complete, making it schedulable again. It requires a human actor, records a `TASK_RECOVERED` event with previous and resulting states, and refuses when recovery would be unsafe (for example, when the task already has terminal evidence).",
    },
    { kind: "h2", id: "transition", text: "Stuck-state transitions" },
    {
      kind: "p",
      text: "`task transition` moves a task along exactly one allowed state-machine edge with actor and reason, emitting `TASK_TRANSITIONED`. It is the escape hatch for states the normal loop cannot exit — verification-stuck, orphaned in-progress — and it is deliberately narrow.",
    },
    {
      kind: "callout",
      tone: "warn",
      title: "Recover, don't replay",
      text: "Never re-run a failed task by resetting database rows. Use `recover` or `transition` so the history shows what happened, or start a new attempt that references the old one.",
    },
  ],
};
