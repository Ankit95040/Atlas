# M18: Scale/Crossover Validation — Experiment Design

**Status:** DESIGN (frozen Atlas V0.2 at tag `v0.2-m17`; no source changes permitted during M18).
**Parent findings:** M17 (180 runs) — SINGLE_AGENT 55/60 (91.7%), ATLAS_EVOLVING 51/60 (85.0%),
difference not significant (p≈0.26); AE median latency +40% vs SA; 0 AE integration conflicts;
AE failures dominated by worker (agent) failures, not orchestration failures.

---

## 0. Research question

**At what software-feature complexity does Atlas-Evolving become more useful than SINGLE_AGENT?**

- **Primary hypothesis (H1):** As feature complexity increases, SINGLE_AGENT reliability
  degrades faster than ATLAS_EVOLVING, because Atlas distributes context and implementation
  work across isolated workers while the single agent's growing context degrades its output.
  I.e., there exists a crossover complexity above which AE ≥ SA on reliability at
  acceptable latency cost.
- **Alternative hypothesis (H0, the steelman):** A sufficiently strong single agent remains
  faster and at least as reliable as Atlas-Evolving at every tested complexity level.
  No crossover exists within the tested range; orchestration overhead never pays for itself.

M18 must be capable of confirming H0. A design that can only validate Atlas is rejected.

---

## 1. Exact experiment matrix

### 1.1 Arms (2)

| Arm | Description |
|---|---|
| SINGLE_AGENT | One worker, union prompt, union claims — identical construction to M17 (`runRealSingleAgent`) |
| ATLAS_EVOLVING | Claim-aware wave scheduling + evolving-base merge train — identical construction to M17 (`runRealAtlasEvolving`) |

**DUMB_PARALLEL is excluded.** It answers no new scientific question here: M17 established it
halts deterministically on any shared-file workload (0/10 on all four), and that result is
structural (same-base branches + unordered train), not complexity-dependent. Re-running it at
larger scale would spend agent budget re-proving a settled point. If a future milestone needs
a "scheduling vs. evolving-base" ablation, that is a new arm (ATLAS fixed-base), not DUMB_PARALLEL.

### 1.2 Complexity levels (4) × repeats

| Level | Tasks | Repeats per arm | Runs per level | Total |
|---|---|---|---|---|
| Small | 2–4 | 8 | 2 × 8 = 16 | 16 |
| Medium | 5–8 | 8 | 2 × 8 = 16 | 16 |
| Large | 8–15 | 6 | 2 × 6 = 12 | 12 |
| XL | 15–25 | 6 | 2 × 6 = 12 | 12 |
| **Total** | | | | **56 runs** |

Repeats taper at Large/XL because per-run cost (agent time × waves) grows superlinearly;
56 runs keeps the budget comparable to one M17 workload-pair while buying the complexity axis.
Minimum 6/arm/level preserves a usable (if wide) Wilson interval per cell.

### 1.3 Per-level definitions

| Dimension | Small (2–4) | Medium (5–8) | Large (8–15) | XL (15–25) |
|---|---|---|---|---|
| **Task characteristics** | Single-function additions or single-key edits; each task touches 1 file; ≥80% of tasks independently testable in isolation | Multi-function modules; tasks touch 1–3 files; ~50% independently testable; some tasks require reading another task's output (via DI/parameters, never cross-worktree imports) | Cross-module changes; tasks touch 2–5 files; minority independently testable; at least one task requires integrating two sibling outputs | Feature-scale change; tasks span subsystems; most tasks meaningful only against siblings' outputs; includes at least one refactor-then-extend chain |
| **Dependency density** (edges/tasks) | 0–0.25 (mostly independent; at most one chain of length 2) | 0.25–0.5 (≥2 chains, max length 3) | 0.4–0.7 (chains of length 3–4; at least one diamond) | 0.5–0.8 (chains of length ≥4; multiple diamonds; ≥1 task with 3+ prerequisites) |
| **Claim overlap** | Disjoint files except ≤1 shared-file pair with disjoint lines | ≥2 shared-file pairs (disjoint lines); ≤1 same-line contention pair | ≥1 same-file multi-line contention region; ≥3 shared-file pairs | Contention regions in ≥2 files; at least one file written by ≥3 tasks |
| **Expected parallelism** (scheduler wave width) | Full width (1 wave typical) | 2–4 wide, 2–3 waves | 2–5 wide, 3–5 waves | 3–6 wide, 4–8 waves |
| **Repository requirements** | Fresh fixture repo, ≤10 files, single `node --test` suite | Fresh fixture repo, 10–30 files, suite split into ≥2 files | Real-repo-derived fixture (see §2) or large synthetic repo (50+ files); suite with unit + integration files | Real-repo-derived fixture only; full test command of the donor project scoped to the feature |
| **Success criteria** | M17 predicate **plus** §6 (survival-gated) | Same | Same | Same |

Small exists to anchor the M17 regime (expect SA ≥ AE, replicating M17). The crossover, if it
exists, is hypothesized between Medium and Large.

---

## 2. Dataset / repository selection criteria

Two strata, decided per level by §1.3:

**Stratum A — synthetic fixtures (Small, Medium).** Built exactly like M17 workloads
(`src/benchmark/real/workloads.ts` pattern): fixture JS repo, `node:test` suites with
allowed-set semantics, task descriptions with exact behavioral contracts. Requirements:
- Every task's contract must be checkable by the repo's own test command (no LLM judging).
- At least one task per workload must be *adversarial to isolation*: its tests pass in a lone
  workspace but the feature is wrong unless siblings integrate (forces the train to matter).
- Fixture repos sized per §1.3 (file counts are part of the complexity treatment — a 200-file
  repo with 3 tasks is a different experiment; do not mix axes).

**Stratum B — real-repo-derived fixtures (Large, XL).** Donor criteria:
1. Small-to-mid JS/TS open-source project (single package, `node --test` or `vitest`
   runnable in <120 s, no network/services at test time, no native builds).
2. Feature = a real merged PR/issue-sized change, decomposable into 8–25 tasks
   (decomposition per §4; the donor PR description becomes the feature spec).
3. Donor test suite (possibly trimmed to feature-relevant files, trim recorded) serves as the
   regression-correctness oracle (§6.3).
4. License permits vendoring a fixture snapshot; snapshot commit hash recorded per run.
5. Exclusion: repos requiring framework-specific build steps, e2e browsers, or secrets.

Minimum dataset: 2 workloads per level (8 workloads total), each workload run at its level's
repeat count. Two workloads per level guards against single-workload idiosyncrasy; more is
better budget permitting, added in whole-workload units only.

---

## 3. Feature selection criteria

A candidate feature is admitted iff ALL hold:

1. **Decomposable:** admits ≥ the level's minimum task count of independently *describable*
   tasks (each with a behavioral contract a stranger could implement).
2. **Verifiable:** a deterministic command (repo tests, possibly feature-scoped) decides
   feature correctness without human judgment (§6.2).
3. **Contended:** meets the level's claim-overlap floor (§1.3) — features with fully disjoint
   files are Small-level by definition regardless of task count.
4. **Ordered:** meets the level's dependency-density floor — unordered bags of tasks do not
   test scheduling and are excluded above Small.
5. **Right-sized context:** the union of files a single agent must read to do the whole feature
   exceeds ~30% of the model's effective context at Large, ~60% at XL (estimated by token
   count of the relevant sources; method recorded). This operationalizes "complexity" as
   context pressure — the mechanism H1 invokes. If the context-fraction criterion cannot be
   met, the feature is demoted a level rather than admitted on task count alone.
6. **No oracle leakage:** task descriptions must not contain the donor PR's diff or
   implementation wording (paraphrase required; reviewer attests).

---

## 4. Decomposition protocol

M17's decomposition was human-authored fixture data. M18 keeps human authorship (Atlas has no
decomposer yet — §E of the M17 assessment) but formalizes it so the step is auditable and the
scheduler's inputs are not rigged:

1. Author writes: task list (key, title, behavioral description), per-task WRITE claims
   (file/directory paths), `dependsOn` edges.
2. **Independent reviewer** (second human, or the same human after ≥48 h with a checklist)
   verifies: every claim path exists-or-will-exist in the repo; no task's description names
   another task's implementation (only its interface); dependency edges are necessary
   (would the task fail without the prerequisite's output?).
3. Scheduler dry-run: `planSchedule` on the decomposition must produce the level's expected
   parallelism band (§1.3). If it collapses to 1 wave at Large/XL, the decomposition is
   defective (over-serialized) — fix the claims/edges, not the scheduler.
4. The decomposition (tasks + claims + edges + prompts) is frozen per workload and **shared
   byte-identically across arms** (same discipline as M17's shared renderer).
5. Decomposition authorship and review attestation are recorded per workload as experiment
   metadata. This is a confound (human skill), disclosed not hidden.

---

## 5. Controls

Inherited from M17 (same agent binary, model, timeout, env allowlist, verification command,
no retries, per-workload persistence, provider-failure taxonomy with RAW + VALID reporting).
Additions/changes for M18:

1. **Same decomposition across arms** (§4) — the only experimental variable is orchestration.
2. **Same per-task prompt bytes** across arms (M17 renderer discipline extended to new tasks).
3. **Union-prompt construction for SA** unchanged (all task sections, sorted) — SA's context
   load growing with task count is the *treatment mechanism*, not a confound; do not
   summarize or chunk it (that would be a different arm).
4. **Timeout scales with level:** worker timeout = 600 s (Small/Medium), 900 s (Large),
   1200 s (XL), identical across arms within a level. Rationale: larger tasks need longer
   sessions; equal-across-arms preserves fairness. Timeout value is a level constant,
   recorded, never tuned mid-experiment.
5. **Fresh fixture + fresh scratch per run** (M17 `runOneRealStrategy` discipline).
6. **Model fixed** for the whole experiment. If the provider changes rate limits or model
   versions mid-experiment, affected runs are classified PROVIDER_FAILURE per M17 protocol;
   a model-version change forces a protocol amendment note, not silent continuation.
7. **No DUMB_PARALLEL** (§1.1). No new arms mid-experiment.

---

## 6. Success predicate (M17 predicate + survival gating)

A run is **SUCCESSFUL** iff ALL of the following hold. Failure of any one fails the run.
Every sub-predicate is recorded separately so partial-credit analysis is possible post hoc
without changing the primary binary outcome.

### 6.1 Worker completion (per task)
Task execution status COMPLETED, Atlas-executed tests PASSED, verification verdict VERIFIED
(M17 `runOneRealTask` semantics, unchanged).

### 6.2 Final feature correctness (run-level)
The feature's deterministic test command passes **in the final train-head worktree**
(cumulative, all feature tests + regression scope). This is stricter than M17: per-worker
isolated passes are necessary but not sufficient.

### 6.3 Regression correctness (run-level, Stratum B; advisory in A)
The donor's full (or recorded-trimmed) suite passes at the train head. Any regression =
run failure, regardless of feature-test status.

### 6.4 Task contribution survival (per task — the M17 fix)
For every intended task key, the task's contribution must be **present and operative** in
the final train head, per §7. A task whose diff was silently overwritten, reverted, or
never merged (empty diff, NOT_ATTEMPTED, MERGE_FAILED) fails the run — even if all tests
pass. This closes the M17 mixed-workload loophole where last-writer-wins scored 10/10
while discarding a worker's output.

### 6.5 No human intervention
Any manual edit, re-run, hint, or conflict resolution during the run = failure
(intervention logged, run scored 0). Setup/decomposition authorship is pre-run and excluded.

---

## 7. Contribution-survival methodology

For each task, survival is decided by **three deterministic checks** (all must pass; all are
mechanical, no LLM judgment):

1. **Diff presence:** `git diff <base> <train-head> -- <task's claimed paths>` is non-empty
   AND contains a semantic marker unique to the task's contract. Markers are defined at
   decomposition time (§4): e.g., for "implement `total()`", the marker is a behavior probe,
   not a string — see check 2. Purely cosmetic diffs (whitespace, renames without behavior)
   do not count; the reviewer pre-registers one **behavioral probe per task**: a minimal
   node one-liner exercising the task's contract against the train head (e.g.,
   `total([{price:10,qty:2}])===25`). Probe passes ⇒ contribution present.
2. **Behavioral probe passes at train head** (covers overwrite detection: if wave N+1
   clobbered task N's function, the probe fails even though the diff is non-empty).
3. **Attribution:** `git log --follow` / blame on the probed lines traces to the task's
   worker branch merge (or a train merge containing it) — guards against "another task
   accidentally reimplemented it" false positives. If the probe passes but attribution
   fails, the task is scored SURVIVED_WITH_REIMPLEMENTATION (run still succeeds; flagged
   for sensitivity analysis).

Survival outcomes per task: `SURVIVED` / `OVERWRITTEN` / `REVERTED` / `NEVER_MERGED` /
`SURVIVED_WITH_REIMPLEMENTATION`. Run-level survival rate = SURVIVED(+REIMPL) / intended tasks.
Primary predicate requires 100% (6.4); survival rate is also analyzed as a continuous
secondary outcome (far more sensitive than the binary success at detecting partial
overwrite regimes).

For SA runs, "tasks" are the union-prompt sections; the same probes apply against the single
workspace's final commit (SA can fail survival too — e.g., it implements v2 then overwrites
with v3 and the v2 probe fails — which is correct: the intended contribution did not survive).

---

## 8. Statistical analysis plan

Primary outcome: binary run success (§6). Secondary: survival rate (§7), wall-clock,
tokens/cost (requires new instrumentation — counters only, §10 of roadmap P2; if
unavailable, wall-clock + wave counts proxy it, disclosed as a limitation).

1. **Per-level contrasts:** success-rate difference (AE − SA) with 95% Wilson CIs per arm
   and Newcombe CI for the difference. No significance claims within levels at n≤16
   except as noted.
2. **Crossover test (the pre-registered analysis):** logistic regression
   `success ~ strategy + complexity + strategy:complexity`, complexity coded 1–4
   (sensitivity: also as categorical). **H1 predicts a positive interaction term**
   (AE's log-odds improve relative to SA with complexity); H0 predicts interaction ≤ 0.
   Report the interaction coefficient, its CI, and p-value. This single test is the
   experiment's verdict statistic — chosen because it directly formalizes "degrades faster."
3. **Survival-rate analysis:** same interaction model on per-run survival rates
   (fractional logistic or beta regression); expected to show the effect earlier/louder
   than binary success.
4. **Latency:** median successful wall-clock per arm per level (M17 convention; no
   artificial penalties for failures). Cost analysis only if token instrumentation lands.
5. **Multiplicity:** the interaction test is confirmatory (α=0.05); all per-level and
   per-workload contrasts are exploratory with CIs, no p-value claims.
6. **Power honesty:** with 56 runs the interaction test is powered only for large effects.
   A non-significant interaction does NOT confirm H0 — it fails to reject it. §12's
   falsification criteria are therefore stated as estimation-based (CI bounds), not
   p-value-based, wherever possible.
7. **Provider failures:** M17 protocol — RAW rates (all runs) + VALID rates (excluding
   evidenced PROVIDER_FAILUREs); interaction test run on both; any discrepancy disclosed.

---

## 9. Expected failure modes (pre-registered)

| # | Mode | Expected arm(s) | Level | Detection |
|---|---|---|---|---|
| F1 | Context loss: SA drops/omits tasks or cross-contaminates contracts | SA | Large/XL | Survival probes fail; union-prompt sections unaddressed |
| F2 | Worker flakiness on weak model (bad DI, uncommitted work, claim violations) | Both (more AE task-exposures) | All | execution status FAILED / CLAIM_VIOLATION in outcomes |
| F3 | Silent overwrite (later wave clobbers earlier) scoring false success | AE | Medium+ | Survival probes (would pass M17 predicate, fail §6.4) |
| F4 | Train halt on genuine contention | AE | Large/XL | HALTED + triage labels; run fails via §6.2/6.4 |
| F5 | Union-prompt contradiction (competing implementations in one prompt) | SA | Medium+ | One probe of the pair fails |
| F6 | Timeout exhaustion on long sessions | Both | XL | PROVIDER/WORKER timeout classification; §5.4 levels set from pilot timings |
| F7 | Regression breakage invisible to feature tests | Both | Large/XL (B) | §6.3 donor suite |

F3 is the mode M17 could not see; if F3 dominates AE's Large/XL failures, the conclusion is
"evolving base trades conflicts for overwrites" — a substantive negative result, not a null.

---

## 10. Stopping criteria

1. **Complete:** all 56 runs persisted → write final report. No early stopping for efficacy
   (no peeking-driven decisions; interim persistence checks are integrity-only).
2. **Futility (provider):** if PROVIDER_FAILUREs exceed 30% of attempted runs in any level,
   pause and resume on provider recovery; interrupted levels restart at the run (per-run
   persistence required — M17's per-workload granularity is insufficient at XL cost).
   Budget cap: 2× the estimated agent budget, then stop and report partial results with
   the interaction test on completed levels only (disclosed as underpowered).
3. **Design defect:** if ≥2 runs at any level fail due to fixture/decomposition error
   (not agent/orchestration behavior), halt that workload, fix the fixture, and restart
   that workload's cells from zero (prior cells voided, disclosed). Do not patch around
   defective fixtures run-by-run.
4. **Safety:** any run touching paths outside its scratch/fixture, or any merge into a
   non-`atlas/*` branch, halts the experiment for a post-mortem (never observed in M17;
   retained as a guardrail).

---

## 11. What result would validate Atlas

Pre-registered validation (any one suffices for a qualified claim; all three for a strong claim):

- **V1 (crossover):** interaction term positive with 95% CI excluding 0 — AE's relative
  reliability improves with complexity. The crossing level is reported as a point estimate
  with CI, not a slogan.
- **V2 (estimation):** at Large and/or XL, AE − SA success-rate difference has a Newcombe
  95% CI excluding 0 in AE's favor (on either RAW or VALID, with both reported).
- **V3 (mechanistic):** SA failures concentrate in F1/F5 (context/contradiction) while AE
  failures concentrate in F2 (agent flakiness) — i.e., the arms fail for *different,
  predicted* reasons, and AE's failure mode is fixable by stronger models while SA's is
  structural. Requires the failure-mode distributions to differ as predicted, not merely
  anecdotal instances.

A validated claim would read: "Above [level], evolving-base orchestration is more reliable
than single-agent execution for multi-task features (Δ=[…], 95% CI […]), at [×] median
latency cost." Nothing broader.

---

## 12. What result would falsify Atlas

Pre-registered falsification (any one is sufficient to accept H0 within the tested range):

- **F-A (no interaction):** interaction-term 95% CI lies entirely at or below 0 →
  no evidence AE degrades slower; the core mechanistic claim fails.
- **F-B (SA dominance at scale):** at Large and XL, SA − AE difference CIs exclude 0 in
  SA's favor, or SA point estimates meet/exceed AE's at every level (replicating M17's
  pattern upward) → the crossover does not exist in 2–25 tasks; the single agent wins
  on reliability AND latency everywhere tested.
- **F-C (overwrite regime):** AE's Large/XL failures are dominated by F3 (silent
  overwrites) with survival rates significantly below SA's → evolving base does not solve
  contention, it hides it; the M17 0-conflict result is re-interpreted as measurement
  artifact rather than reliability.
- **F-D (cost blowup):** AE achieves parity-or-better reliability only at >3× SA
  wall-clock (or token cost, if instrumented) at every level → even a reliability win is
  not a usefulness win; the "more useful than" in the research question fails.

If F-A/F-B obtain, the prescribed conclusion is H0 within 2–25 tasks, and the roadmap
prescription is: do not build product orchestration; retain the merge train as a library,
redirect to decomposition research or kill the project. A null result is a result —
publish it as such.

---

## Appendix: M17 weaknesses explicitly fixed here

1. **Survival blindness** → §6.4 + §7 (behavioral probes + attribution).
2. **Toy scale** → §1.3 complexity axis + §2 Stratum B real-repo fixtures.
3. **No decomposition under test** → §4 formalizes (but honestly retains) human authorship;
   autonomous decomposition remains out of scope and is named as the blocker.
4. **`workerMs` null for Atlas arm / no cost data** → instrumentation requirement noted in
   §8 (counters only, no infrastructure); wall-clock proxy disclosed if missing.
5. **Strawman control spend** → DUMB_PARALLEL excluded (§1.1) with written justification.
6. **Per-workload persistence granularity** → per-run persistence required (§10.2).
7. **Peeking/narrative risk** → pre-registered interaction test (§8.2), pre-registered
   failure modes (§9), pre-registered validation/falsification (§11/§12).

---

## Amendment A: Measured Context Methodology + Setup Contract (2026-09-21)

**Amendment ID:** M18-AMD-001
**Author:** opencode (automated)
**Reviewer:** pending
**Date:** 2026-09-21

### A.1 — Repeal of §3.5 hard context gates

The original §3.5 criterion 5 ("Right-sized context: exceeds ~30% at Large, ~60% at XL")
is **repealed as an admission/demotion gate**. Rationale: real-repo repositories (showdown,
node-semver, mocha, postcss) have meaningful source, but the literal 30%/60% threshold was
not met under any defensible token-estimation method, and artificially inflating context to
satisfy the threshold violates the principle of honest measurement.

Replacement: context is now **descriptive and exploratory**, never an admission/demotion gate.
The structural-complexity criteria (task count, density, chain length, contention) carry the
level-eligibility weight. Context fractions are measured and reported as covariates in the
interaction analysis (§8.5 exploratory moderator).

### A.2 — Measured context methodology (new §3.6)

**Four quantities, distinct by construction:**

| Symbol | Name | Definition | Arm-dependent? | Observable? |
|---|---|---|---|---|
| §R | Repository size | Tokens over vendored snapshot text files (excl. `node_modules/`, `.git/`, `dist/`, `build/`, lockfiles). Measured once per workload. | No | Yes, deterministic |
| §T | Task-relevant context | Tokens over: union of task-claimed paths expanded to files + test files in `testCommand` scope + fixture files named in feature spec. Computed from frozen spec + snapshot. | No (identical input) | Yes, deterministic |
| §V | Agent-visible prompt context | Tokens in the exact prompt argv bytes the harness passes to the provider. For SA: single union prompt. For AE: per-invocation task prompts — record `max` (largest single context any worker faces) and `mean`. | **Yes — this is the treatment contrast** | Yes, deterministic |
| §U | Utilization | §V ÷ declared model capacity | Yes | Yes, derived |

**Provider-side system prompts, tool-returned file reads, KV-cache behavior:** unobservable
through the M8/M11 boundary, therefore excluded by definition. §T is the deterministic
repository-side proxy for pressure the repo *could* exert; §V is the pressure we *apply*.

**Counting rules (all sub-questions answered):**
- §R includes: code, config, markdown docs in snapshot; excludes `node_modules/`, `.git/`,
  `dist/`, `build/`, lockfiles, files >1 MB. Tests counted separately (recorded as
  `repoTestTokens`) so test-heavy repos don't masquerade as source pressure.
- §T: union of task-claimed WRITE paths expanded to files + testCommand scope files +
  feature-spec fixture files. Computed from frozen spec, no agent involved.
- §V: harness-supplied prompt bytes only (exact, reproducible). Provider system text excluded.
- Tool-returned source: excluded (unobservable). §T is its deterministic proxy.
- Cached tokens: excluded (provider-internal, non-reproducible).

**Token estimator:** `estimateTokens(text) = ceil(UTF16-byte-length / 4)`. Versioned:
`TOKEN_ESTIMATOR_VERSION = 1`. Deterministic across machines and time. Known ±30% absolute
error, acceptable because M18 comparisons are relative (SA vs AE, level vs level). Provider-reported
usage (`usage.tokens`) recorded alongside when observed, never mixed in.

**Recorded per run** (new `context` record on `ScaleRunResult`):
```
{
  estimatorVersion: 1,
  modelCapacityTokens: number,
  repoTokens: number,       // §R — identical across workload's runs
  taskRelevantTokens: number, // §T — identical across workload's runs
  promptTokensMax: number,   // §V max across invocations (SA: always 1 invocation)
  promptTokensMean: number,  // §V mean across invocations
  utilizationMax: number,    // §V max / modelCapacity
}
```

§R/§T recomputed once per workload (cached), §V per run. Setup wall-time recorded in state
meta, never in run medians.

**Thresholds:** None as eligibility gates. Descriptive ladder for discussion only:
- Low: <5% utilization
- Moderate: 5–20%
- High: >20%

§T-fraction reported as a continuous moderator in the interaction model (exploratory, §8.5).

**Prompt-parity lock (strengthened):** prompts remain byte-identical per task (frozen renderer);
SA union = concatenation of the same sections. Explicit prohibition: **no padding, truncation,
or summarization to target a fraction.** The metric measures; it never feeds back into
construction. Violation = protocol breach, run voided.

### A.3 — Setup/test contract (new §5.6)

Workload spec gains:
- `setupCommands: string[][]` (default `[]`): argv-only commands (e.g. `["npm","ci","--no-audit","--no-fund"]`,
  optionally a build step) run **once per materialized fixture, sequentially, cwd=fixtureRoot**,
  before any arm runs.
- `setupTimeoutMs` (default 600_000): timeout for the entire setup phase.

**When:** setup runs once per fixture materialization (amortized over 12–24 cells), never per
run, never per arm. Per-run installs forbidden.

**npm cache:** `npm_config_cache` points at a persistent operator-provided dir; `--prefer-offline`
recommended. Vendored snapshot + lockfile make installs reproducible.

**Setup failures → SETUP_FAILURE (workload-level):**
- Fixture-setup failure (incl. install/build) **aborts the workload with zero cells recorded**.
- Retrying setup after fixing the environment is *not* a run retry (nothing was observed).
- Timeout → same classification.

**Network:** permitted **only during setup** (registry fetch); runs are offline-capable.
Record `networkUsedAtSetup: boolean`. Unreachable registry → SETUP_FAILURE, halt workload.

**Arm parity:** setup precedes all arms; identical bytes; pinned versions captured:
- snapshot ref (commit SHA or tag)
- lockfile SHA256 (if exists)
- `node --version` output
- Runner `--version` output (if available)

All recorded into state `meta.setupEvidence`.

**Dependency domination guard:** setup wall-time reported separately from run medians (never
mixed). If setup exceeds ~20% of projected cell budget for the workload, re-scope rather
than proceed blind.

**node_modules in worktrees (the subtle one):** fixture `.gitignore` gains `node_modules/`
+ build outputs at build time (M18 harness), so agent `git add -A` ignores them and
pristine-checks stay clean. Module resolution in worktrees flows through
`NODE_PATH=<fixture>/node_modules` supplied via launcher env + agent `envAllowlist`
(**config, not code**). Committed shims + probes resolve runner libs through it.
No frozen file changes required.

### A.4 — Runner deviation protocol

The original design specified `node --test` or `vitest`. Real repositories use:
- showdown → mocha
- node-semver → tap
- mocha → self-hosted `bin/mocha.js`
- postcss → uvu

All deviations are **local, deterministic, scoped, and offline-capable**. Each workload's
`testCommand` explicitly names the runner and scope. The shim approach (A.3) resolves runner
modules through `NODE_PATH` without modifying the vendored repo.

The exact runner and scope per workload is frozen pre-run in the workload spec.
Deviations are protocol amendments, not silent drift.

### A.5 — SETUP_FAILURE classification semantics

| Field | Value |
|---|---|
| Failure classification on `ScaleRunResult` | NOT USED (no runs recorded) |
| Workload-level outcome | SETUP_FAILURE — zero cells |
| Retried? | Only after environment correction (not an experimental retry) |
| Setup wall-time | Recorded in state meta, excluded from run medians |

### A.6 — NODE_PATH/shim mechanism

Probes and test shims resolve modules through `NODE_PATH` set in the child env:

```
runBehavioralProbe({ ..., fixtureNodeModulesPath: "/path/to/fixture/node_modules" })
```

The harness sets `NODE_PATH` in `execFile` options. Committed shim scripts
(e.g. `test/m18-mocha.js`) `require()` the runner lib, which resolves through
`NODE_PATH`. This is config-level (env var), not code-level (no core changes).

### A.7 — Preserved/frozen controls (complete list)

All controls from the original design remain frozen:
- SA/AE arm implementations (M17 frozen)
- 2-arm matrix (SINGLE_AGENT × ATLAS_EVOLVING)
- Repeats per level (8/8/6/6)
- Per-level timeouts (600k/600k/900k/1200k)
- Shared renderer prompt construction
- Same decomposition across arms
- Identical verification
- Success predicate semantics (only additive fields)
- W1–W4 byte-for-byte (no code changes to W1–W4)
- No retries for recorded cells
- RAW+VALID reporting

Additions are strictly additive: context record (descriptive), setup contract (infra),
NODE_PATH (config), SETUP_FAILURE (new classification).

### A.8 — Required code changes (implementation summary)

- `src/benchmark/scale/types.ts`: context record, setup attempt/state, ScaleSetupAttempt,
  SETUP_FAILURE enum member, ScaleSetupEvidence
- `src/benchmark/scale/context.ts` (new): estimateTokens (versioned), budget measurement,
  prompt token recompute
- `src/benchmark/scale/runner.ts`: setup execution, .gitignore protection, context assembly,
  version evidence capture
- `src/benchmark/scale/survival.ts`: NODE_PATH support in runBehavioralProbe
- `src/benchmark/scale/aggregation.ts`: context summary plumbing
- `src/benchmark/scale/index.ts`: new exports

No changes to: scheduler, wave loop, train-head, verification core, prompts, arms,
M17 files, matrix, worker runtime.

### A.9 — What remains frozen

Everything in the original design's control section (§5) plus:
- All M17 arm implementations
- 2-arm matrix structure
- Repeats/timeouts
- Prompt byte-identicality
- Verification command semantics
- W1–W4 workload content
- No-retries rule for recorded cells
- RAW+VALID reporting
- All frozen M17 code

---

## Amendment B: W7 exclusion from the matrix (2026-09-24)

**Amendment ID:** M18-AMD-002
**Author:** opencode (automated)
**Reviewer:** pending
**Date:** 2026-09-24

### B.1 — Matrix change (only change in this amendment)

`scale-xl-mocha-duration` (W7) is removed from the experiment matrix. W8
(`scale-xl-postcss-position`) remains the sole XL workload:

| Level | Workloads | Repeats/arm | Cells (2 arms) | Was |
|---|---|---|---|---|
| Small (W1, W2) | 2 | 8 | 32 | unchanged |
| Medium (W3, W4) | 2 | 8 | 32 | unchanged |
| Large (W5, W6) | 2 | 6 | 24 | unchanged |
| XL (W8 only) | 1 | 6 | 12 | 24 (W7+W8) |
| **Total** | **7** | | **100** | **112** |

Per-arm total: 56 → 50. Both arms lose W7 symmetrically (6 SINGLE_AGENT +
6 ATLAS_EVOLVING cells never run). Repeats, timeouts, model, prompts,
decomposition, claims, verification, contribution-survival (§7),
context (§A.2), and setup contract (§A.3) are unchanged.

### B.2 — Why W7 is excluded (diagnosis, not execution)

W7 was diagnosed but **never executed**: 0 W7 cells are recorded, and W7
contributes no observed success variance. Its Mocha 12 runtime cannot execute
inside Atlas's tracked-files-only git worktrees under the frozen methodology:
- `lib/suite.js` requires `debug`, `lib/runnable.js` requires `debug`,
  `lib/reporters/base.js` requires `diff`; the package is ESM
  (`"type": "module"`) with 16 third-party dependencies.
- The M18 spec (`test/m18-duration-class.spec.cjs`) requires `new Mocha()`
  from `../index.js` plus mocha `describe`/`it` globals — none available
  without `node_modules/`.
- Both the `testCommand` (`node bin/mocha.js …`) and the `regressionCommand`
  were proven to exit non-zero in tracked-files-only worktree simulations.
- No faithful dependency-free formulation exists: stubbing mocha's dependency
  tree to force construction would replace the real library behavior under
  test, and source-content checks would abandon the spec's runtime semantics.
  Both are forbidden, so repair was stopped rather than attempted.

### B.3 — Analysis consequences (binding)

- The interaction model (§8.2) is unchanged in form; complexity coding 1–4 is
  retained (levels unchanged). The XL level estimate rests on W8 alone:
  report the XL per-workload contrast as exploratory alongside the level fit.
- §2 "minimum dataset: 2 workloads per level" gains a recorded XL exception.
  All other levels keep two workloads.
- §10.1 completion criterion is amended to 50 runs/arm (100 total). W7 cells
  are out of scope, not missing data: no imputation, no substitution.
- Recorded results are preserved untouched: 38 runs (W5/W6/W8 smoke + W1
  two-cell probe) remain the evidence base; `/tmp/m18-scale-state.json` is
  not deleted or rewritten by this amendment.

### B.4 — Prior authorized workload-gate repairs (record, no new change)

Before this amendment, three gate repairs were authorized and verified to keep
test/regression commands executable in tracked-files-only worktrees (probes,
snapshots, lockfiles, and task decomposition untouched throughout):
- W5: `regressionCommand` `./node_modules/.bin/grunt simplemocha:node` →
  `node --test test/m18-tables-v2.mjs` (mirrors the approved `testCommand`).
- W6: `test/m18-semver-wildcard.js` ported tap → `node:test` +
  `node:assert/strict` (all 4 assertion groups preserved 1:1; semver is
  dependency-free); `testCommand`/`regressionCommand` →
  `node --test test/m18-semver-wildcard.js`.
- W8: `test/m18-position.test.js` ported uvu → `node:test` (all 5 tests and
  assertions byte-identical); new tracked helper `test/m18-shim.js` maps
  postcss's three third-party leaves (picocolors, nanoid/non-secure,
  source-map-js) to minimal load-time stubs so the real pinned lib loads
  without `node_modules/`; `testCommand`/`regressionCommand` →
  `node -r ./test/m18-shim.js --test test/m18-position.test.js`.
- Each repair was verified exit-0 in tracked-files-only simulations with real
  assertions executing, plus sensitivity checks (ported tests fail against
  broken-behavior copies). W5/W6/W8 smoke cells then executed normally with
  zero fixture/test-gate failures.

---

## Amendment C: Per-worker OpenCode state isolation (2026-09-24)

**Amendment ID:** M18-AMD-003
**Author:** opencode (automated)
**Reviewer:** pending
**Date:** 2026-09-24

### C.1 — Problem (observed, not hypothesized)

13 smoke-run task failures read `database is locked` from the OpenCode CLI's
own shared database `~/.local/share/opencode/opencode.db` (1.6 GB session
store; all parallel workers inherited one `HOME`, hence one database file).
All 13 occurred in multi-worker ATLAS_EVOLVING waves; none in SINGLE_AGENT
runs. Atlas's own SQLite database produced zero observed failures. Full
diagnosis is recorded in the experiment log; this amendment implements the
authorized fix only.

### C.2 — Mechanism (worker-spawn boundary only)

`src/workers/command-provider.ts` (sole changed file): `execute()` now routes
the child environment through `withIsolatedOpencodeDataHome()`, which sets
exactly one additional variable, `XDG_DATA_HOME`, to a hidden sibling of the
Atlas-assigned workspace (e.g. `<worktree-parent>/.<worktree>.opencode-data`).
Opencode resolves its data root from `XDG_DATA_HOME` (verified empirically),
so each worker CLI gets a private `opencode.db`. `auth.json`/`mcp-auth.json`
are seeded read-only (mode 0600) from the host data dir so authentication is
identical; if no auth state exists, the environment is byte-identical to
before; any helper failure falls back to the previous environment.

### C.3 — Scope and invariants preserved

Executable, argv, rendered prompts, `HOME`, worker behavior, workload specs,
strategies, scheduler, worker counts, repeats, timeouts, model, test
commands, both methodologies, and W7 status are all untouched. The directory
is outside every git worktree (invisible to claim enforcement and pristine
asserts) and inside the run's scratch tree, so existing per-run
`rm(scratchRoot)` cleanup removes it with no new cleanup code. Uniqueness
follows workspace uniqueness (one workspace per worker task); sequential
reuse is safe because concurrent executions never share a workspace.

### C.4 — Verification (isolation only, no benchmark cells)

- `pnpm typecheck` clean, `pnpm build` clean, worker/runtime tests 41/41 pass.
- Non-benchmark concurrency smoke: two concurrent `opencode run` processes
  with the same model/config and isolated data homes both exited 0 with
  correct output, produced two distinct `opencode.db` inodes (one session
  each), zero `database is locked` errors, and left the shared database
  untouched (mtime predates the smoke).
- No benchmark cells executed; M18 state unchanged (38 recorded runs);
  frozen runtime files unchanged except this amendment's file.

### C.5 — Status

Implemented and verified in isolation. In-vivo validation is pending: the
first resumed benchmark cells will be the first execution exercising it under
benchmark load. It is not yet proven under benchmark load.
