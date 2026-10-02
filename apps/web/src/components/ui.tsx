import { cn } from "./cn.js";

const TONE: Record<string, string> = {
  ok: "text-ok-400 border-ok-500/30",
  bad: "text-bad-500 border-bad-500/30",
  active: "text-accent-400 border-accent-500/30",
  muted: "text-ink-300 border-graphite-700",
};

export function StatusBadge({ status, tone }: { status: string; tone?: keyof typeof TONE }) {
  const resolved =
    tone ??
    (/COMPLETED|VERIFIED|INTEGRATED|PASSED|APPROVED/.test(status)
      ? "ok"
      : /FAILED|REJECTED|CONFLICT|HALTED/.test(status)
        ? "bad"
        : /RUNNING|IN_PROGRESS|VERIFYING|CLAIMED|ASSIGNED/.test(status)
          ? "active"
          : "muted");
  return (
    <span className={cn("inline-block px-2 py-px rounded-full text-xs border whitespace-nowrap", TONE[resolved])}>
      {status}
    </span>
  );
}

export function Eyebrow({ children }: { children: React.ReactNode }) {
  return <p className="text-[11px] uppercase tracking-[1.2px] text-ink-500 mb-1">{children}</p>;
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="border border-dashed border-graphite-700 rounded-md p-5 text-ink-300">
      <p className="font-medium text-ink-100">{title}</p>
      {hint !== undefined && <p className="text-sm mt-1">{hint}</p>}
    </div>
  );
}

export function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="border border-graphite-800 rounded-md px-3 py-2.5 bg-graphite-900">
      <div className="text-[11px] uppercase tracking-wide text-ink-500">{label}</div>
      <div className="text-xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}
