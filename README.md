# Atlas V0.1 — Foundation

Atlas is an AI Software Engineering Control Plane. V0.1 is a **headless orchestration
engine** built in stages. This milestone is the **project foundation only**.

## Scope (V0.1 foundation)

Included:

- TypeScript Node.js project (strict), managed with pnpm
- Minimal CLI (`atlas --help`, `atlas doctor`) built with Commander
- Configuration validation with Zod
- Prisma + SQLite orchestration-state database (no source code in the DB)
- Vitest test suite (config, doctor, database)

Explicitly NOT included (per AGENTS.md):

- AI workers, DAG, Git worktrees, Docker worker execution
- Web UI, React, spatial/island UI
- Redis, WebSockets, auth, multi-user
- Semantic merge, live rebase

## Architecture

- **Git** is the source of truth for source code.
- **SQLite (via Prisma)** stores Atlas orchestration state only
  (e.g. `Project` registry). Never store source code in the database.
- `src/` is modular so future systems slot in without rewiring:
  `cli/ config/ core/ db/ git/ workers/ planner/ analyzer/ dag/ verification/`

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
