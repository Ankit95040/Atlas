# Atlas V0.1 — Foundation + Core Domain Model

Atlas is an AI Software Engineering Control Plane. V0.1 is a **headless orchestration
engine** built in stages. Milestone 1 laid the project foundation; Milestone 2 adds
the **core domain model and its persistence/validation layer**. No orchestration yet.

## Scope (V0.1 so far)

Included:

- TypeScript Node.js project (strict), managed with pnpm
- Minimal CLI (`atlas --help`, `atlas doctor`) built with Commander
- Configuration validation with Zod
- Prisma + SQLite orchestration-state database (no source code in the DB)
- Core domain model: 13 entities, explicit state machines, deterministic invariants
- Vitest test suite (config, doctor, database, domain inputs/transitions/persistence)

Explicitly NOT included (per AGENTS.md):

- Orchestration, scheduling, worker execution, Docker worktrees
- AI workers, DAG execution, Git worktree management
- Web UI, React, spatial/island UI
- Redis, queues, WebSockets, auth, multi-user
- Semantic merge, live rebase

## Architecture

- **Git** is the source of truth for source code.
- **SQLite (via Prisma)** stores Atlas orchestration state only
  (lifecycle, assignments, metadata, references, append-only events).
  Never store source code in the database: no blobs, no file contents,
  no histories — only paths, SHAs, URIs, and hashes.
- `src/` is modular so future systems slot in without rewiring:
  `cli/ config/ core/ db/ git/ workers/ planner/ analyzer/ dag/ verification/`
- `src/core/` is the domain layer: `enums` (lifecycle vocabulary),
  `inputs` (Zod boundary DTOs), `validation` (deterministic invariants),
  `transitions` (explicit state machines), `errors` (domain errors),
  `service` (minimal create/transition/record operations).

## Core domain model (Milestone 2)

Entities (all persisted via Prisma + SQLite, validated via Zod at the boundary):

| Entity | Role |
| ------ | ---- |
| `Project` | Orchestration root; owns repositories and features (`ACTIVE/PAUSED/ARCHIVED`) |
| `Repository` | Source repo pointer: local path, remote URL, default branch |
| `Feature` | Requested change; owns tasks (`DRAFT…COMPLETED/CANCELLED`) |
| `Task` | One executable work unit; priority + JSON resource claims (`path` + `read/write`) |
| `TaskDependency` | Directed edge: `taskId` waits on `dependsOnTaskId`; same feature only, never self |
| `Worker` | AI worker record; links to one task (`IDLE…COMPLETED/FAILED/STOPPED`) |
| `Workspace` | Isolated workspace record: path/branch; links to one worker |
| `Artifact` | Evidence reference (patch/commit/test/build/analysis report) — metadata only |
| `Contract` | Acceptance contract per task (one-to-one) for future verification |
| `TestRun` | Verification execution (`PENDING→RUNNING→PASSED/FAILED`) with timestamps |
| `Commit` | Git commit metadata known to Atlas (SHA + branch/workspace); history stays in Git |
| `Event` | Append-only orchestration log (create/list only — no update/delete API) |
| `Approval` | Explicit human decision: created `PENDING`, decided once (`APPROVED/REJECTED` + actor + timestamp) |

Key invariants (deterministic, tested): required fields reject empty input;
self-dependencies and cross-feature edges rejected; duplicate edges, contracts,
and per-repo commit SHAs rejected; invalid state transitions rejected
(same-state is an idempotent no-op); approvals need a target and an explicit
decision; commit SHAs must be 7–40 hex chars.

## Prerequisites

- Node.js >= 20
- pnpm (`npm install -g pnpm`)
- Git
- Docker (checked by `atlas doctor`; daemon does not need to run workers yet)

## Setup

```sh
cp .env.example .env
pnpm install
pnpm db:migrate
pnpm build
```

## Usage

```sh
pnpm atlas -- --help
pnpm atlas -- doctor
# after `pnpm build`, the local bin also works:
./node_modules/.bin/atlas --help
./node_modules/.bin/atlas doctor
```

`atlas doctor` checks:

1. Node.js availability (>= v20)
2. Git availability (`git --version`)
3. Docker availability (`docker --version`)
4. Atlas configuration (Zod-validated env)
5. SQLite/Prisma database connectivity (`SELECT 1`)

## Scripts

| Script            | Purpose                              |
| ----------------- | ------------------------------------ |
| `pnpm build`      | Compile TypeScript to `dist/`        |
| `pnpm typecheck`  | Strict typecheck (`tsc --noEmit`)    |
| `pnpm test`       | Run Vitest suite                     |
| `pnpm atlas`      | Run the built CLI                    |
| `pnpm db:generate`| Generate Prisma client               |
| `pnpm db:migrate` | Apply database migrations (dev)      |

## Dependencies — why each exists

| Package           | Reason required (V0.1)                              |
| ----------------- | --------------------------------------------------- |
| `commander`       | Minimal CLI framework for `atlas --help` / `doctor` |
| `zod`             | Deterministic configuration validation              |
| `@prisma/client`  | Type-safe access to SQLite orchestration state      |
| `dotenv`          | Load `DATABASE_URL` from `.env` into CLI/tests      |
| `prisma` (dev)    | Schema management + migrations + client generation  |
| `typescript` (dev)| Strict typechecking + build                         |
| `vitest` (dev)    | Test runner for config/doctor/db                    |
| `@types/node` (dev)| Node.js type definitions                           |

No other runtime dependencies are added in this milestone.
