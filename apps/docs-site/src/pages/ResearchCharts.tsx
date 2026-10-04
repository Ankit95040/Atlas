import { useState } from "react";
import { cn } from "../components/cn.js";

// All figures verified from M28.6/M29.0 reports. Sample sizes shown
// beside every bar; stub cells excluded from agent comparisons.

type ArmDatum = { label: string; median: number; min: number; max: number; n: string; ok: string };

const LATENCY_SETS: Record<string, { title: string; note: string; arms: ArmDatum[] }> = {
  independent: {
    title: "Independent tasks — wall-clock medians",
    note: "n=5 per cell · one free model · synthetic fixtures",
    arms: [
      { label: "Single agent", median: 30.1, min: 23, max: 38, n: "n=5", ok: "5/5 verified" },
      { label: "Atlas", median: 37.0, min: 33, max: 41, n: "n=5", ok: "5/5 verified" },
    ],
  },
  chain: {
    title: "Sequential chain — wall-clock medians",
    note: "n=5 per cell · one free model · synthetic fixtures",
    arms: [
      { label: "Single agent", median: 41.7, min: 33, max: 85, n: "n=5", ok: "5/5 verified" },
      { label: "Atlas", median: 59.3, min: 48, max: 66, n: "n=5", ok: "4/5 (1 genuine empty contribution)" },
    ],
  },
  migration: {
    title: "Migration chain — wall-clock medians",
    note: "n=5 per cell · one free model · 3 sequential agent calls + train",
    arms: [
      { label: "Single agent", median: 37.9, min: 30, max: 60, n: "n=5", ok: "5/5 verified" },
      { label: "Atlas", median: 106.9, min: 95, max: 133, n: "n=5", ok: "5/5 verified" },
    ],
  },
};

function LatencyChart({ setKey }: { setKey: keyof typeof LATENCY_SETS }): React.ReactElement {
  const set = LATENCY_SETS[setKey] as { title: string; note: string; arms: ArmDatum[] };
  const max = Math.max(...set.arms.map((a) => a.max));
  return (
    <figure className="overflow-hidden rounded-lg border border-graphite-800 bg-graphite-900">
      <figcaption className="border-b border-graphite-800 px-4 py-2.5">
        <p className="text-sm font-semibold text-ink-100">{set.title}</p>
        <p className="mt-0.5 font-mono text-[11px] text-ink-500">{set.note}</p>
      </figcaption>
      <div className="flex flex-col gap-4 px-4 py-4" role="img" aria-label={`${set.title}. ${set.arms.map((a) => `${a.label}: median ${a.median}s, range ${a.min} to ${a.max}s, ${a.ok}`).join(". ")}`}>
        {set.arms.map((arm, i) => (
          <div key={arm.label}>
            <div className="flex items-baseline justify-between gap-2 text-[13px]">
              <span className={i === 0 ? "text-ink-300" : "font-medium text-ink-100"}>{arm.label}</span>
              <span className="tnum font-mono text-xs text-ink-500">
                med {arm.median}s · {arm.min}–{arm.max}s · {arm.n} · {arm.ok}
              </span>
            </div>
            <div className="relative mt-1.5 h-7 rounded bg-graphite-800" aria-hidden>
              <div
                className={cn("absolute inset-y-0 left-0 rounded", i === 0 ? "bg-ink-600" : "bg-accent-500")}
                style={{ width: `${Math.max(4, (arm.median / max) * 100)}%` }}
              />
              <div
                className="absolute inset-y-0 rounded border border-ink-500/40"
                style={{ left: `${(arm.min / max) * 100}%`, width: `${Math.max(1.5, ((arm.max - arm.min) / max) * 100)}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </figure>
  );
}

const SUCCESS_ROWS = [
  { cell: "Independent A / B", result: "5/5 · 5/5", note: "Parity; +7s Atlas overhead" },
  { cell: "Chain A / B", result: "5/5 · 4/5", note: "One genuine empty contribution (B)" },
  { cell: "Shared-file B", result: "0/5", note: "Genuine conflicts — correct halts" },
  { cell: "Mixed B", result: "0/5", note: "Designed collision — halted as designed" },
  { cell: "Migration A / B", result: "5/5 · 5/5", note: "Steepest overhead ratio" },
  { cell: "Stub arm (25 trials)", result: "15 success + 10 designed-halt", note: "Harness overhead ≈2s" },
];

export function ResearchCharts(): React.ReactElement {
  const [tab, setTab] = useState<keyof typeof LATENCY_SETS>("independent");
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Workload class">
        {(Object.keys(LATENCY_SETS) as Array<keyof typeof LATENCY_SETS>).map((k) => (
          <button
            key={k}
            type="button"
            aria-pressed={tab === k}
            onClick={() => {
              setTab(k);
            }}
            className={cn(
              "rounded-md px-2.5 py-1 text-xs capitalize transition-colors",
              tab === k ? "bg-graphite-800 text-ink-100" : "text-ink-300 hover:bg-graphite-900 hover:text-ink-100",
            )}
          >
            {k === "chain" ? "Sequential" : k}
          </button>
        ))}
      </div>
      <LatencyChart setKey={tab} />
      <figure className="overflow-hidden rounded-lg border border-graphite-800 bg-graphite-900">
        <figcaption className="border-b border-graphite-800 px-4 py-2.5">
          <p className="text-sm font-semibold text-ink-100">M29.0 screening — verified success by cell</p>
          <p className="mt-0.5 font-mono text-[11px] text-ink-500">n=5 per cell · 0/5 on conflict classes = correct halts, not failures</p>
        </figcaption>
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left">
                <th scope="col" className="micro-label px-4 py-2 text-ink-500">Cell</th>
                <th scope="col" className="micro-label px-4 py-2 text-ink-500">Result</th>
                <th scope="col" className="micro-label px-4 py-2 text-ink-500">Reading</th>
              </tr>
            </thead>
            <tbody>
              {SUCCESS_ROWS.map((row) => (
                <tr key={row.cell} className="border-t border-graphite-800">
                  <td className="px-4 py-2 text-ink-100">{row.cell}</td>
                  <td className="tnum px-4 py-2 font-mono text-xs text-ink-300">{row.result}</td>
                  <td className="px-4 py-2 text-ink-500">{row.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </figure>
    </div>
  );
}
