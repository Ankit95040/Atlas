import type { ArticleBlock } from "./article.jsx";
import { CONTACT } from "./site.js";

export const REF_ARTICLES: Record<string, ArticleBlock[]> = {
  troubleshooting: [
    {
      kind: "intro",
      text: "Find what you see, follow the diagnosis, apply the safe resolution. Every entry links to the full guide where one exists.",
    },
    {
      kind: "table",
      head: ["Symptom", "Likely cause", "Diagnosis", "Safe resolution"],
      rows: [
        ["`plan approval not found`", "Wrong or missing approval ID.", "`plan` again; use the printed ID.", "Re-plan; never invent an ID."],
        ["Task stuck in CLAIMED", "Launcher died between claim and execution.", "`diagnose`; check for a live worker.", "`recover task` with actor."],
        ["Task stuck in VERIFICATION", "Rejected work with nowhere to go.", "`show task` for reasons.", "`task transition` to IN_PROGRESS or FAILED."],
        ["IN_PROGRESS, no live worker", "Orphaned execution.", "`history` for the last events.", "Two-hop transition (FAILED, then READY)."],
        ["Train HALTED", "Genuine merge conflict.", "`show run` names the item.", "Resolve in Git yourself; replan on recurrence."],
        ["`NOT_AUTHORIZED`", "No APPROVED execution approval.", "`history` for approval rows.", "Approve with `--approve --actor`."],
        ["`TIMEOUT` on every attempt", "Underspecified task or mismatched model.", "Inspect partial output.", "Re-scope; stop spending budget on repeats."],
        ["`unknown run scope`", "Wrong ID or wrong database.", "Check ID; check `DATABASE_URL` resolution.", "Fix the ID or the env."],
        ["Locked database", "Second launcher or crashed holder.", "`lsof` / process list.", "Kill the holder; never delete the file."],
      ],
    },
  ],
  contributing: [
    {
      kind: "intro",
      text: "Atlas is experimental open-source research software. Contributions that preserve its honesty guarantees are welcome; those that weaken them are not.",
    },
    { kind: "h2", id: "setup", text: "Development setup" },
    {
      kind: "code",
      language: "sh",
      title: "Clone, install, verify",
      code: "git clone https://github.com/Ankit95040/Atlas.git\ncd Atlas\npnpm install\nnpx prisma migrate dev\nnpx prisma generate\nnpm run build\nnode ./dist/cli/run.js doctor",
    },
    { kind: "h2", id: "layout", text: "Repository layout" },
    {
      kind: "p",
      text: "Engine services live in `src/` by domain (`cli`, `core`, `planner`, `dag`, `workers`, `verification`, `git`, `claims`, `orchestrator`, `triage`, `config`, `db`). The React dashboard is `apps/web`; this documentation site is `apps/docs-site`. Reports live in `docs/reports/`; fixtures in `fixtures/`.",
    },
    { kind: "h2", id: "tests", text: "Test commands and expectations" },
    {
      kind: "code",
      language: "sh",
      title: "Verification before a pull request",
      code: "npm run build        # tsc, must be clean\npnpm test          # vitest run, full serial gate\npnpm --filter @atlas/web build  # docs-site: pnpm --filter @atlas/docs-site build",
    },
    {
      kind: "p",
      text: "Tests are required for important behavior. Benchmark and provider-touching suites are labeled; free-tier provider trials are never part of CI. A full gate passes only with zero flakes — rerun isolated failures to diagnose, and distinguish rerun results from the original gate.",
    },
    { kind: "h2", id: "conventions", text: "Coding conventions" },
    {
      kind: "list",
      items: [
        "Strict TypeScript, Zod-validated boundaries, deterministic logic over model judgment.",
        "Additive changes preferred: optional fields, new event types, new commands — never silent rewrites.",
        "Every state change records an actor; every failure classifies structurally.",
        "Never estimate what can stay unknown; missing telemetry stays null, never zero.",
      ],
    },
    { kind: "h2", id: "experiments", text: "How to propose experiments" },
    {
      kind: "p",
      text: "Write the falsification condition first, then the methodology. Use existing harnesses where possible, version reruns separately, quarantine invalid trials explicitly, and report sample sizes beside every claim. See the [Research archive](#/research) for the standard this work is held to.",
    },
  ],
  "security-policy": [
    {
      kind: "intro",
      text: "The full trust model lives in [Security model](/docs/architecture/security). This page is the operational summary: what to protect and how to report problems.",
    },
    { kind: "h2", id: "secrets", text: "Secrets handling" },
    {
      kind: "list",
      items: [
        "Atlas never stores provider secrets; ambient credentials are forwarded allowlist-only.",
        "Do not put secrets in proposals, prompts, claims, task titles, or reasons — all persist to the database.",
        "Agent stdout is captured and bounded; treat it as untrusted bytes.",
      ],
    },
    { kind: "h2", id: "report", text: "Reporting vulnerabilities" },
    {
      kind: "p",
      text: `Do not file public issues for suspected vulnerabilities. Email the maintainers privately with a description, reproduction scope, and affected version — a dedicated security address has not been published yet; use [GitHub Issues](${CONTACT.issuesUrl}) to ask for a private channel. (Project email pending configuration; see \`src/content/site.ts\`.)`,
    },
  ],
  "project-status": [
    {
      kind: "intro",
      text: "Plain accounting of where Atlas stands, what the evidence supports, and what it does not. Updated to reflect the M29.6 product audit.",
    },
    { kind: "h2", id: "status", text: "Experimental status" },
    {
      kind: "p",
      text: "Atlas is experimental. It is a coherent, working control plane with real safety properties — and no validated product-market fit, no customer evidence, and no claim of superiority over single-agent workflows.",
    },
    { kind: "h2", id: "benchmarks", text: "Benchmark findings" },
    {
      kind: "list",
      items: [
        "Verified-success parity with single-agent on tested fixtures (100% both arms where the provider was healthy).",
        "Single agent faster everywhere measured (independent ~30s vs ~37s; migration ~38s vs ~107s medians, n=5, one free model).",
        "Genuine merge conflicts caught after fully verified work on shared-file classes (Atlas 0/5 success = correct halts, not failures).",
        "Scheduler cost 0–2ms/round — closed as an optimization target, permanently.",
      ],
    },
    { kind: "h2", id: "routing", text: "Routing" },
    {
      kind: "p",
      text: "The routing classifier is ADVISORY ONLY: ready for human-informed plan approval, not for automatic enablement. Thresholds are provisional, samples are small, and enablement would need a rollout design that is a product decision.",
    },
    { kind: "h2", id: "limitations", text: "Provider and telemetry limitations" },
    {
      kind: "list",
      items: [
        "Free-tier rate and quota limits are undisclosed; two stall windows were observed in one day during screening.",
        "Token/cost telemetry is null under default invocation; `--format json` yields real counts but needs a behavior-equivalence control before adoption.",
        "No paid-tier behavior, contention profile, or real-repository evidence exists yet.",
      ],
    },
  ],
  contact: [
    {
      kind: "intro",
      text: "Let's build better tools for AI-assisted engineering. Atlas is an experimental open-source project. Technical feedback, contributions, research collaboration, and thoughtful criticism are welcome.",
    },
    { kind: "h2", id: "email", text: "Email" },
    {
      kind: "p",
      text: "A dedicated project email has not been published yet — until it is, [GitHub Issues](https://github.com/Ankit95040/Atlas/issues) is the primary public contact route. For suspected vulnerabilities, ask there for a private channel rather than filing details publicly — see [Security policy](/docs/reference/security-policy).",
    },
    { kind: "h2", id: "bugs", text: "Bug reports and feature requests" },
    {
      kind: "p",
      text: "File issues at [github.com/Ankit95040/Atlas/issues](https://github.com/Ankit95040/Atlas/issues) with the exact command, the full error text, the Atlas version (`atlas --version` equivalent: package version 0.1.0), and — for run failures — the `diagnose` output. Feature requests should state the falsifiable need: what decision would this unblock?",
    },
    { kind: "h2", id: "research", text: "Research collaboration" },
    {
      kind: "p",
      text: "The [Research archive](#/research) documents the full experimental record including negative results. Collaboration on replication, real-repository fixtures, metering, or independent audit of the benchmark claims is explicitly invited — the program's own reports list what would falsify their conclusions.",
    },
  ],
};
