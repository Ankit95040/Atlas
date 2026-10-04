import type { ArticleBlock } from "./article.jsx";

export const CLI_ARTICLES: Record<string, ArticleBlock[]> = {
  doctor: [
    {
      kind: "intro",
      text: "Checks the runtime environment and Atlas configuration: Node.js, Git, Docker (informational), configuration validity, and database connectivity. Run it before anything else and after any environment change.",
    },
    { kind: "code", language: "sh", title: "Syntax", code: "node ./dist/cli/run.js doctor" },
    {
      kind: "p",
      text: "Exit code is zero when every check passes and non-zero otherwise, with each check reported by name. Docker failures are informational — Docker is not used for isolation.",
    },
  ],
  init: [
    {
      kind: "intro",
      text: "Registers a project, repository, and first feature for a Git checkout. This is always the first step before `plan` — every run needs these three rows.",
    },
    {
      kind: "code",
      language: "sh",
      title: "Syntax",
      code: 'node ./dist/cli/run.js init \\\n  --name <name> \\\n  --repo-path <path> \\\n  --feature-title <title> \\\n  [--description <text>] [--feature-description <text>]\n  [--remote-url <url>] [--default-branch <branch>]\n  [--state-dir <dir>] [--json]',
    },
    {
      kind: "table",
      head: ["Option", "Required", "Meaning"],
      rows: [
        ["`--name`", "Yes", "Project name."],
        ["`--repo-path`", "Yes", "Path to the Git checkout Atlas will orchestrate; validated before any write."],
        ["`--feature-title`", "Yes", "Title of the first feature."],
        ["`--description`, `--feature-description`", "No", "Free-text context stored on the rows."],
        ["`--remote-url`, `--default-branch`", "No", "Repository metadata."],
        ["`--state-dir`", "No", "Explicit per-project state directory (`<dir>/atlas.db` must already be provisioned)."],
        ["`--json`", "No", "Machine-readable output."],
      ],
    },
    {
      kind: "p",
      text: "Output prints `project:`, `repository:`, and `feature:` IDs plus the exact next command. `init` writes no local config and performs no repository discovery — it records what you tell it.",
    },
  ],
  plan: [
    {
      kind: "intro",
      text: "Validates a proposal file, persists its tasks, and previews the schedule. Planning never executes anything.",
    },
    {
      kind: "code",
      language: "sh",
      title: "Syntax",
      code: "node ./dist/cli/run.js plan \\\n  --feature <id> \\\n  --proposal <file> \\\n  [--approve --actor <name>] [--max-concurrency <n>] [--json]",
    },
    {
      kind: "table",
      head: ["Option", "Required", "Meaning"],
      rows: [
        ["`--feature`", "Yes", "Feature ID the proposal applies to."],
        ["`--proposal`", "Yes", "Path to the untrusted proposal JSON file."],
        ["`--approve` + `--actor`", "No", "Decide the plan approval APPROVED in this invocation; `--actor` is mandatory with `--approve`."],
        ["`--max-concurrency`", "No", "Width used for the schedule preview (default 4)."],
        ["`--json`", "No", "Machine-readable output."],
      ],
    },
    {
      kind: "p",
      text: "The preview shows waves, resource conflicts, and blocked tasks computed with hypothetical workers — display only. Re-running with the same file re-displays the existing approval instead of duplicating it. A routing recommendation (SINGLE_AGENT, ORCHESTRATED, or REQUIRES_REVIEW) is printed for human review; it is advisory only.",
    },
  ],
  run: [
    {
      kind: "intro",
      text: "Executes an approved plan through the wave loop: schedule, assign, execute, test, verify, integrate. Requires both a plan approval and explicit merge approval.",
    },
    {
      kind: "code",
      language: "sh",
      title: "Syntax",
      code: "node ./dist/cli/run.js run \\\n  --feature <id> \\\n  --repository <id> \\\n  --plan-approval <id> \\\n  --actor <name> \\\n  --agent <executable> [--agent-arg <arg> ...] \\\n  [--agent-timeout-ms <ms>] [--agent-env <name> ...] \\\n  --approve-merge \\\n  [--base <sha>] [--max-concurrency <n>] [--test-command <exe> [--test-arg <arg> ...]]\n  [--train-branch <branch>] [--train-path <path>] [--workspace-root <path>] [--json]",
    },
    {
      kind: "table",
      head: ["Option", "Required", "Meaning"],
      rows: [
        ["`--feature`, `--repository`", "Yes", "What to execute and where the working tree lives."],
        ["`--plan-approval`", "Yes", "APPROVED plan approval ID for this feature."],
        ["`--actor`", "Yes", "Human author recorded on approval decisions."],
        ["`--agent`", "Yes", "Worker executable, argv-only, no shell."],
        ["`--agent-arg`", "No", "Repeatable argument appended to the worker argv."],
        ["`--agent-timeout-ms`", "No", "Worker subprocess timeout."],
        ["`--agent-env`", "No", "Repeatable host env var name forwarded to workers."],
        ["`--approve-merge`", "Yes*", "Explicit merge approval. *Required to execute at all."],
        ["`--base`", "No", "Base commit (defaults to repository HEAD)."],
        ["`--max-concurrency`", "No", "Wave width bound (default 4)."],
        ["`--test-command` / `--test-arg`", "No", "Explicit test executable (defaults to package.json scripts.test)."],
        ["`--train-branch` / `--train-path`", "No", "Integration branch (under atlas/cli/) and train worktree destination (under .atlas/)."],
        ["`--workspace-root`", "No", "Worker workspace root (under .atlas/). Guarded: a silent default inside the Atlas checkout is refused."],
        ["`--json`", "No", "Machine-readable output, including the timing block."],
      ],
    },
    {
      kind: "p",
      text: "Output ends with a timing line (total, scheduling, assign, worker, tests, verify, train) plus an explicit list of any measurements that did not run. Exit codes: `0` success, `1` completed with failures, `2` blocked.",
    },
  ],
  "task-transition": [
    {
      kind: "intro",
      text: "Moves a stuck task along exactly one allowed state-machine edge. The narrow escape hatch for states the normal loop cannot exit.",
    },
    {
      kind: "code",
      language: "sh",
      title: "Syntax",
      code: "node ./dist/cli/run.js task transition <task-id> \\\n  --to <status> --actor <name> --reason <text> [--json]",
    },
    {
      kind: "p",
      text: "The target must be a directly reachable edge — arbitrary jumps are rejected. The actor and reason are recorded on a `TASK_TRANSITIONED` event, visible in history forever.",
    },
  ],
  recover: [
    {
      kind: "intro",
      text: "Releases a stranded CLAIMED or ASSIGNED task so it becomes schedulable again. Explicit human confirmation only.",
    },
    {
      kind: "code",
      language: "sh",
      title: "Syntax",
      code: "node ./dist/cli/run.js recover task <task-id> --actor <name> [--json]",
    },
    {
      kind: "p",
      text: "Recovery refuses unsafe cases (for example, tasks with terminal evidence or tasks that are already schedulable) with truthful errors and zero movement. A `TASK_RECOVERED` event records previous and resulting states.",
    },
  ],
  inspect: [
    {
      kind: "intro",
      text: "Seven read-only paths cover every inspection need. All accept `--json`; none can modify state.",
    },
    {
      kind: "table",
      head: ["Command", "Shows"],
      rows: [
        ["`status <feature-id>`", "Task/worker states, recent events, visible failures."],
        ["`show run <run-id>`", "Tasks, workers, integration, timing, failures for a run scope."],
        ["`show task <task-id>`", "Status, dependencies, claims, assignment, evidence, timing."],
        ["`show worker <worker-id>`", "Assignment, workspace, execution, failures, timing."],
        ["`history <run-id>`", "Chronological event history."],
        ["`claims <run-id>`", "Task/resource claims with pairwise overlaps."],
        ["`diagnose <run-id>`", "Failure analysis from persisted evidence, with next steps for recoverable cases."],
      ],
    },
  ],
};
