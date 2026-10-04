import { ArrowRight, FlaskConical, GitBranch, ShieldCheck } from "lucide-react";
import { CodeBlock } from "../components/CodeBlock.js";
import { MissionControl } from "../components/MissionControl.js";
import { CONTACT } from "../content/site.js";

const PRINCIPLES: Array<{ n: string; title: string; text: string; evidence: string }> = [
  {
    n: "01",
    title: "Isolation before trust",
    text: "One worktree and branch per worker, created outside the repository root. The provider never chooses where it runs.",
    evidence: "workspace.path ← Workspace record, never provider input",
  },
  {
    n: "02",
    title: "Contracts over labels",
    text: "Tasks declare the exact paths they may write. Anything else fails after the fact, with offending paths named in the evidence.",
    evidence: "CLAIM_VIOLATION · undeclared: src/auth/login.js",
  },
  {
    n: "03",
    title: "Evidence over self-report",
    text: "Verification cites the Atlas-executed test run. A provider claiming success changes nothing until the suite agrees.",
    evidence: "verdict: REJECTED · reason: suite exit 1",
  },
  {
    n: "04",
    title: "Recoverability by construction",
    text: "Stranded assignments and stuck states exit only through narrow, actor-recorded transitions. History is append-only.",
    evidence: "TASK_TRANSITIONED · actor: you · reason: recorded",
  },
  {
    n: "05",
    title: "Human authority at both boundaries",
    text: "Plan approval starts execution; merge approval starts integration. Both are explicit decisions, never defaults.",
    evidence: "approval: APPROVED · --approve-merge required",
  },
];

export function LandingPage(): React.ReactElement {
  return (
    <div>
      {/* 1. HERO — art-directed opening with atmospheric illumination */}
      <section className="hero-atlas border-b border-graphite-800">
        <div className="mx-auto max-w-7xl px-4 pb-14 pt-14 sm:px-6 lg:pb-20 lg:pt-20">
          <p className="micro-label text-accent-400">Atlas · experimental open source · v0.1</p>
          <h1 className="display-hero mt-4 max-w-5xl">
            AI agents can write code. Atlas gives their work{" "}
            <span className="text-accent-400">structure</span>.
          </h1>
          <p className="mt-5 max-w-2xl text-[1.05rem] leading-relaxed text-ink-300">
            Atlas is an experimental control plane for AI coding workers: isolated execution, enforced task
            boundaries, independent verification, and human approval at every consequential step.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <a
              href="#/docs/start/what-is-atlas"
              className="inline-flex items-center gap-1.5 rounded-md bg-accent-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-400"
            >
              Get Started <ArrowRight size={15} aria-hidden />
            </a>
            <a
              href="#/docs/architecture/overview"
              className="inline-flex items-center gap-1.5 rounded-md border border-graphite-700 px-4 py-2 text-sm font-medium text-ink-100 transition-colors hover:bg-graphite-900"
            >
              Explore the Architecture
            </a>
            <a
              href="#/research"
              className="inline-flex items-center gap-1.5 rounded-md border border-graphite-800 px-4 py-2 text-sm font-medium text-ink-300 transition-colors hover:border-graphite-700 hover:text-ink-100"
            >
              <FlaskConical size={15} aria-hidden /> Explore Experiments
            </a>
          </div>
          <div className="mt-10">
            <figure className="mx-auto max-w-6xl">
              <div className="mission-frame">
                <MissionControl />
              </div>
              <figcaption className="mt-3 flex flex-col gap-1 text-[13px] leading-relaxed text-ink-500 sm:flex-row sm:items-baseline sm:gap-3">
                <span className="micro-label shrink-0 text-ink-600">How to read this</span>
                <span>
                  Authorization enters at the top; the core fans work into isolated cells; gates cite
                  evidence; the train integrates in order; nothing crosses the violet boundary without a
                  human. Hover a worker cell to trace its path.
                </span>
              </figcaption>
            </figure>
          </div>
          <dl className="mt-8 grid gap-6 border-t border-graphite-800 pt-6 sm:grid-cols-3">
            {[
              ["Isolated execution", "one worktree per worker"],
              ["Enforced boundaries", "claims reject undeclared writes"],
              ["Human authority", "approval opens and closes every run"],
            ].map(([claim, proof]) => (
              <div key={claim}>
                <dt className="text-[15px] font-semibold text-ink-100">{claim}</dt>
                <dd className="mt-0.5 font-mono text-xs text-ink-500">{proof}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-6 max-w-3xl text-[13px] leading-relaxed text-ink-500">
            Not a productivity claim: benchmark evidence shows verified-success parity with single-agent
            workflows on tested fixtures — not superiority. Atlas is an experiment in making agent work
            auditable, recoverable, and integration-safe.
          </p>
        </div>
      </section>

      {/* 2. WHY ATLAS — editorial origin story (replaces the duplicate
          illustration; MissionControl above is the primary visual). */}
      <section aria-labelledby="why-heading" className="section-ivory border-b border-graphite-800">
        <div className="mx-auto grid max-w-7xl gap-10 px-4 py-16 sm:px-6 lg:grid-cols-[1.1fr_0.9fr] lg:py-24">
          <div className="min-w-0">
            <p className="micro-label text-accent-400">The vision behind Atlas</p>
            <h2 id="why-heading" className="display-section mt-3">
              From isolated AI agents to a coordinated engineering system.
            </h2>
            <p className="mt-4 max-w-xl text-[1.02rem] leading-relaxed text-ink-300">
              Atlas began with a simple question: what if AI coding agents could work like a disciplined
              engineering team — not a collection of disconnected chat sessions?
            </p>
            <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-ink-500">
              A team has structure: someone writes the spec, work splits along contracts, each engineer
              works in their own checkout, review cites test results rather than self-assessment, and
              integration happens in an order somebody chose. Atlas is that structure, enforced by
              software instead of by process documents nobody reads.
            </p>
            <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-ink-500">
              The ambition was never to make agents faster. It was to make their work auditable,
              recoverable, and safe to integrate — so a human can trust the result without re-doing it.
            </p>
          </div>
          <ol className="ledger-card min-w-0 self-start rounded-xl border border-graphite-800 bg-graphite-925 lg:sticky lg:top-24">
            {[
              ["Disconnected sessions", "Each agent holds its own context; nothing is shared or checked."],
              ["Atlas workers", "Isolated worktrees with declared claims on shared files."],
              ["Atlas verification", "One suite, run by Atlas, cited as the verdict's evidence."],
              ["Atlas integration", "Ordered train; conflicts halt with names, not silent overwrites."],
              ["Human authority", "Approval opens the run and closes the merge."],
            ].map(([title, text], i, arr) => (
              <li
                key={title}
                className={`flex gap-4 px-5 py-4 ${i < arr.length - 1 ? "border-b border-graphite-800" : ""}`}
              >
                <span aria-hidden className="mt-0.5 font-mono text-xs text-accent-400">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-ink-100">{title}</span>
                  <span className="mt-0.5 block text-[13px] leading-relaxed text-ink-500">{text}</span>
                </span>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* 3. HOW THE SYSTEM WORKS — editorial asymmetric: sticky intro + run ledger */}
      <section aria-labelledby="how-heading" className="section-cool border-b border-graphite-800 bg-graphite-925">
        <div className="mx-auto grid max-w-7xl gap-10 px-4 py-16 sm:px-6 lg:grid-cols-[0.9fr_1.1fr] lg:py-24">
          <div className="min-w-0 lg:sticky lg:top-24 lg:self-start">
            <p className="micro-label text-ink-500">How the system works</p>
            <h2 id="how-heading" className="display-section mt-3">
              One loop, six gates. Nothing proceeds silently.
            </h2>
            <p className="mt-4 max-w-md text-[15px] leading-relaxed text-ink-300">
              The right column is a run ledger: each row is a stage with the artifact that proves it happened.
              Read top to bottom — that is the order Atlas enforces.
            </p>
            <div className="mt-6 max-w-md">
              <CodeBlock language="sh" title="The loop in one screen">
                {`node ./dist/cli/run.js plan --feature <id> --proposal proposal.json --approve --actor you
node ./dist/cli/run.js run --feature <id> --repository <repo> \\
  --plan-approval <approval> --actor you \\
  --agent opencode --approve-merge`}
              </CodeBlock>
            </div>
          </div>
          <ol className="min-w-0">
            {[
              ["Human specification", "PLAN_CREATED · proposal validated, tasks persisted", "An untrusted feature description becomes tasks, claims, dependencies — or is rejected without writing."],
              ["Planning & approval", "APPROVED · actor: you", "Deterministic validation, then a human decision with a recorded author. No silent defaults."],
              ["Isolated workers", "TASK_ASSIGNED · worktree + branch per task", "Each task executes in its own worktree. Diffs are inspected, never trusted."],
              ["Verification", "VERIFIED · Atlas-run suite cited", "Self-graded output is metadata. The suite's exit code is the verdict's evidence."],
              ["Merge train", "INTEGRATED · per-item re-verified", "Wave order, real merges, conflicts halt with the item named. Main untouched."],
              ["Human review", "train branch waits · you merge", "Atlas never merges main. The boundary holds until you cross it."],
            ].map(([title, artifact, text], i) => (
              <li key={title} className={`flex gap-4 py-5 ${i === 0 ? "border-t" : ""} border-b border-graphite-800`}>
                <span aria-hidden className="mt-1 font-mono text-xs text-accent-400">{String(i + 1).padStart(2, "0")}</span>
                <div className="min-w-0">
                  <h3 className="text-[15px] font-semibold text-ink-100">{title}</h3>
                  <p className="mt-0.5 font-mono text-xs text-ok-400">{artifact}</p>
                  <p className="mt-1.5 text-sm leading-relaxed text-ink-500">{text}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* 4. HONESTY & INVITATION — asymmetric editorial: candid limits + contribution paths */}
      <section aria-labelledby="honesty-heading" className="section-ivory border-b border-graphite-800">
        <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:py-24">
          <p className="micro-label text-research-400">Where we fell short. Where you can help.</p>
          <div className="mt-3 grid gap-12 lg:grid-cols-[1fr_1fr] lg:gap-0">
            <div className="min-w-0 lg:pr-12">
              <h2 id="honesty-heading" className="display-section mt-0">
                Building Atlas taught us what coordination costs.
              </h2>
              <ul className="mt-6 flex flex-col">
                {[
                  "Single-agent execution was faster in every measured comparison.",
                  "Atlas adds orchestration and integration overhead.",
                  "Real-provider experiments encountered stalls and inconsistent availability.",
                  "Product-market fit is unproven.",
                  "We have not established whether conflict prevention and auditability justify the added complexity.",
                ].map((item, i, arr) => (
                  <li
                    key={item}
                    className={`flex gap-3 py-3 text-[15px] leading-relaxed text-ink-300 ${i === 0 ? "border-t" : ""} ${i < arr.length ? "border-b border-graphite-800" : ""}`}
                  >
                    <span aria-hidden className="mt-2 h-1 w-1 shrink-0 rounded-full bg-research-500" />
                    {item}
                  </li>
                ))}
              </ul>
              <a
                href="#/research"
                className="mt-6 inline-flex items-center gap-1.5 text-sm font-medium text-accent-400 hover:underline"
              >
                Read the complete research archive <ArrowRight size={15} aria-hidden />
              </a>
            </div>
            <div className="min-w-0 lg:border-l lg:border-graphite-800 lg:pl-12">
              <h2 className="display-section mt-0">
                Help us find out what is worth building.
              </h2>
              <ol className="mt-6 flex flex-col">
                {[
                  ["Engineering", "Improve worker isolation, verification, recovery, and integration."],
                  ["Research", "Reproduce experiments, challenge benchmark assumptions, and publish independent findings."],
                  ["Product thinking", "Identify real development workflows where coordination provides enough value to justify its complexity."],
                  ["Community", "Report bugs, improve documentation, and challenge our design decisions."],
                ].map(([title, text], i, arr) => (
                  <li
                    key={title}
                    className={`flex gap-4 py-4 ${i === 0 ? "border-t" : ""} ${i < arr.length ? "border-b border-graphite-800" : ""}`}
                  >
                    <span aria-hidden className="mt-1 font-mono text-xs text-accent-400">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <div className="min-w-0">
                      <h3 className="text-[15px] font-semibold text-ink-100">{title}</h3>
                      <p className="mt-1 text-sm leading-relaxed text-ink-500">{text}</p>
                    </div>
                  </li>
                ))}
              </ol>
              <div className="mt-6 flex flex-wrap gap-3">
                <a
                  href="#/docs/reference/contributing"
                  className="inline-flex items-center gap-1.5 rounded-md bg-accent-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-400"
                >
                  Explore the contribution guide <ArrowRight size={15} aria-hidden />
                </a>
                <a
                  href={CONTACT.issuesUrl}
                  className="inline-flex items-center gap-1.5 rounded-md border border-graphite-700 px-4 py-2 text-sm font-medium text-ink-100 transition-colors hover:bg-graphite-900"
                >
                  Discuss Atlas on GitHub <ArrowRight size={15} aria-hidden />
                </a>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 5. ENGINEERING PRINCIPLES — ruled ledger (kept, retitled rhythm) */}
      <section aria-labelledby="principles-heading" className="section-cool border-b border-graphite-800 bg-graphite-925">
        <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:py-24">
          <div className="max-w-2xl">
            <p className="micro-label text-ink-500">Engineering principles</p>
            <h2 id="principles-heading" className="display-section mt-3">
              Five rules the implementation actually enforces.
            </h2>
          </div>
          <ol className="mt-10">
            {PRINCIPLES.map((p, i) => (
              <li
                key={p.n}
                className={`grid gap-2 py-7 sm:grid-cols-[4rem_1fr_1.2fr] sm:gap-6 ${i === 0 ? "border-t" : ""} border-b border-graphite-800`}
              >
                <span aria-hidden className="font-mono text-sm text-accent-400">{p.n}</span>
                <div className="min-w-0">
                  <h3 className="text-lg font-semibold tracking-tight text-ink-100">{p.title}</h3>
                  <p className="mt-1.5 max-w-xl text-[15px] leading-relaxed text-ink-300">{p.text}</p>
                </div>
                <p className="evidence-chip min-w-0 self-start rounded-md border border-graphite-800 bg-graphite-950 px-3.5 py-2.5 font-mono text-xs leading-relaxed text-ink-500 sm:self-center">
                  {p.evidence}
                </p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* 6. OPEN SOURCE / FINAL CTA */}
      <section aria-labelledby="oss-heading" className="section-tint">
        <div className="mx-auto max-w-7xl px-4 py-16 text-center sm:px-6 lg:py-24">
          <GitBranch aria-hidden size={28} className="mx-auto text-accent-400" />
          <h2 id="oss-heading" className="display-section mx-auto mt-5 max-w-2xl">
            Inspect it. Challenge it. Break the claims.
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-[15px] leading-relaxed text-ink-300">
            Atlas is experimental open source. The most valuable contributions preserve the honesty
            guarantees — falsifiable experiments, tighter verification, independent audits of the
            benchmark claims.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <a
              href={CONTACT.githubUrl}
              className="inline-flex items-center gap-1.5 rounded-md bg-accent-500 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-accent-400"
            >
              View on GitHub <ArrowRight size={15} aria-hidden />
            </a>
            <a
              href="#/docs/reference/contributing"
              className="inline-flex items-center gap-1.5 rounded-md border border-graphite-700 px-5 py-2.5 text-sm font-medium text-ink-100 transition-colors hover:bg-graphite-900"
            >
              <ShieldCheck size={15} aria-hidden /> Contributing guide
            </a>
          </div>
          <p className="mx-auto mt-6 max-w-xl text-[13px] leading-relaxed text-ink-500">
            Routing is advisory only; automatic routing is disabled. No customer evidence exists;
            product-market fit is unproven. That honesty is the invitation.
          </p>
        </div>
      </section>
    </div>
  );
}
