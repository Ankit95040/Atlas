# Atlas V0.1 — Getting Started

From a clean machine to your first orchestrated feature. Every command below
is current CLI surface; append `--json` to any command for machine-readable
output.

## 1. Prerequisites

- Node.js ≥ 20 and `pnpm`
- Git (with a configured identity — workers commit in isolated worktrees)
- A coding-agent CLI for real execution, e.g. `opencode`, already
  authenticated (Atlas forwards your ambient credentials; it never stores
  provider secrets). Check the model label you want to record.

## 2. Install and configure

```sh
pnpm install
cp .env.example .env   # then set DATABASE_URL (default: file:./dev.db)
npx prisma migrate dev
npx prisma generate
npm run build
node ./dist/cli/run.js doctor
```

`doctor` checks Node, Git, Docker (informational only — Docker is not used
for isolation), Atlas configuration, and database connectivity. Fix anything
it reports before continuing.

## 3. Register your repository (`init`)

Atlas orchestrates a Git checkout it does not own — bring your own repo.
`init` validates the path is a Git checkout, then creates the three rows
every run needs: project, repository, and first feature.

```sh
node ./dist/cli/run.js init \
  --name "my-project" \
  --repo-path /path/to/your/checkout \
  --feature-title "first feature"
```

It prints `project:`, `repository:`, and `feature:` IDs plus the exact next
command. Keep the feature ID — everything else keys off it.

## 4. Write a proposal

A proposal is an untrusted JSON plan: tasks with resource claims
(filesystem paths + `read`/`write`) and dependencies. Atlas validates it
deterministically and rejects anything malformed without writing.

```json
{
  "featureId": "<feature-id-from-init>",
  "tasks": [
    {
      "id": "t1",
      "title": "Add input validation",
      "claims": [{ "resource": "src/validate.ts", "access": "WRITE" }]
    },
    {
      "id": "t2",
      "title": "Cover validation with tests",
      "claims": [{ "resource": "test/validate.test.ts", "access": "WRITE" }]
    }
  ],
  "dependencies": [{ "taskId": "t2", "dependsOnTaskId": "t1" }]
}
```

Rules: at least one task, unique task ids, no self-dependencies, no unknown
task references, claims are paths (never file contents). Keep claims tight —
workers may only touch claimed paths; anything else is rejected after the
fact.

## 5. Plan, approve, run

Preview the schedule (never executes):

```sh
node ./dist/cli/run.js plan --feature <feature-id> --proposal proposal.json
```

Approve the plan in the same step when you are satisfied (actor is
mandatory — a human owns every decision):

```sh
node ./dist/cli/run.js plan --feature <feature-id> --proposal proposal.json \
  --approve --actor <your-name>
```

Note the `APPROVED` plan approval ID, then execute (both approvals required;
Atlas never merges into `main` — verified work lands on a train branch you
merge yourself):

```sh
node ./dist/cli/run.js run \
  --feature <feature-id> \
  --repository <repository-id> \
  --plan-approval <approval-id> \
  --actor <your-name> \
  --agent opencode --agent-arg run --agent-arg --agent --agent-arg build \
  --approve-merge
```

Tune with `--max-concurrency`, `--agent-timeout-ms`, `--agent-env`,
`--test-command`/`--test-arg`, `--train-branch`, `--workspace-root`.
Exit codes: `0` success, `1` completed with failures, `2` blocked.

## 6. Observe

```sh
node ./dist/cli/run.js status <feature-id>          # overview + visible failures
node ./dist/cli/run.js show run <feature-id>        # tasks, timing, failures
node ./dist/cli/run.js show task <task-id>          # evidence for one task
node ./dist/cli/run.js history <feature-id>         # chronological events
node ./dist/cli/run.js claims <feature-id>          # claims + overlaps
node ./dist/cli/run.js diagnose <feature-id>        # failure analysis + next steps
```

## 7. When something fails

See `RECOVERY_RUNBOOK.md`. Short version: `diagnose` names the phase and —
for recoverable cases — prints the exact next command. Never edit the
database by hand; the CLI covers every supported transition.

## What Atlas does not do (V0.1)

No filesystem or network sandboxing (workers run as subprocesses; safety is
claim enforcement after the fact, not prevention). No retries, no model
fallback, no cost tracking, no multi-user access control, no automatic merge
to `main`. Single operator per database.
