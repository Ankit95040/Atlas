import { useState } from "react";

// Mission-control wall: the hero centerpiece for direction A.
//
// A single layered SVG composition of Atlas as an engineering control
// plane: human authorization at the top boundary, an orchestration core
// fanning into three isolated worker cells, verification gates below each
// cell, an ordered merge train, and a human approval boundary at the base.
// Illustrative structure only — nothing fetches, polls, or implies live
// data (caption + sr-only description say so explicitly).
//
// Depth comes from three explicit layers: a faint blueprint grid
// (decorative, aria-hidden), connection traces, and raised cells with
// 1px borders. Motion is meaningful-only: focusing or selecting a worker
// traces its full vertical path (spine → cell → gate → train slot); the
// selected path pulses via CSS, stilled by the global reduced-motion rule.
// Below `sm`, an equivalent stepped list carries the same content.

type WorkerState = "verified" | "verifying" | "queued";

const WORKERS: Array<{
  id: string;
  name: string;
  task: string;
  claim: string;
  state: WorkerState;
  detail: string;
}> = [
  {
    id: "w1",
    name: "worker-01",
    task: "auth login",
    claim: "src/auth/**",
    state: "verified",
    detail: "Isolated worktree, Atlas-run suite cited as evidence, integrated as train item one.",
  },
  {
    id: "w2",
    name: "worker-02",
    task: "invoice totals",
    claim: "src/billing/**",
    state: "verifying",
    detail: "Executing now; the gate will cite the Atlas-run test result, never the agent's self-report.",
  },
  {
    id: "w3",
    name: "worker-03",
    task: "retry policy",
    claim: "src/config/**",
    state: "queued",
    detail: "Scheduled but unclaimed — no work begins until the wave assigns it.",
  },
];

const STATE_FILL: Record<WorkerState, string> = {
  verified: "var(--mc-green)",
  verifying: "var(--mc-amber)",
  queued: "var(--mc-dim)",
};

const STATE_TEXT: Record<WorkerState, string> = {
  verified: "VERIFIED",
  verifying: "VERIFYING",
  queued: "QUEUED",
};

// viewBox 0 0 1000 640.
const SPINE_Y = 196;
const CORE_CX = 500;
const CELL_Y = 252;
const CELL_W = 236;
const CELL_H = 132;
const CELL_X: Record<string, number> = { w1: 100, w2: 382, w3: 664 };
const GATE_Y = 452;
const TRAIN_Y = 552;

function cellCenter(id: string): number {
  return (CELL_X[id] ?? 0) + CELL_W / 2;
}

function Mono({
  x,
  y,
  size = 11,
  fill = "var(--mc-sub)",
  anchor = "middle",
  children,
}: {
  x: number;
  y: number;
  size?: number;
  fill?: string;
  anchor?: "middle" | "start";
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <text x={x} y={y} textAnchor={anchor} fontFamily="ui-monospace, 'SF Mono', Menlo, monospace" fontSize={size} fill={fill}>
      {children}
    </text>
  );
}

export function MissionControl(): React.ReactElement {
  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const activeId = hovered ?? selected;
  const active = WORKERS.find((w) => w.id === activeId) ?? null;

  const traceProps = (id: string): { stroke: string; width: number; active: boolean } =>
    activeId === id
      ? { stroke: "var(--mc-blue)", width: 2.5, active: true }
      : { stroke: "var(--mc-trace)", width: 1.5, active: false };

  const activate = (id: string) => ({
    onMouseEnter: () => {
      setHovered(id);
    },
    onMouseLeave: () => {
      setHovered(null);
    },
    onFocus: () => {
      setHovered(id);
    },
    onBlur: () => {
      setHovered(null);
    },
    onClick: () => {
      setSelected((s) => (s === id ? null : id));
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        setSelected((s) => (s === id ? null : id));
      }
    },
  });

  return (
    <div>
      <div className="hidden sm:block">
        <svg
          viewBox="0 0 1000 640"
          role="img"
          aria-label="Atlas control plane: human authorization enters an orchestration core that fans into three isolated worker cells, each passing a verification gate into an ordered merge train ending at a human approval boundary."
          className="mission w-full rounded-xl border border-graphite-800 bg-graphite-925"
        >
          <defs>
            <pattern id="mc-grid" width="40" height="40" patternUnits="userSpaceOnUse">
              <path d="M 40 0 L 0 0 0 40" fill="none" stroke="var(--mc-grid)" strokeWidth="1" />
            </pattern>
          </defs>
          <rect x={0} y={0} width={1000} height={640} fill="url(#mc-grid)" aria-hidden />

          {/* Human authorization boundary (top) */}
          <g>
            <line x1={60} y1={64} x2={940} y2={64} stroke="var(--mc-violet)" strokeWidth={1.5} strokeDasharray="7 6" />
            <Mono x={500} y={46} size={11} fill="var(--mc-violet-soft)">
              human authorization — plan approval · actor-stamped
            </Mono>
            <Mono x={500} y={104} size={11} fill="var(--mc-faint)">
              untrusted proposal → deterministic validation
            </Mono>
          </g>

          {/* Orchestration core */}
          <g>
            <rect x={CORE_CX - 150} y={116} width={300} height={52} rx={10} fill="var(--mc-panel)" stroke="var(--mc-blue)" strokeWidth={2} />
            <circle cx={CORE_CX - 118} cy={142} r={5} fill="var(--mc-blue-soft)" />
            <Mono x={CORE_CX + 14} y={139} anchor="middle" size={12} fill="var(--mc-text)">
              orchestration core
            </Mono>
            <Mono x={CORE_CX + 14} y={156} anchor="middle" size={10} fill="var(--mc-faint)">
              claim-aware schedule · wave 2 of 3
            </Mono>
            {/* fan-out traces */}
            {WORKERS.map((w) => {
              const t = traceProps(w.id);
              const cx = cellCenter(w.id);
              return (
                <g key={`fan-${w.id}`}>
                  <path
                    d={`M ${CORE_CX} ${SPINE_Y - 28} C ${CORE_CX} ${SPINE_Y - 2}, ${cx} ${SPINE_Y - 2}, ${cx} ${SPINE_Y + 24}`}
                    fill="none"
                    stroke={t.stroke}
                    strokeWidth={t.width}
                    className={t.active ? "vision-edge vision-edge-active" : "vision-edge"}
                  />
                  <polygon points={`${cx - 5},${SPINE_Y + 24} ${cx + 5},${SPINE_Y + 24} ${cx},${SPINE_Y + 32}`} fill={t.stroke} />
                </g>
              );
            })}
          </g>

          {/* Worker isolation cells */}
          {WORKERS.map((w) => {
            const x = CELL_X[w.id] ?? 0;
            const isActive = activeId === w.id;
            return (
              <g
                key={w.id}
                tabIndex={0}
                role="button"
                aria-label={`${w.name}: task ${w.task}, claim ${w.claim}, state ${STATE_TEXT[w.state]}. Activate to trace its path.`}
                aria-pressed={selected === w.id}
                style={{ cursor: "pointer", outline: "none" }}
                {...activate(w.id)}
              >
                <rect
                  x={x}
                  y={CELL_Y}
                  width={CELL_W}
                  height={CELL_H}
                  rx={10}
                  fill={isActive ? "var(--mc-raised)" : "var(--mc-surface)"}
                  stroke={isActive ? "var(--mc-blue)" : "var(--mc-line)"}
                  strokeWidth={isActive ? 2 : 1.5}
                />
                <rect x={x} y={CELL_Y} width={CELL_W} height={30} rx={10} fill="none" stroke="none" aria-hidden />
                <Mono x={x + 16} y={CELL_Y + 20} anchor="start" size={10} fill="var(--mc-dim)">
                  isolated worktree · own branch
                </Mono>
                <circle cx={x + 20} cy={CELL_Y + 52} r={5} fill={STATE_FILL[w.state]} />
                <Mono x={x + 34} y={CELL_Y + 56} anchor="start" size={12} fill="var(--mc-text)">
                  {w.name}
                </Mono>
                <Mono x={x + 16} y={CELL_Y + 82} anchor="start" size={11} fill="var(--mc-sub)">
                  {w.task}
                </Mono>
                <Mono x={x + 16} y={CELL_Y + 100} anchor="start" size={10} fill="var(--mc-faint)">
                  {w.claim} · WRITE
                </Mono>
                <Mono x={x + 16} y={CELL_Y + 118} anchor="start" size={10} fill={w.state === "verified" ? "var(--mc-green)" : w.state === "verifying" ? "var(--mc-amber-text)" : "var(--mc-dim)"}>
                  {STATE_TEXT[w.state]}
                </Mono>
              </g>
            );
          })}

          {/* Cell → gate drops */}
          {WORKERS.map((w) => {
            const cx = cellCenter(w.id);
            const t = traceProps(w.id);
            return (
              <line
                key={`drop-${w.id}`}
                x1={cx}
                y1={CELL_Y + CELL_H}
                x2={cx}
                y2={GATE_Y - 16}
                stroke={t.stroke}
                strokeWidth={t.width}
                className={t.active ? "vision-edge vision-edge-active" : "vision-edge"}
              />
            );
          })}

          {/* Verification gates */}
          <g>
            <Mono x={500} y={GATE_Y - 34} size={11} fill="var(--mc-sub)">
              verification gates — Atlas-run tests cite evidence, never self-report
            </Mono>
            {WORKERS.map((w) => {
              const cx = cellCenter(w.id);
              const isActive = activeId === w.id;
              return (
                <g key={`gate-${w.id}`}>
                  <polygon
                    points={`${cx},${GATE_Y - 14} ${cx + 14},${GATE_Y} ${cx},${GATE_Y + 14} ${cx - 14},${GATE_Y}`}
                    fill="var(--mc-panel)"
                    stroke={isActive ? "var(--mc-blue)" : STATE_FILL[w.state]}
                    strokeWidth={2}
                  />
                </g>
              );
            })}
            <line x1={120} y1={GATE_Y} x2={880} y2={GATE_Y} stroke="var(--mc-line)" strokeWidth={1} strokeDasharray="5 5" />
          </g>

          {/* Merge train → approval boundary */}
          <g>
            <Mono x={500} y={TRAIN_Y - 40} size={11} fill="var(--mc-sub)">
              merge train — ordered integration · conflicts halt loudly · main untouched
            </Mono>
            <rect x={110} y={TRAIN_Y - 22} width={560} height={44} rx={8} fill="var(--mc-panel)" stroke="var(--mc-line)" />
            {[0, 1, 2].map((i) => {
              const wid = `w${i + 1}`;
              const isActive = activeId === wid;
              return (
                <g key={`car-${i}`}>
                  <rect
                    x={130 + i * 170}
                    y={TRAIN_Y - 12}
                    width={150}
                    height={24}
                    rx={5}
                    fill={isActive ? "var(--mc-raised)" : "var(--mc-car)"}
                    stroke={isActive ? "var(--mc-blue)" : "var(--mc-dim)"}
                    strokeWidth={1.5}
                  />
                  <Mono x={205 + i * 170} y={TRAIN_Y + 4} size={10} fill="var(--mc-sub)">
                    {`item ${i + 1} · ${i === 0 ? "integrated" : i === 1 ? "verifying" : "queued"}`}
                  </Mono>
                </g>
              );
            })}
            <line x1={670} y1={TRAIN_Y} x2={738} y2={TRAIN_Y} stroke="var(--mc-line)" strokeWidth={1.5} />
            <rect x={738} y={TRAIN_Y - 22} width={152} height={44} rx={8} fill="var(--mc-panel)" stroke="var(--mc-violet)" strokeWidth={2} />
            <Mono x={814} y={TRAIN_Y + 1} size={11} fill="var(--mc-text)">
              human review
            </Mono>
            <Mono x={814} y={TRAIN_Y + 15} size={9} fill="var(--mc-faint)">
              you merge main
            </Mono>
            <line x1={60} y1={TRAIN_Y + 52} x2={940} y2={TRAIN_Y + 52} stroke="var(--mc-violet)" strokeWidth={1.5} strokeDasharray="7 6" />
            <Mono x={500} y={TRAIN_Y + 70} size={11} fill="var(--mc-violet-soft)">
              approval boundary — nothing crosses without a human
            </Mono>
          </g>
        </svg>

        <div className="mt-4 flex flex-col gap-3">
          <ul aria-label="Legend" className="flex flex-wrap gap-x-5 gap-y-1.5 text-xs text-ink-500">
            <li className="flex items-center gap-1.5"><span aria-hidden className="h-2 w-2 rounded-full bg-ok-500" /> verified</li>
            <li className="flex items-center gap-1.5"><span aria-hidden className="h-2 w-2 rounded-full bg-warn-500" /> verifying</li>
            <li className="flex items-center gap-1.5"><span aria-hidden className="h-2 w-2 rounded-full bg-ink-600" /> queued</li>
            <li className="flex items-center gap-1.5"><span aria-hidden className="inline-block h-2 w-4 rounded-full bg-accent-500" /> traced path</li>
          </ul>
          <p role="status" className="min-h-6 text-sm text-ink-300">
            {active !== null ? (
              <>
                <strong className="font-mono text-[13px] font-semibold text-ink-100">{active.name}</strong>
                <span className="text-ink-500"> — </span>
                {active.detail}
              </>
            ) : (
              <span className="text-ink-500">
                Hover or focus a worker cell to trace its path through gates into the train. Architectural illustration — not live data.
              </span>
            )}
          </p>
        </div>
      </div>

      {/* Stepped fallback below sm */}
      <ol className="flex flex-col gap-2 sm:hidden">
        {[
          ["Human authorization", "Plan approval with a recorded actor opens the run."],
          ["Orchestration core", "Claim-aware schedule fans work into isolated cells."],
          ["Isolated workers", "One worktree and branch per task; diffs inspected, never trusted."],
          ["Verification gates", "Atlas-run tests cite evidence, not self-reports."],
          ["Merge train", "Ordered integration; conflicts halt loudly; main untouched."],
          ["Human review", "You merge main yourself at the approval boundary."],
        ].map(([title, text], i) => (
          <li key={title} className="flex gap-3 rounded-lg border border-graphite-800 bg-graphite-900 px-4 py-3">
            <span aria-hidden className="font-mono text-xs text-accent-400">{String(i + 1).padStart(2, "0")}</span>
            <span>
              <span className="block text-sm font-semibold text-ink-100">{title}</span>
              <span className="mt-0.5 block text-[13px] text-ink-500">{text}</span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
