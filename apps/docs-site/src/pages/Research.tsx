import { useMemo, useState } from "react";
import { FlaskConical } from "lucide-react";
import { EXPERIMENTS, CATEGORY_LABELS, ERAS, type ExperimentCategory, type ExperimentStatus } from "../content/experiments.js";
import { cn } from "../components/cn.js";

const FILTERS: Array<"all" | ExperimentCategory> = [
  "all",
  "performance",
  "reliability",
  "safety",
  "architecture",
  "routing",
  "benchmarking",
  "product",
];

const STATUS_LABEL: Record<ExperimentStatus, string> = {
  completed: "Completed",
  screening: "Screening",
  "design-only": "Design only",
  inconclusive: "Inconclusive",
};

const STATUS_STYLE: Record<ExperimentStatus, string> = {
  completed: "border-ok-500/30 text-ok-400",
  screening: "border-accent-500/30 text-accent-400",
  "design-only": "border-graphite-700 text-ink-300",
  inconclusive: "border-warn-500/30 text-warn-text",
};

export function ResearchIndex({ compact = false }: { compact?: boolean }): React.ReactElement {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("all");
  const [query, setQuery] = useState("");
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return EXPERIMENTS.filter(
      (e) =>
        (filter === "all" || e.categories.includes(filter)) &&
        (q === "" ||
          `${e.milestone} ${e.title} ${e.question} ${e.verdict}`.toLowerCase().includes(q)),
    );
  }, [filter, query]);
  return (
    <div>
      {!compact && (
        <>
          <p className="micro-label text-research-400">Research &amp; experiments</p>
          <h1 className="display-title mt-2">Built in the open. Tested against evidence.</h1>
          <p className="mt-2 max-w-2xl text-ink-300">
            Atlas documents what worked, what failed, and what the experiments could not establish — including
            negative results and quarantined trials.
          </p>
        </>
      )}
      <div className="mt-6 flex flex-col gap-3">
        <input
          type="search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
          }}
          placeholder="Filter by milestone, title, or question…"
          aria-label="Filter experiments"
          className="w-full rounded-md border border-graphite-800 bg-graphite-900 px-3 py-2 text-sm outline-none placeholder:text-ink-600 focus:border-accent-500 sm:max-w-md"
        />
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by category">
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={filter === f}
              onClick={() => {
                setFilter(f);
              }}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs transition-colors",
                filter === f ? "bg-graphite-800 text-ink-100" : "text-ink-300 hover:bg-graphite-900 hover:text-ink-100",
              )}
            >
              {f === "all" ? "All" : CATEGORY_LABELS[f]}
            </button>
          ))}
        </div>
      </div>
      <p className="mt-4 text-[13px] text-ink-500" role="status">
        Showing {visible.length} of {EXPERIMENTS.length} experiments.
      </p>
      <div className="mt-3 flex flex-col gap-3">
        {visible.length === 0 && (
          <p className="rounded-lg border border-dashed border-graphite-700 p-6 text-sm text-ink-300">
            No experiments match. Clear the filter or try a milestone like “M29”.
          </p>
        )}
        {visible.map((e) => (
          <a
            key={e.id}
            href={`#/research/${e.id}`}
            className="group rounded-lg border border-graphite-800 bg-graphite-900 px-5 py-4 transition-colors hover:border-graphite-700"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="flex items-center gap-1.5 font-mono text-xs text-research-400">
                <FlaskConical size={13} aria-hidden /> {e.milestone}
              </span>
              <span className={cn("rounded-full border px-2 py-px text-xs", STATUS_STYLE[e.status])}>
                {STATUS_LABEL[e.status]}
              </span>
              <span className="text-xs text-ink-500">{e.era}</span>
              <span className="ml-auto text-xs text-ink-600">{e.sampleSize}</span>
            </div>
            <p className="mt-1.5 text-[15px] font-semibold text-ink-100 group-hover:underline">{e.title}</p>
            <p className="mt-1 text-sm text-ink-500">{e.question}</p>
            <p className="mt-1.5 text-sm text-ink-300">{e.verdict}</p>
          </a>
        ))}
      </div>
    </div>
  );
}

export function ExperimentCard({ id }: { id: string }): React.ReactElement {
  const exp = EXPERIMENTS.find((e) => e.id === id);
  if (exp === undefined) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-16 sm:px-6">
        <h1 className="display-title">Experiment not found</h1>
        <p className="mt-2 text-ink-300">
          <a href="#/research" className="text-accent-400 hover:underline">Back to the archive</a>.
        </p>
      </div>
    );
  }
  const index = EXPERIMENTS.findIndex((e) => e.id === id);
  const prev = EXPERIMENTS[index - 1];
  const next = EXPERIMENTS[index + 1];
  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6">
      <nav aria-label="Breadcrumb">
        <ol className="flex flex-wrap items-center gap-1.5 text-[13px] text-ink-500">
          <li><a href="#/research" className="hover:text-ink-100">Research</a></li>
          <li aria-hidden className="text-ink-600">/</li>
          <li aria-current="page" className="text-ink-300">{exp.milestone}</li>
        </ol>
      </nav>
      <p className="micro-label mt-4 text-research-400">{exp.milestone} · {exp.era}</p>
      <h1 className="display-title mt-2">{exp.title}</h1>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className={cn("rounded-full border px-2 py-px text-xs", STATUS_STYLE[exp.status])}>
          {STATUS_LABEL[exp.status]}
        </span>
        {exp.categories.map((c) => (
          <span key={c} className="rounded-full border border-graphite-700 px-2 py-px text-xs text-ink-300">
            {CATEGORY_LABELS[c]}
          </span>
        ))}
      </div>
      <div className="mt-6 rounded-lg border border-graphite-800 bg-graphite-900 px-5 py-4">
        <p className="micro-label text-ink-500">Research question</p>
        <p className="mt-1 text-[15px] text-ink-100">{exp.question}</p>
        <p className="micro-label mt-4 text-ink-500">Final verdict</p>
        <p className="mt-1 text-[15px] text-ink-100">{exp.verdict}</p>
        <p className="micro-label mt-4 text-ink-500">Sample size</p>
        <p className="tnum mt-1 text-sm text-ink-300">{exp.sampleSize}</p>
      </div>
      {exp.keyFigures.length > 0 && (
        <div className="mt-6">
          <h2 className="micro-label text-ink-500">Key figures</h2>
          <dl className="mt-2 grid gap-2 sm:grid-cols-2">
            {exp.keyFigures.map((f) => (
              <div key={f.label} className="rounded-lg border border-graphite-800 bg-graphite-900 px-4 py-3">
                <dt className="text-xs text-ink-500">{f.label}</dt>
                <dd className="tnum mt-0.5 font-mono text-sm text-ink-100">{f.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      <div className="prose-atlas mt-6">
        {exp.body.map((block, i) => {
          if (block.kind === "paragraph") {
            return <p key={i}>{block.text}</p>;
          }
          if (block.kind === "list") {
            return (
              <ul key={i}>
                {block.items.map((item, j) => (
                  <li key={j}>{item}</li>
                ))}
              </ul>
            );
          }
          if (block.kind === "table") {
            return (
              <div key={i} className="overflow-x-auto">
                <table>
                  <thead>
                    <tr>
                      {block.head.map((h, j) => (
                        <th key={j} scope="col">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, j) => (
                      <tr key={j}>
                        {row.map((cell, k) => (
                          <td key={k}>{cell}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          }
          return (
            <div
              key={i}
              role="note"
              className={
                block.tone === "honest"
                  ? "my-4 rounded-lg border border-research-500/40 bg-research-dim px-4 py-3"
                  : block.tone === "warn"
                    ? "my-4 rounded-lg border border-warn-500/40 bg-warn-500/10 px-4 py-3"
                    : "my-4 rounded-lg border border-accent-500/40 bg-accent-dim px-4 py-3"
              }
            >
              <p className="text-[13px] font-semibold text-ink-100">{block.title}</p>
              <p className="mt-1 text-sm text-ink-100">{block.text}</p>
            </div>
          );
        })}
      </div>
      {exp.limitations.length > 0 && (
        <div className="mt-6 rounded-lg border border-warn-500/40 bg-warn-500/10 px-5 py-4">
          <h2 className="micro-label text-warn-text">Limitations</h2>
          <ul className="mt-2 flex flex-col gap-1.5 text-sm text-ink-100">
            {exp.limitations.map((l, i) => (
              <li key={i}>• {l}</li>
            ))}
          </ul>
        </div>
      )}
      <nav aria-label="Experiments" className="mt-10 grid gap-3 border-t border-graphite-800 pt-6 sm:grid-cols-2">
        {prev !== undefined ? (
          <a href={`#/research/${prev.id}`} className="rounded-lg border border-graphite-800 bg-graphite-900 px-4 py-3 transition-colors hover:border-graphite-700">
            <span className="micro-label text-ink-500">← Previous</span>
            <span className="mt-0.5 block text-sm font-medium text-ink-100">{prev.milestone}: {prev.title}</span>
          </a>
        ) : <span />}
        {next !== undefined ? (
          <a href={`#/research/${next.id}`} className="rounded-lg border border-graphite-800 bg-graphite-900 px-4 py-3 text-right transition-colors hover:border-graphite-700">
            <span className="micro-label text-ink-500">Next →</span>
            <span className="mt-0.5 block text-sm font-medium text-ink-100">{next.milestone}: {next.title}</span>
          </a>
        ) : <span />}
      </nav>
    </div>
  );
}

export function TimelinePage(): React.ReactElement {
  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6">
      <p className="micro-label text-research-400">Engineering timeline</p>
      <h1 className="display-title mt-2">How Atlas evolved, decision by decision.</h1>
      <p className="mt-2 max-w-2xl text-ink-300">
        Milestone order follows the repository record. Dates are not shown — the repository does not record
        authoritative per-milestone dates, and this archive does not invent them.
      </p>
      <ol className="relative mt-8 flex flex-col gap-0 border-l border-graphite-800 pl-0">
        {ERAS.map((era) => {
          const items = EXPERIMENTS.filter((e) => e.era === era);
          if (items.length === 0) {
            return null;
          }
          return (
            <li key={era} className="relative pb-8 pl-6">
              <span aria-hidden className="absolute -left-[5px] top-1.5 h-2.5 w-2.5 rounded-full bg-research-500" />
              <p className="micro-label text-research-400">{era}</p>
              <ul className="mt-2 flex flex-col gap-2">
                {items.map((e) => (
                  <li key={e.id}>
                    <a
                      href={`#/research/${e.id}`}
                      className="group block rounded-lg border border-graphite-800 bg-graphite-900 px-4 py-3 transition-colors hover:border-graphite-700"
                    >
                      <span className="font-mono text-xs text-research-400">{e.milestone}</span>
                      <span className="mt-0.5 block text-sm font-semibold text-ink-100 group-hover:underline">{e.title}</span>
                      <span className="mt-0.5 block text-[13px] text-ink-500">{e.verdict}</span>
                    </a>
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
