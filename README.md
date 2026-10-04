# Atlas — Control plane for AI coding agents

Atlas is an **experimental open-source control plane** for orchestrating AI coding workers with
isolation, verification, and human control. Instead of letting agents share one checkout and
self-report success, Atlas decomposes a feature into claimed tasks, runs each worker in its own
Git worktree, verifies the work itself, and integrates results in order — with a human approving
every consequential step.

Repository: <https://github.com/Ankit95040/Atlas>

> **Status: experimental (v0.1).** Atlas is a research prototype, not a production tool.
> There are no customers, no production deployments, and no proven commercial value.
> Benchmark evidence is published with its limitations (see [What is not yet proven](#what-is-not-yet-proven)).

## What Atlas is trying to solve

AI coding agents can write code, but coordinating them is unsafe by default: shared checkouts get
dirty, concurrent edits silently overwrite each other, "it works" is self-reported, and
integration order is accidental. Atlas treats agent coordination as a control problem:

- **Isolation before trust** — one worktree and branch per worker, created outside the repository root.
- **Contracts over labels** — tasks declare the exact paths they may write; anything else fails with evidence.
- **Evidence over self-report** — verification cites the Atlas-executed test run, never the provider's claim.
- **Recoverability by construction** — stuck states exit only through narrow, actor-recorded transitions.
- **Human authority at both boundaries** — plan approval starts execution; merge approval starts integration.

## How the execution model works

1. **Human specification** — a feature description enters the system (`atlas init` creates the project, repository, and feature rows).
2. **Planning** — an untrusted proposal (JSON) is deterministically validated into tasks, resource claims, and dependencies (`atlas plan`). Validation rejects bad shapes, bad claims, and dependency cycles.
3. **Dependency and task boundaries** — a claim-aware scheduler packs dependency-ready tasks into ordered waves; each wave is conflict-free over declared `READ`/`WRITE` resource claims.
4. **Human approval** — execution starts only after an explicit `APPROVED` plan decision, and integration starts only with an explicit merge approval. Both record an actor. There are no silent defaults.
5. **Isolated workers** — each task executes in its own Git worktree on its own branch. The provider runs as an argv-only subprocess with the worktree as `cwd`; it never chooses where it runs.
6. **Verification** — Atlas runs the repository's test command itself and re-derives links, worktree registration, base-commit ancestry, and claim coverage of the observed Git diff. The verdict is `VERIFIED` or `REJECTED` with per-check details.
7. **Ordered merge train** — verified items merge in order onto a dedicated train branch. Conflicts halt loudly with the item named; tests re-run cumulatively.
8. **Human-controlled final integration** — Atlas never merges `main`. The train branch waits; a human merges.

Supporting operations: `atlas status` / `show` / `history` / `claims` / `diagnose` are read-only
inspection; `atlas recover task` releases stranded assignments and `atlas task transition` moves
stuck tasks along one allowed edge — both require an actor and a reason.

## Current capabilities

- Strict TypeScript engine (Node.js ≥ 20) with Zod-validated boundaries and Prisma + SQLite orchestration state (lifecycle and metadata only — never source code).
- Git worktree lifecycle engine (Git CLI, argument arrays, no shell strings).
- Deterministic repository analysis, resource-claim conflict detection, and claim-aware scheduling.
- Untrusted-proposal planner boundary with deterministic validation.
- Controlled worker runtime with Git-diff claim enforcement (`CLAIM_VIOLATION` on undeclared writes).
- Atlas-executed verification and approval-gated ordered merge train.
- Real subprocess worker provider (`CommandWorkerProvider`) plus a scriptable test agent.
- Reproducible benchmark harnesses (synthetic strategies, real-agent comparisons, scale workloads) with machine-readable provenance.
- Read-only execution API + Server-Side Rendered dashboard and React projection UI (see monorepo notes).
- Documentation and research website (`apps/docs-site/`) with the full experiment archive.

## What is not yet proven

- **Product-market fit is unproven.** There are no users beyond the authors and no production evidence.
- **Automatic execution routing is disabled.** Routing analysis is advisory only; a human approves every run.
- **Isolation is process/worktree-level, not sandboxed.** A hostile worker process could touch the wider filesystem; Docker/microVM sandboxing is future work.
- **Semantic correctness is not automatically measured.** Verification proves tests pass and claims hold, not that the code is right.
- **Real-provider experiments hit stalls and inconsistent availability** (documented in the M28–M29 reports).

## Honest benchmark limitations

The full record lives in `docs/reports/` and the research archive on the documentation site.
The headline facts, with sample sizes stated beside every claim:

- **Single-agent execution was faster in every measured comparison** (e.g. M29.0: independent tasks ~30s vs ~37s; migration chains ~38s vs ~107s; n=5 per cell, one free model, synthetic fixtures).
- Atlas reached **verified-success parity** with single-agent workflows on tested fixtures — not superiority.
- Shared-file runs that genuinely conflict **correctly halted (0/5)** — halts are the train working as designed, not failures.
- We have **not established** whether conflict prevention and auditability justify the added complexity (see `docs/reports/M29.6-PRODUCT-VALUE-AUDIT.md`).
- Quarantined, inconclusive, and negative results are published alongside positive ones. Do not cite Atlas numbers as productivity claims.

## Installation and setup

Prerequisites: Node.js ≥ 20, pnpm (`npm install -g pnpm`), Git. `atlas doctor` also checks Docker.

```sh
cp .env.example .env
pnpm install
pnpm db:migrate
pnpm build
```

| Script             | Purpose                           |
| ------------------ | --------------------------------- |
| `pnpm build`       | Compile TypeScript to `dist/`     |
| `pnpm typecheck`   | Strict typecheck (`tsc --noEmit`) |
| `pnpm test`        | Run the Vitest suite              |
| `pnpm atlas`       | Run the built CLI                 |
| `pnpm doctor`      | Run `atlas doctor`                |
| `pnpm db:generate` | Generate the Prisma client        |
| `pnpm db:migrate`  | Apply database migrations (dev)   |

`atlas doctor` checks Node.js (≥ 20), Git, Docker, Atlas configuration, and database connectivity.

## CLI quick start

```sh
# One-time: create the project, repository, and feature rows for a Git checkout.
pnpm atlas -- init --name <project> --repo-path <git-checkout> --feature-title <title>

# Validate a proposal file into tasks (persists nothing executable yet).
pnpm atlas -- plan --feature <featureId> --proposal proposal.json

# Approve the plan (records you as the actor), then execute with an explicit worker.
pnpm atlas -- plan --feature <featureId> --proposal proposal.json --approve --actor <name>
pnpm atlas -- run --feature <featureId> --repository <repoId> \
  --plan-approval <approvalId> --actor <name> \
  --agent <executable> [--agent-arg <arg> ...] --approve-merge

# Inspect (all read-only):
pnpm atlas -- status <featureId>
pnpm atlas -- show run <runId>
pnpm atlas -- history <featureId>
pnpm atlas -- claims <featureId>
pnpm atlas -- diagnose <featureId>

# Recover (both record actor + reason):
pnpm atlas -- recover task <taskId> --actor <name>
pnpm atlas -- task transition <taskId> --to <status> --actor <name> --reason <text>
```

`atlas run` exits non-zero unless the run is fully verified and integrated; `--json` prints
machine-readable results. New here? Start with `docs/GETTING_STARTED.md`, and keep
`docs/RECOVERY_RUNBOOK.md` nearby when operating real runs.

## Monorepo structure

```text
src/              Atlas engine: cli, config, core, db, git, workspaces,
                  analyzer, claims, dag, planner, workers, verification,
                  orchestrator, benchmark, triage, ui
prisma/           SQLite schema + migrations (orchestration state only)
tests/            Vitest suite (unit + integration; real-provider tests need approval to run)
fixtures/         Test fixtures (see note below)
docs/             Getting-started guide, recovery runbook, design notes,
                  experiment designs, research reports
apps/docs-site/   Documentation + research website (React + Vite; publishes the
                  guides and the full experiment archive)
apps/web/         Experimental projection UI — deferred from this release
                  pending independent review of its in-progress migration.
                  `apps/web` contains an experimental M26 frontend proof of concept
                  and is not a production-ready application.
```

**Fixture note:** `fixtures/m18/scale/` holds vendored upstream sources used only as scale-benchmark
inputs (mocha, node-semver, postcss, showdown — each retains its own `LICENSE`, all MIT/ISC upstream
terms). These trees are **excluded from the public release snapshot**; to reproduce the scale
workloads locally, check out the pinned upstream tags recorded in `src/benchmark/scale/workloads.ts`
into `fixtures/m18/scale/<name>-<version>/`.

## Documentation website development

```sh
pnpm --filter @atlas/docs-site install   # first time (or pnpm install at root)
pnpm --filter @atlas/docs-site typecheck
pnpm --filter @atlas/docs-site test
pnpm --filter @atlas/docs-site build
pnpm --filter @atlas/docs-site preview   # serve the production build locally
```

The site uses hash routing, persists Dark/Light/System theme choice without a flash of the wrong
theme, and links to the GitHub repository and issue tracker. The contact email is intentionally
unconfigured — GitHub Issues is the primary contact route until a real address is supplied in
`apps/docs-site/src/content/site.ts`.

## Contributing

Atlas is experimental open source and the most valuable contributions preserve its honesty
guarantees: falsifiable experiments, tighter verification, and independent audits of the benchmark
claims. Good starting points: reproducing an experiment from `docs/reports/`, challenging a
benchmark assumption, improving worker isolation or recovery, or improving the documentation.

1. Open an issue at <https://github.com/Ankit95040/Atlas/issues> describing the change.
2. Keep the safety invariants: human approval stays mandatory, Git stays the source of truth,
   workers stay isolated, `main` is never auto-merged.
3. Add or update tests for behavior changes; run `pnpm typecheck` and the affected suites.
4. Do not include secrets, local paths, database files, or generated output in contributions.

## Security reporting

Atlas executes AI-directed code via subprocess workers. If you find a vulnerability — especially
workspace escape, claim-enforcement bypass, approval forgery, or secret forwarding to providers —
please report it privately via <https://github.com/Ankit95040/Atlas/issues> (a private channel
will be documented once triage is staffed) rather than opening a public exploit. Do not probe
systems you do not own. There is currently no paid bounty program.

## License

MIT — see [LICENSE](./LICENSE). The MIT license covers Atlas-authored project code; vendored
third-party components (excluded from the release snapshot) and `node_modules` dependencies
remain under their own upstream licenses.
