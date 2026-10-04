import { useState } from "react";
import { cn } from "./cn.js";

// "The vision behind Atlas" — custom technical illustration (SVG, no deps).
//
// A static architectural map of the intended system: specification →
// planning → orchestration spine → isolated workers → verification gates
// → ordered merge train → human review boundary. It illustrates structure,
// never live state: nothing here fetches, polls, or implies real data.
//
// Interaction is meaningful-only: hovering or focusing a worker highlights
// its dependency path (spine segment → worker → gate → train car); clicking
// pins the selection and reveals the worker's contract detail below.
// The pulse on the selected path is a CSS animation, so the global
// prefers-reduced-motion rule already stills it. Below `sm` the diagram is
// replaced by an equivalent stepped list (same content, readable type).

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
    task: "t1 · auth login",
    claim: "src/auth/** (WRITE)",
    state: "verified",
    detail: "Executed in an isolated worktree, verified by an Atlas-run suite, integrated as train item 1.",
  },
  {
    id: "w2",
    name: "worker-02",
    task: "t2 · invoice totals",
    claim: "src/billing/** (WRITE)",
    state: "verifying",
    detail: "Executing now; verification will cite the Atlas-run test result, never the agent's self-report.",
  },
  {
    id: "w3",
    name: "worker-03",
    task: "t3 · retry policy",
    claim: "src/config/** (WRITE)",
    state: "queued",
    detail: "Scheduled but unclaimed — no work begins until the wave assigns it.",
  },
];

const STATE_DOT: Record<WorkerState, string> = {
  verified: "fill-ok-500",
  verifying: "fill-warn-500",
  queued: "fill-ink-600",
};

const STATE_LABEL: Record<WorkerState, string> = {
  verified: "verified",
  verifying: "verifying",
  queued: "queued",
};

// Geometry (viewBox 0 0 960 600).
const SPINE_Y = 150;
const SPINE_X0 = 90;
const SPINE_X1 = 870;
const WORKER_Y = 250;
const WORKER_W = 200;
const WORKER_H = 118;
const WORKER_X: Record<string, number> = { w1: 100, w2: 380, w3: 660 };
const GATE_Y = 430;
const TRAIN_Y = 520;

function workerCenter(id: string): number {
  return (WORKER_X[id] ?? 0) + WORKER_W / 2;
}

function NodeLabel({ x, y, lines, accent }: { x: number; y: number; lines: string[]; accent?: boolean }): React.ReactElement {
  return (
    <text
      x={x}
      y={y}
      textAnchor="middle"
      fontFamily="ui-monospace, 'SF Mono', Menlo, monospace"
      fontSize={11}
      fill={accent === true ? "#5b9bff" : "#9aa4b2"}
    >
      {lines.map((line, i) => (
        <tspan key={i} x={x} dy={i === 0 ? 0 : 15}>
          {line}
        </tspan>
      ))}
    </text>
  );
}

export function VisionSection(): React.ReactElement {
  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const activeId = hovered ?? selected;
  const active = WORKERS.find((w) => w.id === activeId) ?? null;

  const edgeClass = (id: string): string =>
    activeId === id ? "vision-edge vision-edge-active" : "vision-edge";

  return (
    <section aria-labelledby="vision-heading" className="border-b border-graphite-800">
      <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:py-24">
        <p className="micro-label text-center text-accent-400">The vision behind Atlas</p>
        <h2 id="vision-heading" className="display-section mx-auto mt-3 max-w-3xl text-center">
          From isolated AI agents to a coordinated engineering system.
        </h2>
        <p className="mx-auto mt-4 max-w-2xl text-center text-[1.02rem] leading-relaxed text-ink-300">
          Atlas began with a simple question: what if AI coding agents could work like a disciplined
          engineering team — not a collection of disconnected chat sessions?
        </p>

        {/* Full system map (sm and up). */}
        <div className="mt-10 hidden sm:block">
          <svg
            viewBox="0 0 960 600"
            role="img"
            aria-label="Atlas system map: human specification flows through planning and a dependency-aware orchestration spine into three isolated workers, then through verification gates into an ordered merge train ending at human review."
            className="w-full rounded-xl border border-graphite-800 bg-graphite-925"
          >
            {/* Specification → planning row */}
            <g>
              <rect x={40} y={52} width={150} height={52} rx={8} fill="#11151c" stroke="#2a313c" />
              <circle cx={66} cy={78} r={5} fill="#5b9bff" />
              <text x={82} y={75} fontFamily="ui-monospace, monospace" fontSize={12} fill="#e8edf3">human</text>
              <text x={82} y={91} fontFamily="ui-monospace, monospace" fontSize={10} fill="#6b7482">specification</text>
              <line x1={190} y1={78} x2={236} y2={78} stroke="#2a313c" strokeWidth={1.5} />
              <polygon points="236,72 248,78 236,84" fill="#4b5260" />
              <rect x={248} y={52} width={170} height={52} rx={8} fill="#11151c" stroke="#2a313c" />
              <text x={333} y={75} textAnchor="middle" fontFamily="ui-monospace, monospace" fontSize={12} fill="#e8edf3">planning</text>
              <text x={333} y={91} textAnchor="middle" fontFamily="ui-monospace, monospace" fontSize={10} fill="#6b7482">decompose · claims</text>
              <line x1={418} y1={78} x2={480} y2={78} stroke="#2a313c" strokeWidth={1.5} />
              <line x1={480} y1={78} x2={480} y2={SPINE_Y} stroke="#2a313c" strokeWidth={1.5} />
              <polygon points="474,144 486,144 480,150" fill="#4b5260" />
            </g>

            {/* Orchestration spine */}
            <g>
              <line x1={SPINE_X0} y1={SPINE_Y} x2={SPINE_X1} y2={SPINE_Y} stroke="#2a313c" strokeWidth={2} />
              <rect x={SPINE_X0 - 4} y={SPINE_Y - 4} width={8} height={8} rx={2} fill="#11151c" stroke="#4b5260" />
              <NodeLabel x={(SPINE_X0 + SPINE_X1) / 2} y={SPINE_Y - 16} lines={["orchestration · dependency-aware schedule"]} accent />
            </g>

            {/* Dependency edges: spine → workers */}
            {WORKERS.map((w) => {
              const cx = workerCenter(w.id);
              const isActive = activeId === w.id;
              return (
                <g key={`edge-${w.id}`}>
                  <line
                    x1={cx}
                    y1={SPINE_Y}
                    x2={cx}
                    y2={WORKER_Y}
                    className={edgeClass(w.id)}
                    stroke={isActive ? "#2f7cf6" : "#3a4356"}
                    strokeWidth={isActive ? 2.5 : 1.5}
                  />
                  <polygon
                    points={`${cx - 5},${WORKER_Y - 2} ${cx + 5},${WORKER_Y - 2} ${cx},${WORKER_Y + 6}`}
                    fill={isActive ? "#2f7cf6" : "#4b5260"}
                  />
                </g>
              );
            })}

            {/* Worker cells (focusable, selectable) */}
            {WORKERS.map((w) => {
              const x = WORKER_X[w.id] ?? 0;
              const isActive = activeId === w.id;
              return (
                <g
                  key={w.id}
                  tabIndex={0}
                  role="button"
                  aria-label={`${w.name}: ${w.task}, claim ${w.claim}, state ${STATE_LABEL[w.state]}. Activate to inspect its contract.`}
                  aria-pressed={selected === w.id}
                  onMouseEnter={() => {
                    setHovered(w.id);
                  }}
                  onMouseLeave={() => {
                    setHovered(null);
                  }}
                  onFocus={() => {
                    setHovered(w.id);
                  }}
                  onBlur={() => {
                    setHovered(null);
                  }}
                  onClick={() => {
                    setSelected((s) => (s === w.id ? null : w.id));
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSelected((s) => (s === w.id ? null : w.id));
                    }
                  }}
                  style={{ cursor: "pointer", outline: "none" }}
                >
                  <rect
                    x={x}
                    y={WORKER_Y}
                    width={WORKER_W}
                    height={WORKER_H}
                    rx={10}
                    fill={isActive ? "#161b24" : "#11151c"}
                    stroke={isActive ? "#2f7cf6" : "#2a313c"}
                    strokeWidth={isActive ? 2 : 1.5}
                  />
                  <circle cx={x + 20} cy={WORKER_Y + 24} r={5} className={STATE_DOT[w.state]} />
                  <text x={x + 32} y={WORKER_Y + 28} fontFamily="ui-monospace, monospace" fontSize={12} fill="#e8edf3">
                    {w.name}
                  </text>
                  <text x={x + 16} y={WORKER_Y + 54} fontFamily="ui-monospace, monospace" fontSize={11} fill="#9aa4b2">
                    {w.task}
                  </text>
                  <text x={x + 16} y={WORKER_Y + 72} fontFamily="ui-monospace, monospace" fontSize={10} fill="#6b7482">
                    {w.claim}
                  </text>
                  <text x={x + 16} y={WORKER_Y + 96} fontFamily="ui-monospace, monospace" fontSize={10} fill={w.state === "verified" ? "#3fb950" : w.state === "verifying" ? "#e2a63d" : "#4b5260"}>
                    isolated worktree · {STATE_LABEL[w.state]}
                  </text>
                </g>
              );
            })}
            <NodeLabel x={480} y={WORKER_Y + WORKER_H + 22} lines={["isolated workers — one worktree, one branch each"]} />

            {/* Worker → gate connectors */}
            {WORKERS.map((w) => {
              const cx = workerCenter(w.id);
              const isActive = activeId === w.id;
              return (
                <line
                  key={`drop-${w.id}`}
                  x1={cx}
                  y1={WORKER_Y + WORKER_H}
                  x2={cx}
                  y2={GATE_Y - 14}
                  className={edgeClass(w.id)}
                  stroke={isActive ? "#2f7cf6" : "#3a4356"}
                  strokeWidth={isActive ? 2.5 : 1.5}
                />
              );
            })}

            {/* Verification gates */}
            <g>
              <NodeLabel x={480} y={GATE_Y - 30} lines={["verification gates — Atlas-run tests cite evidence, never self-report"]} />
              {WORKERS.map((w) => {
                const cx = workerCenter(w.id);
                const isActive = activeId === w.id;
                const gateFill = w.state === "verified" ? "#3fb950" : w.state === "verifying" ? "#d29922" : "#2a313c";
                return (
                  <g key={`gate-${w.id}`}>
                    <polygon
                      points={`${cx},${GATE_Y - 13} ${cx + 13},${GATE_Y} ${cx},${GATE_Y + 13} ${cx - 13},${GATE_Y}`}
                      fill="#11151c"
                      stroke={isActive ? "#2f7cf6" : gateFill}
                      strokeWidth={2}
                    />
                    <text x={cx} y={GATE_Y + 30} textAnchor="middle" fontFamily="ui-monospace, monospace" fontSize={10} fill="#6b7482">
                      {w.id === "w1" ? "VERIFIED" : w.id === "w2" ? "VERIFYING" : "PENDING"}
                    </text>
                  </g>
                );
              })}
              <line x1={120} y1={GATE_Y} x2={840} y2={GATE_Y} stroke="#2a313c" strokeWidth={1} strokeDasharray="5 5" />
            </g>

            {/* Merge train → human review */}
            <g>
              <NodeLabel x={480} y={TRAIN_Y - 44} lines={["merge train — ordered integration, halts on conflict; main is never merged by Atlas"]} />
              <rect x={120} y={TRAIN_Y - 22} width={560} height={44} rx={8} fill="#11151c" stroke="#2a313c" />
              {[0, 1, 2].map((i) => (
                <g key={`car-${i}`}>
                  <rect
                    x={140 + i * 150}
                    y={TRAIN_Y - 12}
                    width={130}
                    height={24}
                    rx={5}
                    fill={activeId === `w${i + 1}` ? "#161b24" : "#1e242e"}
                    stroke={activeId === `w${i + 1}` ? "#2f7cf6" : "#4b5260"}
                    strokeWidth={1.5}
                  />
                  <text x={205 + i * 150} y={TRAIN_Y + 4} textAnchor="middle" fontFamily="ui-monospace, monospace" fontSize={10} fill="#9aa4b2">
                    {`item ${i + 1} · ${i === 0 ? "integrated" : i === 1 ? "verifying" : "queued"}`}
                  </text>
                </g>
              ))}
              <line x1={680} y1={TRAIN_Y} x2={748} y2={TRAIN_Y} stroke="#2a313c" strokeWidth={1.5} />
              <polygon points="748,494 760,520 748,546" fill="none" strokeWidth={0} />
              <rect
                x={760}
                y={TRAIN_Y - 22}
                width={140}
                height={44}
                rx={8}
                fill="#11151c"
                stroke={activeId !== null ? "#2f7cf6" : "#8b5cf6"}
                strokeWidth={2}
              />
              <text x={830} y={TRAIN_Y + 1} textAnchor="middle" fontFamily="ui-monospace, monospace" fontSize={11} fill="#e8edf3">
                human review
              </text>
              <text x={830} y={TRAIN_Y + 15} textAnchor="middle" fontFamily="ui-monospace, monospace" fontSize={9} fill="#6b7482">
                approval boundary
              </text>
            </g>
          </svg>

          {/* Legend + selection detail */}
          <div className="mt-4 flex flex-col gap-3">
            <ul aria-label="Legend" className="flex flex-wrap gap-x-5 gap-y-1.5 text-xs text-ink-500">
              <li className="flex items-center gap-1.5"><span aria-hidden className="h-2 w-2 rounded-full bg-ok-500" /> verified</li>
              <li className="flex items-center gap-1.5"><span aria-hidden className="h-2 w-2 rounded-full bg-warn-500" /> verifying</li>
              <li className="flex items-center gap-1.5"><span aria-hidden className="h-2 w-2 rounded-full bg-ink-600" /> queued</li>
              <li className="flex items-center gap-1.5"><span aria-hidden className="inline-block h-2 w-4 rounded-full bg-accent-500" /> selected path</li>
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
                  Hover or focus a worker to trace its path; select to pin its contract. Architectural illustration — not live data.
                </span>
              )}
            </p>
          </div>
        </div>

        {/* Stepped fallback below sm: same content, readable type. */}
        <ol className="mt-10 flex flex-col gap-2 sm:hidden">
          {[
            ["Human specification", "A feature description enters the system."],
            ["Planning & decomposition", "Validated proposal; tasks with claims and dependencies."],
            ["Dependency-aware execution", "The schedule fans independent work into isolated workers."],
            ["Isolated workers", "One worktree and branch per task; diffs inspected, never trusted."],
            ["Contracts, claims & verification", "Gates cite Atlas-run tests, not self-reports."],
            ["Ordered integration", "Merge train integrates in wave order; conflicts halt loudly."],
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
    </section>
  );
}
