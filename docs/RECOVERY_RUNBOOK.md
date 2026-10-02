# Atlas V0.1 — Recovery Runbook

How to read a failure and what to do about it. Principle: Atlas records
evidence, the human decides. Every transition below is one allowed
state-machine edge with your actor and reason recorded on a
`TASK_TRANSITIONED` event — visible in `history` forever.

## 1. Start with diagnose

```sh
node ./dist/cli/run.js diagnose <feature-id>
```

Each finding names the task, its status, the failing **phase**
(worker execution / testing / verification / integration / empty-outcome),
the persisted evidence (error codes, test exits, verification reasons), a
**recovery** classification, and — for actionable states — the exact
**next** command plus an **operator** hint for stuck states.

## 2. Case table

| Symptom | Phase | What happened | Command |
|---|---|---|---|
| `SAFE_TO_RECOVER` finding | assignment | Launcher died between claim and execution; task CLAIMED, worker ASSIGNED, nothing ran | `recover task <id> --actor <you>` |
| Provider error (`TIMEOUT`, `SPAWN_FAILED`, `EXIT_NONZERO`, `OUTPUT_OVERFLOW`) | worker execution | Agent failed; evidence persisted on the task | Inspect, then re-plan or start a new attempt |
| `RATE_LIMIT` | worker execution | Provider throttled; nothing ran | Wait, then start a new attempt (Atlas never auto-retries) |
| Test run FAILED | testing | Atlas-executed tests failed on worker output | Fix scope, new attempt |
| REJECTED verdict, task in VERIFICATION | verification | Work did not verify; reasons in the finding | Rework or accept (below) |
| Train HALTED + triage artifact | integration | Conflicting branches; work preserved | Resolve in the train worktree, new attempt |
| `COMPLETED_EMPTY` | empty-outcome | Valid run, no contribution | Replan with tighter scope |
| Task IN_PROGRESS, no live worker | orphaned execution | Launcher died mid-run | Two-hop exit (below) |

## 3. Releasing stranded assignments

Only CLAIMED-task + ASSIGNED-worker pairs qualify. Anything else is refused
with the reason — including live RUNNING workers (Atlas tracks no process
liveness, so it never assumes a worker is dead).

```sh
node ./dist/cli/run.js recover task <task-id> --actor <your-name>
```

Result: task → READY (schedulable), worker → IDLE (unlinked), workspace
preserved for inspection.

## 4. Exiting stuck states (`task transition`)

For tasks `recover` refuses: VERIFICATION-stuck after a REJECTED verdict,
and orphaned IN_PROGRESS with no live worker. One allowed edge per
invocation; `--actor` and `--reason` are mandatory and recorded.

```sh
# Rejected work that deserves rework:
node ./dist/cli/run.js task transition <task-id> --to IN_PROGRESS \
  --actor <your-name> --reason "address verification notes, retry"

# Rejected work you accept as failed:
node ./dist/cli/run.js task transition <task-id> --to FAILED \
  --actor <your-name> --reason "approach unsound; will replan"

# Orphaned IN_PROGRESS (launcher died, no RUNNING worker linked):
# hop 1 records the false execution as failed...
node ./dist/cli/run.js task transition <task-id> --to FAILED \
  --actor <your-name> --reason "launcher died mid-run; no live worker"
# ...hop 2 makes it schedulable again:
node ./dist/cli/run.js task transition <task-id> --to READY \
  --actor <your-name> --reason "false failure; reschedule"
```

Refusals you should expect (all by design): terminal states
(COMPLETED/COMPLETED_EMPTY/FAILED/CANCELLED) never transition — start a new
attempt instead; unreachable targets (e.g. IN_PROGRESS → READY) are rejected
by the state machine; anything linked to a live RUNNING worker is refused —
inspect the worktree first, then decide.

## 5. Verifying the recovery

```sh
node ./dist/cli/run.js show task <task-id>     # status, evidence, timing
node ./dist/cli/run.js history <feature-id>    # TASK_RECOVERED / TASK_TRANSITIONED with actor + reason
node ./dist/cli/run.js run ...                 # re-execute; scheduler picks up READY work
```

## 6. Never do this

- Never edit `dev.db` (or any Atlas database) by hand. Every supported
  transition has a command above; hand edits bypass validation and history.
- Never run two launchers against the same database concurrently.
- Never assume a RUNNING worker is dead. No liveness inference exists
  anywhere in Atlas — that refusal is the safety feature working.
- Never delete workspaces, train branches, or scratch dirs for live or
  claimed work. They are the evidence trail; only terminal-state leftovers
  are safe to clean, and only when you no longer need them.
