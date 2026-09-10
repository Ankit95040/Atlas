# Atlas V0.1 — Foundation + Core Domain Model

Atlas is an AI Software Engineering Control Plane. V0.1 is a **headless orchestration
engine** built in stages. Milestone 1 laid the project foundation; Milestone 2 added
the **core domain model**; Milestone 3 added the **deterministic Git worktree engine**;
Milestone 4 added the **workspace service**; Milestone 5 added **repository analysis
and resource claims**; Milestone 6 added the **deterministic dependency graph and
claim-aware scheduler**; Milestone 7 added the **AI planner boundary** (untrusted
proposals → deterministic validation → M6 scheduler); Milestone 8 adds the
**controlled worker runtime** (approved task → isolated worktree → provider
execution → Git diff → claim enforcement → structured result; no merging).

## Scope (V0.1 so far)

Included:

- TypeScript Node.js project (strict), managed with pnpm
- Minimal CLI (`atlas --help`, `atlas doctor`) built with Commander
- Configuration validation with Zod
- Prisma + SQLite orchestration-state database (no source code in the DB)
- Core domain model: 13 entities, explicit state machines, deterministic invariants
- Git worktree engine: repository inspection + isolated worktree lifecycle (`src/git/`)
- Workspace service: explicit task→worker assignment with isolated worktrees (`src/workspaces/`)
- Repository analysis + resource claims: structural resource maps and deterministic
  conflict detection (`src/analyzer/`, `src/claims/`)
- Dependency graph + claim-aware scheduler: deterministic execution plans with
  machine-readable reasons (`src/dag/`); cross-feature dependencies allowed
- AI planner boundary: untrusted proposals → deterministic validation → M6
  scheduler (`src/planner/`); providers return data, never authority
- Controlled worker runtime: approved task → isolated worktree → provider
  execution → Git diff → claim enforcement → structured result (`src/workers/`);
  no merging
- Vitest test suite (config, doctor, database, domain inputs/transitions/persistence, git, workspaces, analyzer, claims, dag, planner, workers)

Explicitly NOT included (per AGENTS.md):

- Docker execution, production sandboxing, production AI vendor workers
- Web UI, React, spatial/island UI
- Redis, queues, WebSockets, auth, multi-user
- Semantic merge, live rebase, automatic merge to main, merge train

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
- `src/git/` owns Git truth and never touches Prisma.
- `src/workspaces/` coordinates the two: `assignTaskToWorker` validates,
  creates the worktree, then persists Workspace + links + transitions +
  `TASK_ASSIGNED` event in one Prisma transaction.
- `src/analyzer/` maps a repository to a deterministic resource map pinned to
  a Git commit (tracked files only, via `git ls-files`).
- `src/claims/` models explicit task resource claims (`READ`/`WRITE`),
  normalizes them, and detects conflicts deterministically — the input a
  future scheduler will use to judge parallel safety.
- `src/dag/` answers what could run now: pure `planSchedule` over tasks, edges,
  claims, workers, and concurrency, emitting an `ExecutionPlan`.
- `src/planner/` is the AI boundary: providers return untrusted proposals;
  deterministic validation produces a `ValidatedPlannerPlan` convertible to M6
  scheduler input. The planner never assigns, executes, or touches Git.

## Core domain model (Milestone 2)

Entities (all persisted via Prisma + SQLite, validated via Zod at the boundary):

| Entity | Role |
| ------ | ---- |
| `Project` | Orchestration root; owns repositories and features (`ACTIVE/PAUSED/ARCHIVED`) |
| `Repository` | Source repo pointer: local path, remote URL, default branch |
| `Feature` | Requested change; owns tasks (`DRAFT…COMPLETED/CANCELLED`) |
| `Task` | One executable work unit; priority + JSON resource claims (`path` + `read/write`) |
| `TaskDependency` | Directed edge: `taskId` waits on `dependsOnTaskId`; cross-feature allowed since M6, never self |
| `Worker` | AI worker record; links to one task (`IDLE…COMPLETED/FAILED/STOPPED`) |
| `Workspace` | Isolated workspace record: path/branch; links to one worker |
| `Artifact` | Evidence reference (patch/commit/test/build/analysis report) — metadata only |
| `Contract` | Acceptance contract per task (one-to-one) for future verification |
| `TestRun` | Verification execution (`PENDING→RUNNING→PASSED/FAILED`) with timestamps |
| `Commit` | Git commit metadata known to Atlas (SHA + branch/workspace); history stays in Git |
| `Event` | Append-only orchestration log (create/list only — no update/delete API) |
| `Approval` | Explicit human decision: created `PENDING`, decided once (`APPROVED/REJECTED` + actor + timestamp) |

Key invariants (deterministic, tested): required fields reject empty input;
self-dependencies rejected (cross-feature edges allowed since M6); duplicate edges, contracts,
and per-repo commit SHAs rejected; invalid state transitions rejected
(same-state is an idempotent no-op); approvals need a target and an explicit
decision; commit SHAs must be 7–40 hex chars.

## Git worktree engine (Milestone 3)

**Why worktrees:** every coding worker must receive an isolated Git worktree and
never operate on the main working tree. A worker gone wrong can only dirty its
own worktree; the main checkout stays clean, reviewable, and human-controlled.
Later milestones map `Task → Worker → Workspace → worktree path/branch`.

**What this milestone supports** (`src/git/`, Git CLI only, no new dependencies):

- `runGit(args, { cwd })` — no-shell execution with captured stdout/stderr/exit code
- Inspection: `validateRepository`, `getRepositoryRoot`, `getCurrentBranch`
  (null when detached), `getCurrentCommit`, `getStatus`/`isClean`
  (staged vs unstaged vs untracked)
- Branches: `assertValidBranchName`, `branchExists`, `createBranch`
- Lifecycle: `createWorktree` (`git worktree add -b <branch> <path> <base>`),
  `getWorktrees`/`getWorktree`/`worktreeExists` (parsed from
  `git worktree list --porcelain`), `removeWorktree` (needs `force` when dirty),
  `pruneWorktrees` for stale metadata
- Branch convention: `atlas/worker/<worker-id>/task/<task-id>` (worker-scoped,
  so retries by different workers never collide; ids are cuid-style segments,
  which rules out path traversal)

**Safety rules:** destination must be vacant, outside the repository root, and
never the main worktree (removal refuses main and unknown paths); all commands
use argument arrays, never shell strings. Git is the source of truth — Atlas
re-reads worktree state after every mutation and stores no Git state in Prisma
(the existing `Workspace` model already has `path`/`branch` fields for the
future adapter; no schema change was needed).

## Workspace service (Milestone 4)

**How assignment works:** `assignTaskToWorker({ taskId, workerId, repositoryId,
workspaceRoot, base? })` performs one explicit, manual assignment — there is no
scheduler. It validates existence and relationships (repository must belong to
the task's project), requires task `READY` and worker `IDLE`, derives the
deterministic path `<workspaceRoot>/<projectId>/<workerId>/<taskId>` and the
Git module's branch `atlas/worker/<worker-id>/task/<task-id>`, creates the
worktree, then persists the `Workspace` row, links worker↔task↔workspace,
applies `READY→CLAIMED` / `IDLE→ASSIGNED` / `CREATING→READY` via the existing
transition machinery, and records a `TASK_ASSIGNED` event — all in a single
Prisma transaction. Assignment is not execution: the task stops at `CLAIMED`.

**Partial failures:** Git and SQLite cannot share a transaction, so the
worktree is created first (outside any transaction) and persistence failures
trigger best-effort forced removal of the new worktree. The original error is
preserved on `WorkspaceCreationError.originalError`; a failed cleanup is
reported separately via `cleanupError` instead of replacing it. Git failures
leave no rows behind because persistence never runs.

**Idempotency:** repeating the identical request returns the existing
assignment (`alreadyAssigned: true`) with zero side effects — no new worktree,
row, or event. Conflicting requests (task claimed by another worker, worker
busy, wrong states) are rejected with typed errors.

**Resolved in M6:** cross-feature task dependencies are now allowed and the
claim-aware scheduler plans across the resulting DAG (see below).

## Repository analysis + resource claims (Milestone 5)

**Why claims matter:** Atlas must not decide parallelism from coarse labels
("frontend" vs "backend"). It reasons about actual resources: two tasks
touching disjoint files may run concurrently, while two tasks writing the
same file — no matter how different their descriptions sound — conflict.
This milestone builds that deterministic representation. It does **not**
schedule workers; it only produces the conflict information a scheduler needs.

**Repository analysis** (`src/analyzer/`): `analyzeRepository(repoPath)` lists
Git-tracked files (`git ls-files`; never `.git/`, `node_modules`, or OS
droppings; untracked files are out of scope for V0.1), classifies each into a
small vocabulary (`FILE`, `DIRECTORY`, `CONFIG`, `SCHEMA`, `MIGRATION`,
`PACKAGE_MANIFEST`, `LOCKFILE`, `TEST`, `SOURCE`), adds ancestor directories,
and returns `{ repositoryRoot, analyzedCommit, resources }` sorted
deterministically. Same repo + same commit ⇒ same map.

**Resource claims** (`src/claims/`): callers submit explicit claims
(`createTaskClaims({ taskId, claims: [{ resource, access }] })` — never
LLM-inferred). Paths normalize to canonical repo-relative ids (`./x` →
`x`, backslashes folded, absolute paths/`..`/`.git` rejected); access is
`READ` (shareable) or `WRITE` (exclusive, and may name a file the task will
create — `WRITE` of an absent file is legal, `READ` is not). Claims persist
in the existing `Task.resourceClaims` column (single store, no competing
table) and are deduplicated + sorted, so resubmission is byte-identical.

**Conflicts** (`compareClaimSets`): `READ+READ` shares; any `WRITE` on
overlapping resources conflicts (`WRITE_WRITE`, `READ_WRITE`, `WRITE_READ`).
Overlap is segment-wise hierarchy — `src/auth/` contains `src/auth/login.ts`
but never `src/authentication/login.ts`.

```text
Task A:  WRITE src/auth/login.ts      Task B:  WRITE src/dashboard/page.tsx
→ no resource conflict

Task C:  WRITE prisma/schema.prisma   Task D:  WRITE prisma/schema.prisma
→ CONFLICT (WRITE_WRITE)
```

## Dependency graph + claim-aware scheduler (Milestone 6)

**What it answers:** which tasks are blocked by dependencies, which are ready,
which may run in parallel, which must serialize over conflicting claims, and
how worker availability bounds it all. The output is a machine-readable
`ExecutionPlan` — a decision layer only. Nothing executes, nothing is
assigned; a later runtime will consume plans via the M4 assignment service.

**Graph** (`src/dag/graph.ts`): `TaskGraph` stores directed `dependsOn` edges
with sorted traversals, explicit `NotFoundError`/`InvariantViolationError`
failures, and cycle detection with closed-loop paths (`DependencyCycleError`).
Topological order breaks ties by smallest task id, so plans never depend on
insertion order.

**Scheduler** (`src/dag/scheduler.ts`, pure — no Prisma): `planSchedule` takes
tasks, edges, claims, worker statuses, and `maxConcurrency`, then greedily
packs dependency-ready tasks (`PENDING`/`READY` with every prerequisite
`COMPLETED`) into ordered waves bounded by `min(maxConcurrency, idle workers)`,
keeping each wave claim-conflict-free via the M5 engine. Reasons are explicit:
`PARALLEL_ELIGIBLE`, `BLOCKED_BY_DEPENDENCY` (with the uncompleted ids),
`TASK_NOT_READY` (with the offending status), `WORKER_UNAVAILABLE`, and
`SERIALIZED_RESOURCE_CONFLICT` on the conflicting pairs themselves — a
resource conflict is reported, never converted into a fake `TaskDependency`.

**Loading** (`src/dag/loader.ts`): `loadSchedulerInput` resolves a seed task
set plus its transitive prerequisites (cross-feature included) from Prisma
into the pure input shape. **Cross-feature dependencies are valid as of M6**
(the M2 same-feature restriction is removed; FK integrity is unchanged).

## AI planner boundary (Milestone 7)

**Core principle:** an AI-generated plan is never an authority. It is an
untrusted proposal that must pass deterministic Atlas validation before it
can influence execution. AI proposes → Atlas validates → Atlas schedules →
human approves → workers execute later.

**Contract** (`src/planner/types.ts`): serializable, strict-Zod `PlannerInput`
(feature spec + project/repo context + optional analysis pin + existing tasks)
and `PlannerProposal` (feature id, proposed tasks with claims, proposed
dependencies, optional rationale/metadata). Extra fields rejected; task ids
charset-restricted; dependency endpoints must exist in-proposal.

**Validation** (`src/planner/validator.ts`): `validatePlannerProposal` runs
Zod shape checks, then M5 claim normalization (`InvalidResourceClaimError`
on bad paths/modes), then M6 `TaskGraph` cycle detection
(`DependencyCycleError`), then optionally M5 resource-existence checks
(`WRITE` may name future files, `READ` must match the analysis). Resource
conflicts stay conflicts — they are never rewritten as dependencies.

**Trust boundary** (`src/planner/provider.ts`, `planner.ts`): `PlannerProvider`
returns `unknown`, never authority; `runPlanner` validates input, calls the
provider, validates output — and does nothing else (no assignment,
worktrees, Git, DB writes, or execution). Only `ValidatedPlannerPlan`
(discriminant + normalized contents, constructible solely by validation)
converts via `toSchedulerInput` into M6 input, so the compiler enforces that
raw proposals cannot reach the scheduler. No persistence, no LLM SDK: tests
use `FakePlannerProvider`; a vendor provider can implement the interface
later. Human approval remains required before anything executes.

## Controlled worker runtime (Milestone 8)

**Core principle:** Atlas controls the execution boundary; the AI worker only
implements inside it. `executeTask({ taskId, workerId, expectedBaseCommit },
provider)` runs: approval gate (explicit `APPROVED` decision required) →
state gate → workspace gate (DB record authoritative, main worktree rejected)
→ base-commit gate → atomic slot acquisition (task `CLAIMED→IN_PROGRESS`,
worker `ASSIGNED→RUNNING` in one transaction) → provider executes inside the
assigned worktree → Git diff inspection → claim enforcement → terminal states
+ `WorkerExecutionResult`. No merging; the branch/worktree stays isolated.

**Claim enforcement** (`src/workers/runtime.ts`): actual modifications (from
`git diff`, never provider self-report) must be covered by `WRITE` claims
under M5 segment-overlap semantics — a `WRITE src/auth/` covers
`src/auth/login.ts`, while `WRITE src/auth/login.ts` does not cover
`src/auth/session.ts`. Uncovered paths yield `CLAIM_VIOLATION` (worker and
task `FAILED`, never silently completed).

**Provider boundary** (`src/workers/provider.ts`): `WorkerProvider` returns
`unknown` and receives minimum context only (ids, workspace path, title,
claims, base commit — no secrets, no env). Strict output validation rejects
smuggled fields; provider test self-reports are metadata, never evidence
(no `TestRun` rows are fabricated). Tests use `FakeWorkerProvider`
(confined file ops, optional commit). This is application-level isolation,
not OS/container sandboxing — that hardening is future work.

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
