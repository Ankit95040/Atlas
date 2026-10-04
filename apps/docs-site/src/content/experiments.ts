export type ExperimentCategory =
  | "performance"
  | "reliability"
  | "safety"
  | "architecture"
  | "routing"
  | "benchmarking"
  | "product";

export type ExperimentStatus = "completed" | "screening" | "design-only" | "inconclusive";

export type Experiment = {
  id: string;
  milestone: string;
  title: string;
  era: string;
  categories: ExperimentCategory[];
  status: ExperimentStatus;
  question: string;
  verdict: string;
  sampleSize: string;
  keyFigures: Array<{ label: string; value: string }>;
  limitations: string[];
  body: Array<
    | { kind: "paragraph"; text: string }
    | { kind: "list"; items: string[] }
    | { kind: "table"; head: string[]; rows: string[][] }
    | { kind: "callout"; tone: "info" | "warn" | "honest"; title: string; text: string }
  >;
};

export const ERAS = [
  "Foundation & Benchmarking",
  "Reliability, Recovery & Lifecycle",
  "Dashboard & Architecture",
  "Performance & Instrumentation",
  "Routing & Execution Strategy",
  "Product Viability",
] as const;

export const EXPERIMENTS: Experiment[] = [
  {
    id: "m17-baseline",
    milestone: "M17",
    title: "Single-agent vs Atlas baseline (180 runs)",
    era: "Foundation & Benchmarking",
    categories: ["benchmarking", "performance"],
    status: "completed",
    question: "How does Atlas orchestration compare to a single agent on fixture workloads?",
    verdict: "No significant success difference; Atlas adds measurable latency overhead.",
    sampleSize: "n=180 (60 per arm: SINGLE_AGENT, ATLAS_ORIGINAL, ATLAS_EVOLVING)",
    keyFigures: [
      { label: "Single-agent success", value: "55/60 (91.7%)" },
      { label: "Atlas evolving success", value: "51/60 (85.0%)" },
      { label: "Significance", value: "p≈0.26, not significant" },
      { label: "Atlas latency overhead", value: "+40% median" },
      { label: "Integration conflicts", value: "0 observed" },
    ],
    limitations: [
      "Raw M17 trial data is absent from the repository; figures are quoted secondhand in the M18 design document.",
      "Provider/model identities for M17 are not recorded in-tree.",
      "Synthetic fixture workloads, not real repositories.",
    ],
    body: [
      {
        kind: "paragraph",
        text: "M17 is the closest thing Atlas has to a historical baseline: 180 runs across three strategy arms on fixture workloads. The headline result cuts both ways and the archive reports it that way — success rates are statistically indistinguishable, while Atlas pays roughly 40% median latency overhead. Failure analysis found agent (worker) failures dominating orchestration failures, which focused later milestones on provider behavior rather than scheduler pathology.",
      },
      {
        kind: "callout",
        tone: "honest",
        title: "Provenance warning",
        text: "No M17 report or raw data exists in the repository. These figures are quoted from the M18 design document and cannot be independently reproduced. Treat them as historical context, not as a baseline for comparison.",
      },
      {
        kind: "paragraph",
        text: "What changed afterward: the M18 scale/crossover design kept the three-arm protocol, added real-repository strata, and tapered repeats by complexity level — directly addressing M17's synthetic-only limitation.",
      },
    ],
  },
  {
    id: "m18-scale-crossover",
    milestone: "M18",
    title: "Scale and crossover experiment design",
    era: "Foundation & Benchmarking",
    categories: ["benchmarking", "architecture"],
    status: "design-only",
    question: "At what feature complexity does Atlas-Evolving become more useful than a single agent?",
    verdict: "Design produced; four complexity levels with repeats tapering by cost. Execution status unverified in-tree.",
    sampleSize: "Designed: levels × arms with taper (per-run cost grows superlinearly)",
    keyFigures: [
      { label: "Complexity levels", value: "4 (Small → XL)" },
      { label: "Real-repo stratum", value: "Large + XL only" },
      { label: "Worker timeout", value: "600s (S/M), 900s (Large)" },
    ],
    limitations: [
      "Design document only; no execution results found in the repository.",
      "Real-repo donor criteria (license, snapshot pinning) specified but not exercised here.",
    ],
    body: [
      {
        kind: "paragraph",
        text: "M18 answers the right question — when does orchestration earn its overhead? — with a scale ladder from fixture repos to real-repo-derived fixtures and a context-fraction hypothesis (single-agent context exceeding ~30–60% of effective context at Large/XL). The design is preserved as the protocol reference for later pilots rather than as results.",
      },
    ],
  },
  {
    id: "m19-empty-completion",
    milestone: "M19",
    title: "Empty-completion policy and lifecycle coverage",
    era: "Reliability, Recovery & Lifecycle",
    categories: ["reliability", "safety"],
    status: "completed",
    question: "How should Atlas classify valid execution that contributes no source change?",
    verdict: "COMPLETED_EMPTY: terminal, distinct from COMPLETED and FAILED, with persisted reasons.",
    sampleSize: "Unit + integration suites (deterministic, no provider)",
    keyFigures: [
      { label: "New terminal state", value: "COMPLETED_EMPTY" },
      { label: "Lifecycle events added", value: "WORKFLOW/PLAN/TASK/VERIFICATION/INTEGRATION families" },
    ],
    limitations: ["Policy change, not a benchmark; evidence is test coverage, not trials."],
    body: [
      {
        kind: "paragraph",
        text: "M19 closed two honesty gaps: valid hygiene work with no effective contribution used to read as either success or failure, and lifecycle stages had no observable events. Both are now explicit, persisted, and surfaced in the dashboard and CLI output.",
      },
    ],
  },
  {
    id: "m22-audit-trial",
    milestone: "M22",
    title: "Readiness audit trial",
    era: "Reliability, Recovery & Lifecycle",
    categories: ["reliability"],
    status: "completed",
    question: "Is Atlas operationally ready: init, transitions, recovery docs?",
    verdict: "READY after implementing atlas init, task transition with TASK_TRANSITIONED events, and operator docs.",
    sampleSize: "499/499 tests passing at milestone close",
    keyFigures: [{ label: "Gate", value: "499/499" }],
    limitations: ["Readiness checklist, not comparative evidence."],
    body: [
      {
        kind: "paragraph",
        text: "The audit found Atlas NOT READY and specified exactly what was missing: first-run onboarding, stuck-state exits with recorded actor and reason, and operator-facing recovery documentation. All three shipped in-milestone (docs/GETTING_STARTED.md, docs/RECOVERY_RUNBOOK.md).",
      },
    ],
  },
  {
    id: "m23-worker-uniqueness",
    milestone: "M23",
    title: "Worker assignment and sequential re-execution",
    era: "Reliability, Recovery & Lifecycle",
    categories: ["reliability", "safety"],
    status: "completed",
    question: "Can a failed task be recovered and re-executed without stranded assignments blocking it?",
    verdict: "Yes: Worker.taskId is current-assignment-only with stale-release on settle, failure, and assignment; re-run proven PASS.",
    sampleSize: "507/507 after fix (was FAIL on stale reservation)",
    keyFigures: [
      { label: "Before fix", value: "FAIL (stale reservation blocks re-execution)" },
      { label: "After fix", value: "507/507, sequential re-execution proven" },
    ],
    limitations: ["Failure-injection suites, not provider trials."],
    body: [
      {
        kind: "paragraph",
        text: "The M23 trial failed for the right reason — a stale worker reservation blocked legitimate re-execution — and the M23.1 fix redefined the semantics (current assignment only) rather than patching around them. M23.2 re-ran the trial to PASS. This is the milestone that most clearly demonstrates the program's falsification-first discipline.",
      },
    ],
  },
  {
    id: "m24-dashboard",
    milestone: "M24",
    title: "Read-only SSR dashboard and workflow DAG",
    era: "Dashboard & Architecture",
    categories: ["architecture"],
    status: "completed",
    question: "Can operators observe runs without a frontend that can mutate state?",
    verdict: "Yes: zero-dependency SSR with 8 views, live polling, confirmed POST-only actions, and a workflow DAG.",
    sampleSize: "564/564 tests at close",
    keyFigures: [
      { label: "Views", value: "Home, Runs, Workers, Activity + per-run lenses" },
      { label: "Polling", value: "2.5s main swap, terminal stop" },
      { label: "Mutations", value: "POST-only, confirmed, service-validated" },
    ],
    limitations: ["Observability work; the dashboard is explicitly not orchestration."],
    body: [
      {
        kind: "paragraph",
        text: "M24 built the observation layer the later control-room work stands on: loaders over existing services, a WorkflowGraphData view model, and a hard rule that visual components never schedule, assign, merge, or transition state. The 2.5D and static-island prototypes explored the spatial direction without committing to it.",
      },
    ],
  },
  {
    id: "m25-island",
    milestone: "M25",
    title: "3D Island projector and live transitions",
    era: "Dashboard & Architecture",
    categories: ["architecture"],
    status: "completed",
    question: "Can run state be projected into a live 3D scene without forking WebGL code per surface?",
    verdict: "Yes: descriptor → projector → diff-player split; 583/583 with real-browser render proof.",
    sampleSize: "583/583 tests + Playwright screenshots",
    keyFigures: [
      { label: "Split", value: "WorkflowGraphData → IslandScene → three.js projector" },
      { label: "Transitions", value: "200–600ms, priority-ordered, first-render emits nothing" },
      { label: "Camera", value: "Orthographic, refit on bounds change (M27.7 hardened)" },
    ],
    limitations: [
      "The Island is retired from active product direction as of M28; preserved as projection, not product.",
      "Drag-orbit does not engage in headless Chromium (documented defect); Focus/Reset are the proven paths.",
    ],
    body: [
      {
        kind: "paragraph",
        text: "M25's durable contribution is architectural, not visual: a pure deterministic scene descriptor, a projector that performs zero fetching or writes, and a transition model derived from state diffs. M27.7 later fixed the camera-reset-on-poll defect and the orbit-envelope defect found by real-browser review.",
      },
    ],
  },
  {
    id: "m26-react-shell",
    milestone: "M26",
    title: "React shell PoC with read-only API",
    era: "Dashboard & Architecture",
    categories: ["architecture"],
    status: "completed",
    question: "Can the SSR dashboard grow a React frontend without touching the engine?",
    verdict: "Yes: narrow GET-only JSON API over existing loaders; 590/590 serial + Playwright smoke.",
    sampleSize: "590/590 serial gate + 3/3 Playwright smoke",
    keyFigures: [
      { label: "Routes", value: "/api/home, /api/runs, /api/run/:id/island, /api/run/:id/workspace, /api/workers, /api/activity" },
      { label: "Mutations from UI", value: "0 (405 on non-GET)" },
    ],
    limitations: ["PoC shell; superseded by the M27 control-room redesign work."],
    body: [
      {
        kind: "paragraph",
        text: "M26 proved the engine/UI separation the whole program depends on: the React shell reads exclusively through validated read-only routes, and the commit was deliberately split so engine, SSR, and frontend lines stay independently reviewable.",
      },
    ],
  },
  {
    id: "m27-control-room",
    milestone: "M27",
    title: "Control-room shell, visual direction, and camera stability",
    era: "Dashboard & Architecture",
    categories: ["architecture", "safety"],
    status: "completed",
    question: "Can the frontend become a premium control room without becoming orchestration?",
    verdict: "Shell and direction shipped; camera defects found by real-browser review and fixed with regression tests.",
    sampleSize: "593/593 serial; 5/5 → 8/8 Playwright smoke",
    keyFigures: [
      { label: "Direction", value: "Graphite instrument; Island is the run; read-only" },
      { label: "Camera fixes", value: "Poll-safe framing; constrained orbit envelope" },
      { label: "Docs", value: "M27.2 visual direction, M27.4 island spec, M27.6 topology feasibility" },
    ],
    limitations: [
      "3D label overlap at density and 100/200-task behavior explicitly out of scope.",
      "Island retired from product direction in M28 regardless.",
    ],
    body: [
      {
        kind: "paragraph",
        text: "M27's most valuable output may be process, not pixels: the M27.7 disappearance investigation (camera swinging top-down on aggressive drags) was diagnosed to polar-range root cause with hook-sampled evidence, fixed minimally, and locked with orbit-persistence tests. The design documents remain the visual authority if the Island ever returns.",
      },
    ],
  },
  {
    id: "m28-perf-baseline",
    milestone: "M28.0–M28.2",
    title: "CLI performance audit, decoupling, and instrumentation",
    era: "Performance & Instrumentation",
    categories: ["performance", "benchmarking", "architecture"],
    status: "completed",
    question: "Where does Atlas spend time, and can the CLI runtime shed the UI?",
    verdict: "Scheduler negligible (0–2ms/round); per-task cost is spawn+test+verify; UI cleanly separable by import graph.",
    sampleSize: "Stub-agent baselines; 618/620 → green isolated (load flakes)",
    keyFigures: [
      { label: "CLI startup", value: "~153ms help, ~257ms doctor" },
      { label: "3-task stub e2e", value: "~3.1s (worker ~265ms + verify ~130ms per task)" },
      { label: "Scheduler", value: "0–2ms/round (closed as a target)" },
      { label: "Worktree add/remove", value: "~44/24ms" },
      { label: "UI imports from engine", value: "0 (guaranteed by test)" },
    ],
    limitations: [
      "Stub agents + trivial tests: overhead-only lens by design; real providers add minutes on top.",
      "M28.1 added per-project state (.atlas/atlas.db resolution) and init --state-dir.",
      "M28.2 added assignMs/trainMs/timing rollup with explicit missing[] honesty.",
    ],
    body: [
      {
        kind: "paragraph",
        text: "The audit killed two attractive-sounding optimizations with evidence: scheduler batching (0–2ms — do not implement on this evidence) and worktree-list caching (rejected: would weaken the workspace-confinement gate). The import-boundary test now guarantees the CLI runtime never loads UI modules.",
      },
    ],
  },
  {
    id: "m28-optimizations",
    milestone: "M28.3–M28.4",
    title: "Root memoization and workspace-safety guard",
    era: "Performance & Instrumentation",
    categories: ["performance", "safety"],
    status: "completed",
    question: "What is the smallest safe reduction in Git subprocess cost, and can the checkout protect itself?",
    verdict: "Root memo: 57→34 spawns, −26–29% e2e. Guard: silent cwd-default inside the Atlas checkout is refused.",
    sampleSize: "629/629 then 635/635 serial gates",
    keyFigures: [
      { label: "Git spawns (1-task)", value: "57 → 34 (−40%); rev-parse --show-toplevel 25 → 2" },
      { label: "e2e improvement", value: "−26% (1-task), −28–29% (3-task shapes)" },
      { label: "Guard", value: "Positive checkout identity; explicit --workspace-root always honored" },
    ],
    limitations: [
      "Remaining list/HEAD reads (~300ms) deliberately kept: confinement gates across mutation windows.",
      "Worktree-list caching evaluated and rejected on security grounds (documented no-op).",
    ],
    body: [
      {
        kind: "paragraph",
        text: "M28.3 is the program's model optimization milestone: one file, +18 lines, successes-only memoization with failure re-execution preserved, measured before/after on the same harness. M28.4's guard came from a real profiling incident (harness wrote .atlas/work into the checkout) and was proven live against the built binary.",
      },
    ],
  },
  {
    id: "m28-benchmark-integrity",
    milestone: "M28.5",
    title: "Benchmark integrity and comparability",
    era: "Performance & Instrumentation",
    categories: ["benchmarking"],
    status: "completed",
    question: "Are historical and current benchmark numbers comparable, and is the harness honest?",
    verdict: "M17 raw absent (permanently approximate history); current harness enforces paired arms, null telemetry, quarantine discipline.",
    sampleSize: "Integrity suites 24/24; gate 641/641",
    keyFigures: [
      { label: "M17 comparability", value: "UNKNOWN on provider/model/timeouts (no artifacts)" },
      { label: "Workloads", value: "6 synthetic kinds (7th added in M28.9)" },
      { label: "Telemetry rule", value: "Unknown stays null, never zero" },
    ],
    limitations: [
      "simulatedDurationMs SINGLE_AGENT must never be cited as real-agent evidence (documented naming trap).",
      "Token/cost structurally null through CommandWorkerProvider at this point.",
    ],
    body: [
      {
        kind: "paragraph",
        text: "M28.5's comparability matrix is the reason every later report can state plainly what is and isn't comparable. It also froze the screening rules that govern all subsequent pilots: n=5 labeled screening, randomized order, paired snapshots, no retries, versioned reruns.",
      },
    ],
  },
  {
    id: "m28-pilot",
    milestone: "M28.6",
    title: "Controlled real-provider pilot (30 trials)",
    era: "Performance & Instrumentation",
    categories: ["benchmarking", "performance", "product"],
    status: "completed",
    question: "How does Atlas compare with a single agent under a free model, and where does overhead originate?",
    verdict: "30/30 valid, all VERIFIED; Atlas +23%/+42% wall; overhead tracks agent calls + integration, not scheduler.",
    sampleSize: "n=5 per cell, 2 workloads × 3 arms; free model opencode/muse-spark-1.3-contributor-free",
    keyFigures: [
      { label: "Independent A / B", value: "30.1s / 37.0s medians, 5/5 each" },
      { label: "Chain A / B", value: "41.7s / 59.3s medians, 5/5 each" },
      { label: "Stub overhead", value: "~2s (orchestration-only cost)" },
      { label: "Quota/rate-limit events", value: "0 observed" },
    ],
    limitations: [
      "n=5 screening; two synthetic workloads; one free model; no contention profile; no cost data.",
      "One stub harness bug found mid-pilot, quarantined and re-run (documented precedent).",
    ],
    body: [
      {
        kind: "paragraph",
        text: "The first real-provider evidence: Atlas succeeds on every trial and its overhead is consistent with extra agent calls plus train integration — not scheduler pathology. The report's conclusion is restraint, not triumph: screening evidence, no significance claims, no superiority declarations.",
      },
    ],
  },
  {
    id: "m28-metering",
    milestone: "M28.9",
    title: "Usage metering and workload foundation",
    era: "Performance & Instrumentation",
    categories: ["benchmarking", "product"],
    status: "completed",
    question: "Can provider usage be captured, persisted, and aggregated without perturbing execution?",
    verdict: "Yes: step_finish parsing → PROVIDER_USAGE_OBSERVED events → all-or-null aggregation; migration fixture added.",
    sampleSize: "12/12 usage tests; 8/8 integrity; gate 655/655",
    keyFigures: [
      { label: "Envelope", value: "step_finish tokens{total,input,output,reasoning,cache} + cost" },
      { label: "Semantics", value: "Missing→null; observed 0 stays 0; totals only under complete coverage" },
      { label: "New fixture", value: "realistic-migration (schema → migrate → reader)" },
    ],
    limitations: [
      "Silent CLIs yield null (correct, but coverage gaps possible).",
      "Free-tier cost 0 must not be read as universal pricing.",
      "Spawn-vs-exec split still opaque by design.",
    ],
    body: [
      {
        kind: "paragraph",
        text: "M28.9 closed the metering gap with the same honesty rules as everything else: the parser handles the exact live envelope, persistence is failure-isolated (a failed usage write cannot fail a task), and aggregation refuses partial sums. The screening harness also gained seeded arm-order shuffle.",
      },
    ],
  },
  {
    id: "m29-screening",
    milestone: "M29.0",
    title: "Controlled workload screening (75 trials)",
    era: "Routing & Execution Strategy",
    categories: ["routing", "benchmarking", "product"],
    status: "completed",
    question: "Where does orchestration warrant further evaluation vs single-agent sufficiency?",
    verdict: "Classes 1–2: single-agent sufficient. Classes 3–5: further evaluation justified. No auto-routing.",
    sampleSize: "5 workloads × 3 arms × 5 repeats; free model; 30 quarantined stall trials re-run versioned",
    keyFigures: [
      { label: "Independent", value: "A 30.1s / B 37.0s, 5/5 both" },
      { label: "Chain", value: "A 41.7s / B 59.3s (B 4/5, one genuine empty contribution)" },
      { label: "Shared-file B", value: "0/5 — real merge conflicts after verified work" },
      { label: "Mixed B", value: "0/5 — designed collision, halted as designed" },
      { label: "Migration", value: "A 37.9s / B 106.9s, 5/5 both (steepest ratio)" },
      { label: "Stub arm", value: "25/25 success-or-designed-halt, ~2s" },
    ],
    limitations: [
      "Provider stall window forced 30 quarantined trials + 30 versioned re-runs; free-tier flakiness is a standing risk.",
      "n=5 screening; synthetic fixtures; one model; usage 0% under default invocation.",
    ],
    body: [
      {
        kind: "paragraph",
        text: "The screening that set the routing agenda: orchestration never beats single-agent on wall time in the tested conditions, but the shared-file classes produce something a stopwatch can't — genuine merge conflicts caught after fully verified work. That differential detection, not speed, is the product question M29.6–M29.7 pursue.",
      },
      {
        kind: "callout",
        tone: "info",
        title: "Reading the 0/5 cells",
        text: "Atlas scoring 0/5 on shared-file and mixed workloads is the system working: tasks verified, then the train halted on real conflicts instead of merging blindly. A single agent serializes these edits implicitly and never faces the conflict at all.",
      },
    ],
  },
  {
    id: "m29-routing",
    milestone: "M29.1–M29.4",
    title: "Routing classifier: shadow, contract, and evidence readiness",
    era: "Routing & Execution Strategy",
    categories: ["routing", "safety"],
    status: "completed",
    question: "Is the routing classifier sufficiently supported to inform human plan approval?",
    verdict: "ADVISORY ONLY: ready for human-informed use, not for automatic enablement.",
    sampleSize: "Pooled n=13/13 independent, 10/10 + 9/10 chains; gates 657→667",
    keyFigures: [
      { label: "Rules", value: "6 stable IDs; fail-closed; SMALL_INDEPENDENT_SET_MAX=3 (PROVISIONAL)" },
      { label: "Independent pooled", value: "A 13/13 med 29.0s / B 13/13 med 35.1s" },
      { label: "Contract", value: "Recommendation + actual + actor + timestamp recorded; no new approval system" },
    ],
    limitations: [
      "Threshold uncalibrated beyond n≤3; necessity of orchestration on chains unproven (single-agent also succeeded).",
      "Automatic routing stays disabled; enablement would need a rollout design that is a product decision.",
    ],
    body: [
      {
        kind: "paragraph",
        text: "Four milestones of restraint: a pure deterministic classifier with evidence-citing reasons, a human-approval contract that reuses the existing approval row instead of inventing a new system, a derived (never flagged) actual-strategy field, and an evidence matrix that marks the ≤3 threshold provisional rather than promoting it. The adoption decision is ADVISORY ONLY by evidence strength, not by danger.",
      },
    ],
  },
  {
    id: "m29-inplace",
    milestone: "M29.5",
    title: "In-place-edit workload and targeted evidence",
    era: "Routing & Execution Strategy",
    categories: ["routing", "benchmarking"],
    status: "inconclusive",
    question: "Does DAG independence without merge independence change any routing conclusion?",
    verdict: "Fixture valid by stub proof; real-provider merge behavior UNMEASURED (stall pre-empted both attempts).",
    sampleSize: "Stub 2/2 INTEGRATED; real A 2/3 valid; real B 0/6 (all stall TIMEOUTs)",
    keyFigures: [
      { label: "Stub proof", value: "2/2 VERIFIED + INTEGRATED (disjoint-line merge works)" },
      { label: "Real A", value: "2/3 (36.1s, 32.1s + 1 stall TIMEOUT)" },
      { label: "Real B", value: "0/6 across two windows (all provider TIMEOUTs)" },
    ],
    limitations: [
      "Two provider-stall windows in one day; v1 strict-suite flaw quarantined as fixture-design invalid.",
      "KEEP CURRENT ADVISORY RULES: nothing contradicted, nothing graduated.",
    ],
    body: [
      {
        kind: "paragraph",
        text: "M29.5's sharpest lesson is methodological: the strict test suite rejected every task at verification by construction, which looked like a merge finding until stub determinism proved it was fixture design. The lenient-suite fix was verified across all three states before any real-provider claim was drawn — and then the provider stalled twice, leaving real merge behavior unmeasured but the fixture ready.",
      },
    ],
  },
  {
    id: "m29-product",
    milestone: "M29.6",
    title: "Product-value audit",
    era: "Product Viability",
    categories: ["product", "safety"],
    status: "completed",
    question: "Does Atlas provide measurable value a strong single agent does not?",
    verdict: "Position B (narrowed): safety-first execution control plane — parity-plus-overhead today, differentiation unproven.",
    sampleSize: "Evidence synthesis; no new trials",
    keyFigures: [
      { label: "Position", value: "B, narrowed: audited, recoverable, integration-gated execution" },
      { label: "Scorecard", value: "Parity-plus-overhead; no Atlas-only positive outcome yet" },
      { label: "Next validation", value: "Real-repo conflict-catch trial (falsifiable) or customer discovery" },
    ],
    limitations: [
      "No customer or demand evidence exists anywhere in the program.",
      "Atlas costs more human attention today (plan + merge approvals) for equal quality.",
    ],
    body: [
      {
        kind: "paragraph",
        text: "The audit refuses both hype and despair: the control-plane properties are real and verified in source, but no workload class shows an Atlas-only positive outcome, the single agent is faster everywhere measured, and continued engineering without a decision-changing experiment is explicitly not recommended. Its single proposed next step is the conflict-catch trial — or stopping to talk to users.",
      },
      {
        kind: "callout",
        tone: "honest",
        title: "The uncomfortable finding",
        text: "Human review burden and setup complexity are NEGATIVE SIGNALs: Atlas currently costs more operator attention than the single-agent workflow it seeks to improve on. Any product future must either reduce that burden or prove the safety properties are worth it.",
      },
    ],
  },
];

export const CATEGORY_LABELS: Record<ExperimentCategory, string> = {
  performance: "Performance",
  reliability: "Reliability",
  safety: "Safety",
  architecture: "Architecture",
  routing: "Routing",
  benchmarking: "Benchmarking",
  product: "Product validation",
};

export function experimentById(id: string): Experiment | undefined {
  return EXPERIMENTS.find((e) => e.id === id);
}
