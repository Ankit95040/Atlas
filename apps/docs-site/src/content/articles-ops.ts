import type { ArticleBlock } from "./article.jsx";

export const OPS_ARTICLES: Record<string, ArticleBlock[]> = {
  "provider-timeout": [
    {
      kind: "intro",
      text: "The provider subprocess exceeded its timeout and was terminated with escalation. This is the most common worker failure and it is fully evidenced.",
    },
    { kind: "h2", id: "happened", text: "What happened" },
    {
      kind: "p",
      text: "The agent did not finish within `--agent-timeout-ms`. Atlas killed the child and its process group (so orphaned grandchildren cannot hold worktrees or locks) and recorded a structured `TIMEOUT` failure with the partial output captured so far.",
    },
    { kind: "h2", id: "guarantees", text: "What Atlas guarantees" },
    {
      kind: "list",
      items: [
        "The task is FAILED with a `TIMEOUT` error code, not silently dropped.",
        "Partial output is preserved in the task evidence.",
        "The workspace is preserved for inspection.",
        "No retry is attempted automatically — ever.",
      ],
    },
    { kind: "h2", id: "not-guaranteed", text: "What Atlas does not guarantee" },
    {
      kind: "p",
      text: "Atlas does not know whether the agent was close to finishing or stuck in a loop. Timeout evidence cannot distinguish progress from thrashing — that judgment is yours.",
    },
    { kind: "h2", id: "inspect", text: "How to inspect the state" },
    {
      kind: "code",
      language: "sh",
      title: "Inspect a timed-out task",
      code: "node ./dist/cli/run.js show task <task-id>\nnode ./dist/cli/run.js history <feature-id>",
    },
    { kind: "h2", id: "recover", text: "Safe recovery procedure" },
    {
      kind: "p",
      text: "Inspect partial work in the preserved workspace. Then either raise `--agent-timeout-ms` and start a new attempt, or split the task into smaller units and replan. Never reset the task row — start a new attempt that references the old one.",
    },
    { kind: "h2", id: "stop", text: "When to stop and intervene manually" },
    {
      kind: "p",
      text: "If timeouts repeat across attempts with no partial progress, the task is likely underspecified or the model is mismatched to it. Stop spending provider budget and re-scope the work.",
    },
  ],
  "provider-failure": [
    {
      kind: "intro",
      text: "Non-zero exits, spawn failures, and output overflows are classified structurally at the spawn boundary — not inferred later from missing output.",
    },
    { kind: "h2", id: "happened", text: "What happened" },
    {
      kind: "list",
      items: [
        "`EXIT_NONZERO` — the agent exited with a code; stderr is captured and bounded.",
        "`SPAWN_FAILED` — the executable could not start (wrong path, permissions).",
        "`OUTPUT_OVERFLOW` — output exceeded the bounded capture; the task fails rather than truncating evidence silently.",
        "`RATE_LIMIT` — provider throttled; Atlas records it distinctly from code failure.",
      ],
    },
    { kind: "h2", id: "guarantees", text: "What Atlas guarantees" },
    {
      kind: "p",
      text: "Failure kind travels alongside the message from the spawn boundary, so later stages never have to infer what happened. A rate limit is never counted as a code failure, and no failure kind triggers an automatic retry.",
    },
    { kind: "h2", id: "inspect", text: "How to inspect the state" },
    {
      kind: "code",
      language: "sh",
      title: "Inspect a failed task",
      code: "node ./dist/cli/run.js show task <task-id>\nnode ./dist/cli/run.js diagnose <feature-id>",
    },
    { kind: "h2", id: "recover", text: "Safe recovery procedure" },
    {
      kind: "p",
      text: "Fix the cause (executable path, task scope, quota wait), then start a new attempt. `diagnose` prints the exact next command for actionable states.",
    },
    { kind: "h2", id: "stop", text: "When to stop and intervene manually" },
    {
      kind: "p",
      text: "Repeated spawn failures point at the environment, not the task. Repeated rate limits point at quota — Atlas will never raise quotas itself.",
    },
  ],
  "claim-violation": [
    {
      kind: "intro",
      text: "The worker modified paths outside its declared WRITE claims. Atlas rejects the work after the fact — this is enforcement working, not a system error.",
    },
    { kind: "h2", id: "happened", text: "What happened" },
    {
      kind: "p",
      text: "Post-execution diff inspection found changed paths not covered by any WRITE claim. The task fails with `CLAIM_VIOLATION` naming the undeclared paths; nothing integrates.",
    },
    { kind: "h2", id: "guarantees", text: "What Atlas guarantees" },
    {
      kind: "p",
      text: "Undeclared modifications never reach the train. The evidence names every offending path, so the fix is always concrete: narrow the task or deliberately widen the claims.",
    },
    { kind: "h2", id: "not-guaranteed", text: "What Atlas does not guarantee" },
    {
      kind: "p",
      text: "Claim enforcement is after the fact, not prevention: the worker already ran. Prevention would require a sandbox, which Atlas explicitly does not provide.",
    },
    { kind: "h2", id: "recover", text: "Safe recovery procedure" },
    {
      kind: "p",
      text: "Decide whether the extra changes were correct-but-undeclared (widen claims, new attempt) or wrong (narrow the task, new attempt). Either way, replan rather than editing rows.",
    },
    { kind: "h2", id: "stop", text: "When to stop and intervene manually" },
    {
      kind: "p",
      text: "Repeated violations from the same task shape mean the decomposition is wrong — the task cannot be scoped to its claims. Redesign the decomposition.",
    },
  ],
  "merge-conflict": [
    {
      kind: "intro",
      text: "Two verified commits genuinely conflict and the train halted instead of merging blindly. This is the integration gate doing its job.",
    },
    { kind: "h2", id: "happened", text: "What happened" },
    {
      kind: "p",
      text: "During ordered integration, a merge produced a conflict. The train status is HALTED with the conflicting item named; integrated items stay integrated, unattempted items stay unattempted. Main is untouched — the conflict exists only on the train branch.",
    },
    { kind: "h2", id: "guarantees", text: "What Atlas guarantees" },
    {
      kind: "p",
      text: "No force-merge, no rebase, no silent conflict resolution. The full pre-halt state (both branches, both diffs, the train worktree) is preserved for inspection.",
    },
    { kind: "h2", id: "inspect", text: "How to inspect the state" },
    {
      kind: "code",
      language: "sh",
      title: "Inspect a halted train",
      code: "node ./dist/cli/run.js show run <feature-id>\nnode ./dist/cli/run.js diagnose <feature-id>",
    },
    { kind: "h2", id: "recover", text: "Safe recovery procedure" },
    {
      kind: "p",
      text: "Resolve the conflict in the train worktree yourself with Git, or replan the overlapping tasks with clearer ownership. Then start a new attempt — never force-push the train branch.",
    },
    { kind: "h2", id: "stop", text: "When to stop and intervene manually" },
    {
      kind: "p",
      text: "You are already intervening manually — that is the procedure. If conflicts recur across runs, the decomposition (not the merge) is the problem.",
    },
  ],
  "verification-failure": [
    {
      kind: "intro",
      text: "Atlas-executed tests failed on the worker's output, or the independent verification step returned REJECTED with reasons. Nothing integrates.",
    },
    { kind: "h2", id: "happened", text: "What happened" },
    {
      kind: "p",
      text: "Either the test run itself failed (exit code, timeout) or the verdict step rejected the work against the persisted evidence. Reasons are recorded verbatim — read them before doing anything.",
    },
    { kind: "h2", id: "guarantees", text: "What Atlas guarantees" },
    {
      kind: "p",
      text: "Rejected work never enters the train, and the reasons persist for fresh readers (the M21 persisted-evidence guarantee). A later `diagnose` shows exactly what the verifier saw.",
    },
    { kind: "h2", id: "recover", text: "Safe recovery procedure" },
    {
      kind: "p",
      text: "Rework the task addressing the recorded reasons (via `task transition` to IN_PROGRESS where allowed), accept the outcome as FAILED, or replan with tighter scope. An empty but valid result becomes `COMPLETED_EMPTY` — terminal and honest, not a failure to fix.",
    },
    { kind: "h2", id: "stop", text: "When to stop and intervene manually" },
    {
      kind: "p",
      text: "If verification rejects repeatedly while the work looks correct to you, suspect the tests or the task scope — not the verifier. Fix the test, not the gate.",
    },
  ],
  "stuck-states": [
    {
      kind: "intro",
      text: "Assignments strand when launchers die; tasks wedge in states the loop cannot exit. Atlas provides two narrow, recorded exits.",
    },
    { kind: "h2", id: "diagnose", text: "How to inspect the state" },
    {
      kind: "code",
      language: "sh",
      title: "Diagnose then exit deliberately",
      code: "node ./dist/cli/run.js diagnose <feature-id>\n\n# Stranded CLAIMED/ASSIGNED pair, nothing ran:\nnode ./dist/cli/run.js recover task <task-id> --actor <your-name>\n\n# VERIFICATION-stuck or orphaned IN_PROGRESS:\nnode ./dist/cli/run.js task transition <task-id> --to FAILED \\\n  --actor <your-name> --reason \"launcher died mid-run; no live worker\"\nnode ./dist/cli/run.js task transition <task-id> --to READY \\\n  --actor <your-name> --reason \"false failure; reschedule\"",
    },
    { kind: "h2", id: "guarantees", text: "What Atlas guarantees" },
    {
      kind: "p",
      text: "Every exit records actor and reason forever (`TASK_RECOVERED`, `TASK_TRANSITIONED`). Unsafe recoveries are refused with truthful errors and zero movement — including the critical refusal to assume a RUNNING worker is dead, since Atlas tracks no process liveness.",
    },
    { kind: "h2", id: "stop", text: "When to stop and intervene manually" },
    {
      kind: "p",
      text: "If the same task strands repeatedly, suspect the launcher environment or the task's resource demands — not the recovery commands. Fix the cause, not the symptom.",
    },
  ],
  "state-database": [
    {
      kind: "intro",
      text: "The SQLite state file is missing, locked, or unreachable. Atlas state problems are diagnosed, never power-washed.",
    },
    { kind: "h2", id: "happened", text: "What happened" },
    {
      kind: "list",
      items: [
        "Missing file: `DATABASE_URL` points somewhere unprovisioned.",
        "Locked: a second launcher or a crashed process holds the lock.",
        "Unreachable: permissions or a moved checkout.",
      ],
    },
    { kind: "h2", id: "guarantees", text: "What Atlas guarantees" },
    {
      kind: "p",
      text: "Atlas never auto-migrates destructively and never creates state silently in ambiguous situations. A missing database is provisioned deliberately (`prisma migrate dev`), never as a side effect.",
    },
    { kind: "h2", id: "inspect", text: "How to inspect the state" },
    {
      kind: "code",
      language: "sh",
      title: "Check configuration and connectivity",
      code: "node ./dist/cli/run.js doctor",
    },
    { kind: "h2", id: "recover", text: "Safe recovery procedure" },
    {
      kind: "p",
      text: "Fix the cause (kill the second launcher, fix permissions, re-provision an intentionally new database), then verify with `doctor`. Never delete a database containing runs you still need.",
    },
    { kind: "h2", id: "stop", text: "When to stop and intervene manually" },
    {
      kind: "p",
      text: "If the database file itself is corrupt, stop: export what you can read, and treat run reconstruction as manual work. Do not improvise schema surgery.",
    },
  ],
};
