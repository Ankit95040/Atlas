import type {
  ClaimData,
  DependencyData,
  EventData,
  OverviewData,
  ProjectSummary,
  TaskDetail,
  TrainData,
  VerificationData,
  WorkerDetail,
} from "./data.js";

// Server-side HTML renderers for the Atlas dashboard (M24.1).
//
// Pure functions: shaped Atlas state in, HTML string out. No client
// JavaScript, no mock data, no UI-only states — every value traces to the
// control plane. Status strings are the Atlas model statuses verbatim.

export function esc(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function short(id: string | null): string {
  return id === null ? "—" : id.slice(0, 8);
}

function statusClass(status: string): string {
  switch (status) {
    case "COMPLETED":
    case "VERIFIED":
    case "INTEGRATED":
    case "PASSED":
    case "APPROVED":
    case "IDLE":
      return "ok";
    case "FAILED":
    case "REJECTED":
    case "CONFLICT":
    case "HALTED":
    case "MERGE_FAILED":
    case "TESTS_FAILED":
    case "VERIFICATION_FAILED":
      return "bad";
    case "RUNNING":
    case "IN_PROGRESS":
    case "VERIFYING":
    case "CLAIMED":
    case "ASSIGNED":
      return "active";
    case "VERIFICATION":
    case "BLOCKED":
    case "PENDING":
    case "READY":
    default:
      return "muted";
  }
}

export function badge(status: string): string {
  return `<span class="badge ${statusClass(status)}">${esc(status)}</span>`;
}

const CSS = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: #0d1117; color: #e6edf3; font: 14px/1.5 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; }
a { color: #58a6ff; text-decoration: none; }
a:hover { text-decoration: underline; }
header { border-bottom: 1px solid #21262d; padding: 12px 20px; display: flex; align-items: baseline; gap: 16px; }
header h1 { font-size: 18px; margin: 0; letter-spacing: 0.5px; }
header .sub { color: #8b949e; font-size: 13px; }
nav { border-bottom: 1px solid #21262d; padding: 0 20px; display: flex; gap: 4px; flex-wrap: wrap; }
nav a { padding: 10px 12px; color: #8b949e; border-bottom: 2px solid transparent; }
nav a.on { color: #e6edf3; border-bottom-color: #1f6feb; }
nav.global { background: #010409; }
nav.global a { font-weight: 600; }
nav.secondary a { font-size: 13px; padding: 7px 10px; }
.timeline { border-left: 2px solid #21262d; margin-left: 8px; padding-left: 16px; }
.timeline li { border-bottom: none; position: relative; padding: 8px 0; }
.timeline li::before { content: ""; position: absolute; left: -22px; top: 14px; width: 8px; height: 8px; border-radius: 50%; background: #30363d; border: 1px solid #8b949e; }
nav a:hover { color: #e6edf3; text-decoration: none; }
main { padding: 20px; max-width: 1200px; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px; margin-bottom: 20px; }
.card { border: 1px solid #21262d; border-radius: 6px; padding: 12px; background: #161b22; }
.card .k { color: #8b949e; font-size: 12px; text-transform: uppercase; letter-spacing: 0.4px; }
.card .v { font-size: 22px; font-weight: 600; }
table { width: 100%; max-width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 13px; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #21262d; vertical-align: top; }
th { color: #8b949e; font-weight: 500; }
code, .mono { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 12.5px; }
.badge { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 12px; border: 1px solid #30363d; white-space: nowrap; }
.badge.ok { color: #3fb950; border-color: #2ea04355; }
.badge.bad { color: #f85149; border-color: #f8514955; }
.badge.active { color: #58a6ff; border-color: #1f6feb55; }
.badge.muted { color: #8b949e; }
.tag { display: inline-block; padding: 1px 8px; border-radius: 4px; font-size: 11px; background: #21262d; color: #8b949e; margin-left: 6px; }
.tag.hist { background: #341a00; color: #d29922; }
h2 { font-size: 16px; margin: 24px 0 12px; }
h2:first-child { margin-top: 0; }
.muted { color: #8b949e; }
.empty { border: 1px dashed #30363d; border-radius: 6px; padding: 20px; color: #8b949e; }
details { border: 1px solid #21262d; border-radius: 6px; padding: 8px 12px; margin-bottom: 8px; background: #161b22; }
summary { cursor: pointer; }
pre { overflow-x: auto; background: #0d1117; padding: 10px; border-radius: 6px; font-size: 12px; }
ul.plain { list-style: none; padding: 0; margin: 0; }
ul.plain li { padding: 6px 0; border-bottom: 1px solid #21262d; }
.cols { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
@media (max-width: 800px) { .cols { grid-template-columns: 1fr; } }
/* M25.3 product polish: primitives, focus, motion restraint, responsiveness. */
.eyebrow { color: #6e7681; font-size: 11px; text-transform: uppercase; letter-spacing: 1.2px; margin: 0 0 4px; }
.panel { border: 1px solid #21262d; border-radius: 6px; padding: 14px 16px; background: #161b22; margin-bottom: 16px; }
.divider { border: none; border-top: 1px solid #21262d; margin: 20px 0; }
.metric { font-variant-numeric: tabular-nums; }
.timestamp { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 12px; color: #8b949e; }
a, button, .btn { transition: background-color 120ms ease, color 120ms ease, border-color 120ms ease; }
a:focus-visible, button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible, summary:focus-visible { outline: 2px solid #1f6feb; outline-offset: 2px; }
td code, td .mono { overflow-wrap: anywhere; }
.btn:hover { border-color: #8b949e; }
button:hover { background: #388bfd; }
button:active { background: #1a7f37; }
nav { overflow-x: auto; white-space: nowrap; }
nav a { flex-shrink: 0; }
.hud { display: flex; flex-wrap: wrap; gap: 10px 22px; align-items: center; border: 1px solid #21262d; border-radius: 6px; padding: 10px 16px; background: #161b22; margin-bottom: 16px; }
.hud .stat { display: flex; flex-direction: column; }
.hud .stat .k { color: #6e7681; font-size: 11px; text-transform: uppercase; letter-spacing: 0.6px; }
.hud .stat .v { font-size: 15px; font-weight: 600; font-variant-numeric: tabular-nums; }
.hero { border: 1px solid #21262d; border-radius: 8px; padding: 20px 22px; background: linear-gradient(180deg, #11161d 0%, #0d1117 100%); margin-bottom: 20px; }
.hero h2 { margin: 0 0 6px; font-size: 20px; }
.hero p { margin: 6px 0 14px; color: #8b949e; max-width: 70ch; }
@media (max-width: 800px) {
  main { padding: 14px; }
  header { padding: 10px 14px; }
  .cards { grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); }
  .hero p { max-width: 100%; }
}
@media (prefers-reduced-motion: reduce) {
  a, button, .btn { transition: none; }
}
svg.deps { width: 100%; height: auto; background: #161b22; border: 1px solid #21262d; border-radius: 6px; }
.err { border: 1px solid #f8514955; background: #3d1113; border-radius: 6px; padding: 20px; }
@keyframes isEnter { from { opacity: 0; } to { opacity: 1; } }
@keyframes isState { 0% { opacity: 0.25; } 100% { opacity: 1; } }
@keyframes isGate { from { opacity: 0.3; } to { opacity: 1; } }
@keyframes isCar { from { opacity: 0; } to { opacity: 1; } }
@keyframes isHalt { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
.is-enter { animation: isEnter 0.3s ease-out 1; }
.is-state { animation: isState 0.2s ease-out 1; }
.is-gate-open { animation: isGate 0.24s ease-out 1; }
.is-gate-shut { animation: isGate 0.3s ease-out 1; }
.is-car-enter { animation: isCar 0.4s ease-out 1; }
.is-halt-pulse { animation: isHalt 0.6s ease-out 1; }
@media (prefers-reduced-motion: reduce) {
  .is-enter, .is-state, .is-gate-open, .is-gate-shut, .is-car-enter, .is-halt-pulse { animation: none !important; }
}
.okbox { border: 1px solid #2ea04355; background: #12261a; border-radius: 6px; padding: 12px 16px; }
form.act { border: 1px solid #21262d; border-radius: 6px; padding: 16px; background: #161b22; max-width: 560px; }
form.act label { display: block; margin: 10px 0 4px; color: #8b949e; font-size: 13px; }
form.act input[type=text], form.act select, form.act textarea { width: 100%; background: #0d1117; color: #e6edf3; border: 1px solid #30363d; border-radius: 6px; padding: 8px 10px; font: inherit; }
form.act .row { display: flex; gap: 10px; margin-top: 16px; }
button, .btn { background: #1f6feb; color: #fff; border: none; border-radius: 6px; padding: 8px 16px; font: inherit; cursor: pointer; text-decoration: none; display: inline-block; }
button.danger { background: #a40e26; }
a.btn { background: #21262d; color: #e6edf3; }
a.btn:hover { text-decoration: none; background: #30363d; }
footer { padding: 12px 20px; color: #6e7681; font-size: 12px; border-top: 1px solid #21262d; }
`;

export type ViewName = "overview" | "tasks" | "workers" | "deps" | "claims" | "verification" | "train" | "events" | "workflow" | "island" | "activity";

export const VIEWS: Array<{ name: ViewName; label: string }> = [
  { name: "overview", label: "Overview" },
  { name: "tasks", label: "Tasks" },
  { name: "workers", label: "Workers" },
  { name: "deps", label: "Dependencies" },
  { name: "workflow", label: "Workflow" },
  { name: "claims", label: "Claims" },
  { name: "verification", label: "Verification" },
  { name: "train", label: "Merge Train" },
  { name: "island", label: "Island" },
  { name: "events", label: "Events" },
  { name: "activity", label: "Activity" },
];

/** Primary run tabs (Island first); everything else stays one click away. */
const PRIMARY_RUN_VIEWS: ViewName[] = ["island", "workflow", "tasks", "workers", "verification", "train", "activity"];

export type GlobalSection = "home" | "runs" | "workers" | "activity" | "run";

export interface LiveOptions {
  /** When set, the page polls itself for live updates (M24.2). */
  readonly runState?: { readonly status: string; readonly terminal: boolean };
}

export interface NoticeOptions {
  readonly kind: "ok" | "err";
  readonly text: string;
}

// Minimal polling client (M24.2) with state-driven transitions (M24.9).
// Refetches the current view and swaps <main>. Before swapping, it snapshots
// data-* hooks (data-task/data-worker/data-gate/data-car/data-halt); after
// swapping it diffs old vs new and queues visual transitions — at most one
// motion at a time, deterministic order, each under 600ms. Failures preserve
// the last rendered state and retry; terminal runs and 404s stop the loop.
// prefers-reduced-motion renders final state instantly with no motion.
// The server stays authoritative: Atlas execution continues normally if the
// browser disappears.
const LIVE_SCRIPT = `
(function () {
  var main = document.querySelector("main[data-run]");
  var badge = document.getElementById("live-indicator");
  var clock = document.getElementById("last-updated");
  var notice = document.getElementById("live-notice");
  if (!main) return;
  var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var queue = [];
  var playing = false;
  function stamp() {
    if (clock) clock.textContent = "Last updated: " + new Date().toLocaleTimeString();
  }
  function setLive(text, cls) {
    if (badge) { badge.textContent = text; badge.className = "badge " + cls; }
  }
  function stop(text, cls) {
    if (window.__atlasPoll) clearInterval(window.__atlasPoll);
    setLive(text, cls);
  }
  function snapshot(root) {
    var tasks = {};
    var workers = {};
    var gates = {};
    var cars = {};
    var nodes = root.querySelectorAll("[data-task]");
    for (var i = 0; i < nodes.length; i++) {
      tasks[nodes[i].getAttribute("data-task")] = nodes[i].getAttribute("data-status") || "";
    }
    var figs = root.querySelectorAll("[data-worker]");
    for (var j = 0; j < figs.length; j++) {
      workers[figs[j].getAttribute("data-worker")] = figs[j].getAttribute("data-wlink") || "";
    }
    var gs = root.querySelectorAll("[data-gate]");
    for (var k = 0; k < gs.length; k++) {
      gates[gs[k].getAttribute("data-gate")] = gs[k].getAttribute("data-verdict") || "";
    }
    var cs = root.querySelectorAll("[data-car]");
    for (var m = 0; m < cs.length; m++) {
      cars[cs[m].getAttribute("data-car")] = true;
    }
    return { tasks: tasks, workers: workers, gates: gates, cars: cars, halt: !!root.querySelector("[data-halt]") };
  }
  var KIND_ORDER = { "worker-entry": 0, state: 1, "gate-open": 2, "gate-shut": 2, car: 3, halt: 4 };
  var KIND_MS = { "worker-entry": 300, state: 200, "gate-open": 240, "gate-shut": 300, car: 400, halt: 600 };
  var KIND_CLS = { "worker-entry": "is-enter", state: "is-state", "gate-open": "is-gate-open", "gate-shut": "is-gate-shut", car: "is-car-enter", halt: "is-halt-pulse" };
  function planTransitions(prev, next) {
    var list = [];
    var w;
    for (w in next.workers) {
      if (!prev.workers[w]) list.push({ kind: "worker-entry", sel: '[data-worker="' + w + '"]' });
    }
    var t;
    for (t in next.tasks) {
      if (prev.tasks[t] !== undefined && prev.tasks[t] !== next.tasks[t]) list.push({ kind: "state", sel: '[data-task="' + t + '"]' });
    }
    var g;
    for (g in next.gates) {
      if (prev.gates[g] !== next.gates[g]) {
        list.push({ kind: next.gates[g] === "VERIFIED" ? "gate-open" : "gate-shut", sel: '[data-gate="' + g + '"]' });
      }
    }
    var c;
    for (c in next.cars) {
      if (!prev.cars[c]) list.push({ kind: "car", sel: '[data-car="' + c + '"]' });
    }
    if (next.halt && !prev.halt) list.push({ kind: "halt", sel: "[data-halt]" });
    list.sort(function (a, b) {
      return KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.sel < b.sel ? -1 : 1);
    });
    return list;
  }
  function playNext() {
    if (playing || queue.length === 0) return;
    playing = true;
    var t = queue.shift();
    var el = document.querySelector(t.sel);
    if (!el) { playing = false; playNext(); return; }
    el.classList.add(KIND_CLS[t.kind]);
    setTimeout(function () { el.classList.remove(KIND_CLS[t.kind]); playing = false; playNext(); }, KIND_MS[t.kind] + 40);
  }
  function tick() {
    fetch(window.location.href, { headers: { "Accept": "text/html" } }).then(function (res) {
      if (res.status === 404) { stop("Run gone", "muted"); if (notice) notice.textContent = "Run not found — stopped refreshing, last known state preserved."; return null; }
      if (!res.ok) throw new Error("http " + res.status);
      return res.text();
    }).then(function (html) {
      if (html === null) return;
      var doc = new DOMParser().parseFromString(html, "text/html");
      var fresh = doc.querySelector("main[data-run]");
      if (!fresh) throw new Error("bad payload");
      var prev = snapshot(main);
      main.innerHTML = fresh.innerHTML;
      main.setAttribute("data-terminal", fresh.getAttribute("data-terminal") || "false");
      if (!reduced) {
        queue = planTransitions(prev, snapshot(main));
        playNext();
      }
      if (notice) notice.textContent = "";
      stamp();
      if (fresh.getAttribute("data-terminal") === "true") { stop("Run finished", "muted"); }
      else { setLive("\\u25CF Live", "active"); }
    }).catch(function () {
      setLive("\\u25CF Live", "muted");
      if (notice) notice.textContent = "Unable to refresh \\u2014 retrying...";
    });
  }
  stamp();
  if (main.getAttribute("data-terminal") === "true") { stop("Run finished", "muted"); return; }
  setLive("\\u25CF Live", "active");
  window.__atlasPoll = setInterval(tick, 2500);
})();
`;

export function layout(
  title: string,
  featureId: string | null,
  active: ViewName | null,
  body: string,
  live?: LiveOptions,
  notice?: NoticeOptions,
  headExtra?: string,
  section?: GlobalSection,
  hudHtml?: string,
): string {
  const runName = featureId === null ? "" : ` · <span class="mono">${esc(short(featureId))}</span>`;
  const liveBar =
    live?.runState === undefined
      ? ""
      : `<div id="livebar" style="display:flex;gap:12px;align-items:center;padding:8px 20px;border-bottom:1px solid #21262d;font-size:13px;"><span id="live-indicator" class="badge ${live.runState.terminal ? "muted" : "active"}">${live.runState.terminal ? "Run finished" : "● Live"}</span><span id="last-updated" class="muted"></span><span id="live-notice" class="muted"></span></div>`;
  const resolvedSection: GlobalSection = section ?? (featureId === null ? "home" : "run");
  const globalNav = `<nav class="global">${(
    [
      ["home", "Home", "/"],
      ["runs", "Runs", "/runs"],
      ["workers", "Workers", "/workers"],
      ["activity", "Activity", "/activity"],
    ] as Array<[GlobalSection, string, string]>
  )
    .map(([name, label, href]) => `<a href="${href}" class="${resolvedSection === name ? "on" : ""}">${label}</a>`)
    .join("")}</nav>`;
  const runTabs = (names: ViewName[]): string =>
    `<nav>${names
      .map((n) => {
        const v = VIEWS.find((entry) => entry.name === n);
        return v === undefined ? "" : `<a href="/run?feature=${esc(featureId ?? "")}&view=${v.name}" class="${active === v.name ? "on" : ""}">${v.label}</a>`;
      })
      .join("")}</nav>`;
  const tabs =
    featureId === null
      ? ""
      : runTabs(PRIMARY_RUN_VIEWS) +
        `<nav class="secondary">${VIEWS.filter((v) => !PRIMARY_RUN_VIEWS.includes(v.name))
          .map((v) => `<a href="/run?feature=${esc(featureId)}&view=${v.name}" class="${active === v.name ? "on" : ""}">${v.label}</a>`)
          .join("")}</nav>`;
  const mainAttrs =
    featureId === null ? "" : ` data-run="${esc(featureId)}" data-terminal="${live?.runState?.terminal === true ? "true" : "false"}"`;
  const script = live?.runState === undefined ? "" : `<script>${LIVE_SCRIPT}</script>`;
  const banner =
    notice === undefined
      ? ""
      : `<div class="${notice.kind === "ok" ? "okbox" : "err"}" style="margin-bottom:16px;">${notice.kind === "ok" ? "✓" : "Action refused:"} ${esc(notice.text)}</div>`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Atlas — ${esc(title)}</title><style>${CSS}</style>${headExtra ?? ""}</head><body><header><h1>Atlas</h1><span class="sub">control-plane dashboard (read-only)${runName}</span></header>${globalNav}${liveBar}${tabs}<main${mainAttrs}>${hudHtml ?? ""}${banner}${body}</main>${script}<footer>Atlas V0.1 dashboard · projection of control-plane state · operator actions require explicit confirmation</footer></body></html>`;
}

/** Project → run hierarchy blocks, shared by landing and home. */
export function projectSections(projects: ProjectSummary[]): string {
  // Hierarchy PROJECT → RUN(S): a project is never a run, so the run is
  // always one explicit click away. Exactly one run ⇒ direct "Open run" link;
  // several runs ⇒ deterministic listing (never a guess).
  return projects
    .map((p) => {
      const runList =
        p.runs.length === 0
          ? `<p class="muted">No runs yet — <code>atlas plan</code> creates the first.</p>`
          : `<table><tr><th>Run</th><th>Status</th><th>Tasks</th><th>Workers</th><th>Verified</th><th>Merges</th><th></th></tr>${p.runs
              .map(
                (r) =>
                  `<tr><td><a href="/run?feature=${esc(r.id)}">${esc(r.title)}</a><br><span class="muted mono">${esc(short(r.id))}</span></td>` +
                  `<td>${badge(r.status)}</td><td>${r.totalTasks}</td><td>${r.workerCount}</td><td>${r.verifiedCount}</td><td>${r.mergeCount}</td>` +
                  `<td><a class="btn" href="/run?feature=${esc(r.id)}">Open run →</a></td></tr>`,
              )
              .join("")}</table>`;
      const direct =
        p.runs.length === 1 && p.runs[0] !== undefined
          ? ` <a class="btn" href="/run?feature=${esc(p.runs[0].id)}">Open run →</a>`
          : "";
      return `<details${p.runs.length === 1 ? " open" : ""}><summary><strong>${esc(p.name)}</strong> <span class="muted mono">${esc(short(p.id))}</span> — ${p.runCount} run(s), ${p.repositoryCount} repositorie(s)${direct}</summary>${runList}</details>`;
    })
    .join("");
}

export function renderLanding(projects: ProjectSummary[]): string {
  if (projects.length === 0) {
    return layout("projects", null, null, `<h2>Projects</h2><div class="empty">No projects yet. Create one with <code>atlas init</code>.</div>`);
  }
  const sections = projectSections(projects);
  return layout("projects", null, null, `<h2>Projects → runs → tasks</h2><p class="muted">A project is a container; a run (feature) is the executable scope. IDs shown are feature/run IDs — project IDs never open a run.</p>${sections}`);
}

export function renderOverview(data: OverviewData, live?: LiveOptions,
  notice?: NoticeOptions,
  hudHtml?: string): string {
  const counts = data.run.taskCounts;
  const active = ["CLAIMED", "IN_PROGRESS", "RUNNING", "VERIFYING", "ASSIGNED"].reduce((n, s) => n + (counts[s] ?? 0), 0);
  const failed = (counts["FAILED"] ?? 0) + (counts["CANCELLED"] ?? 0);
  const completed = (counts["COMPLETED"] ?? 0) + (counts["COMPLETED_EMPTY"] ?? 0);
  const waveGroups =
    data.waves.groups.length === 0
      ? `<div class="empty">No runnable waves. ${esc(data.waves.note)}</div>`
      : data.waves.groups
          .map(
            (g, i) =>
              `<div class="card"><div class="k">Wave ${i + 1}</div><div>${g.tasks.map((t) => `<span class="mono">${esc(short(t))}</span>`).join("<br>")}</div></div>`,
          )
          .join("");
  const body = `
<h2>${esc(data.run.title)} ${badge(data.run.status)}</h2>
<p class="muted">Project ${esc(data.project.name)}${data.repository === null ? "" : ` · repo ${esc(data.repository.name)} (<span class="mono">${esc(data.repository.localPath)}</span>)`} · <span class="mono">${esc(data.run.id)}</span></p>
<div class="cards">
<div class="card"><div class="k">Tasks</div><div class="v">${data.run.totalTasks}</div></div>
<div class="card"><div class="k">Completed</div><div class="v">${completed}</div></div>
<div class="card"><div class="k">Active</div><div class="v">${active}</div></div>
<div class="card"><div class="k">Failed</div><div class="v">${failed}</div></div>
<div class="card"><div class="k">Workers</div><div class="v">${data.workers.length}</div></div>
<div class="card"><div class="k">Verified</div><div class="v">${data.verification.verified}</div></div>
<div class="card"><div class="k">Rejected</div><div class="v">${data.verification.rejected}</div></div>
<div class="card"><div class="k">Merges</div><div class="v">${data.merge.mergeCommits}</div></div>
</div>
<h2>Schedule preview</h2>
<div class="cards">${waveGroups}</div>
<p class="muted">${esc(data.waves.note)}</p>
<h2>Merge summary</h2>
<p>Train branches: ${data.merge.trainBranches.length === 0 ? "none" : data.merge.trainBranches.map((b) => `<span class="mono">${esc(b)}</span>`).join(", ")} · last: ${data.merge.lastStatus === null ? "none" : badge(data.merge.lastStatus)}${data.merge.lastHaltReason === null ? "" : ` — ${esc(data.merge.lastHaltReason)}`}</p>
<h2>Pending approvals</h2>
${data.pendingApprovals.length === 0 ? `<p class="muted">None.</p>` : `<ul class="plain">${data.pendingApprovals.map((a) => `<li><span class="mono">${esc(short(a.id))}</span> ${esc(a.context ?? "approval")} <a class="btn" href="/actions/plan/approve?feature=${esc(data.run.id)}&approval=${esc(a.id)}">Review &amp; approve…</a></li>`).join("")}</ul>`}`;
  return layout(data.run.title, data.run.id, "overview", body, live, notice, hudHtml);
}

export function renderTasks(featureId: string, tasks: TaskDetail[], titles: Map<string, string>, live?: LiveOptions,
  notice?: NoticeOptions,
  hudHtml?: string): string {
  if (tasks.length === 0) {
    return layout("tasks", featureId, "tasks", `<h2>Tasks</h2><div class="empty">No tasks yet. Add them with <code>atlas plan</code>.</div>`, live, notice, hudHtml);
  }
  const rows = tasks
    .map((t) => {
      const deps = t.dependsOn.map((d) => `<span class="mono" title="${esc(titles.get(d) ?? d)}">${esc(short(d))}</span>`).join(", ") || "—";
      const worker =
        t.worker === null
          ? `<span class="muted">unassigned</span>`
          : `<span class="mono">${esc(short(t.worker.id))}</span> ${badge(t.worker.status)}${t.worker.link === "historical" ? `<span class="tag hist">historical</span>` : `<span class="tag">current</span>`}`;
      const detail = `
<details id="task-${esc(t.id)}"><summary>${esc(t.title)} — ${badge(t.status)}</summary>
<p><span class="muted">ID</span> <span class="mono">${esc(t.id)}</span></p>
<p><span class="muted">Depends on</span> ${deps} · <span class="muted">Required by</span> ${t.requiredBy.map((d) => `<span class="mono">${esc(short(d))}</span>`).join(", ") || "—"}</p>
<p><span class="muted">Worker</span> ${worker}</p>
<p><span class="muted">Claims</span> ${t.claims.map((c) => `<code>${esc(c.resourceId)}:${esc(c.access)}</code>`).join(" ") || "—"}</p>
<p><span class="muted">Verification</span> ${t.verdict === null ? "not evaluated" : `${badge(t.verdict)}${t.reasons.length > 0 ? ` — ${esc(t.reasons.join("; "))}` : ""}`}</p>
<p><span class="muted">Test runs</span> ${t.testRuns.map((r) => `${badge(r.status)} exit=${r.exitCode ?? "?"}`).join(" ") || "—"}</p>
<p><span class="muted">Actions</span> <a class="btn" href="/actions/recover?task=${esc(t.id)}">Recover…</a> <a class="btn" href="/actions/transition?task=${esc(t.id)}">Transition…</a></p>
</details>`;
      return detail;
    })
    .join("");
  return layout("tasks", featureId, "tasks", `<p class="eyebrow">Run · Tasks</p><h2>Tasks (${tasks.length})</h2>${rows}`, live, notice, hudHtml);
}

export function renderWorkers(featureId: string, workers: WorkerDetail[], live?: LiveOptions,
  notice?: NoticeOptions,
  hudHtml?: string): string {
  if (workers.length === 0) {
    return layout("workers", featureId, "workers", `<h2>Workers</h2><div class="empty">No workers have been assigned in this run yet.</div>`, live, notice, hudHtml);
  }
  const rows = workers
    .map(
      (w) => `<tr id="worker-${esc(w.id)}"><td class="mono">${esc(short(w.id))}</td><td>${badge(w.status)}</td>
<td>${w.taskId === null ? `<span class="muted">none</span>` : `<span class="mono" title="${esc(w.taskTitle ?? "")}">${esc(short(w.taskId))}</span> <span class="tag${w.link === "historical" ? " hist" : ""}">${esc(w.link)}</span>`}</td>
<td>${w.taskStatus === null ? "—" : badge(w.taskStatus)}</td>
<td class="mono">${esc(w.branch ?? "—")}</td>
<td>${w.testRuns} runs / ${w.failures} failures</td></tr>`,
    )
    .join("");
  return layout(
    "workers",
    featureId,
    "workers",
    `<p class="eyebrow">Run · Workers</p><h2>Workers (${workers.length})</h2><p class="muted">Current = live assignment; historical = released terminal assignment (history preserved in events).</p><table><tr><th>Worker</th><th>Status</th><th>Task</th><th>Task status</th><th>Branch</th><th>Evidence</th></tr>${rows}</table>`,
    live,
    notice,
  );
}

export function layoutLevels(tasks: Array<{ id: string }>, edges: Array<{ from: string; to: string }>): string[][] {
  const depth = new Map<string, number>();
  const idSet = new Set(tasks.map((t) => t.id));
  const visit = (id: string, stack: Set<string>): number => {
    const known = depth.get(id);
    if (known !== undefined) {
      return known;
    }
    if (stack.has(id)) {
      return 0;
    }
    stack.add(id);
    let level = 0;
    for (const edge of edges) {
      if (edge.to === id && idSet.has(edge.from)) {
        level = Math.max(level, visit(edge.from, stack) + 1);
      }
    }
    stack.delete(id);
    depth.set(id, level);
    return level;
  };
  for (const task of tasks) {
    visit(task.id, new Set());
  }
  const maxLevel = Math.max(0, ...[...depth.values()]);
  const levels: string[][] = Array.from({ length: maxLevel + 1 }, () => []);
  for (const [id, level] of depth) {
    const bucket = levels[level];
    if (bucket !== undefined) {
      bucket.push(id);
    }
  }
  for (const bucket of levels) {
    bucket.sort();
  }
  return levels;
}

export function renderDeps(featureId: string, data: DependencyData, live?: LiveOptions,
  notice?: NoticeOptions,
  hudHtml?: string): string {
  if (data.tasks.length === 0) {
    return layout("dependencies", featureId, "deps", `<h2>Dependencies</h2><div class="empty">No tasks, no edges.</div>`, live, notice, hudHtml);
  }
  const statusOf = new Map(data.tasks.map((t) => [t.id, t.status] as const));
  const titleOf = new Map(data.tasks.map((t) => [t.id, t.title] as const));
  const levels = layoutLevels(data.tasks, data.edges);
  const nodeW = 150;
  const nodeH = 44;
  const gapX = 60;
  const gapY = 26;
  const width = Math.max(...levels.map((l) => l.length)) * (nodeW + gapX) + gapX;
  const height = levels.length * (nodeH + gapY) + gapY;
  const pos = new Map<string, { x: number; y: number }>();
  levels.forEach((level, li) => {
    const rowW = level.length * (nodeW + gapX) - gapX;
    const x0 = (width - rowW) / 2;
    level.forEach((id, ni) => {
      pos.set(id, { x: x0 + ni * (nodeW + gapX), y: gapY + li * (nodeH + gapY) });
    });
  });
  const colorOf = (status: string): string =>
    status === "COMPLETED" || status === "COMPLETED_EMPTY" ? "#3fb950" : status === "FAILED" ? "#f85149" : status === "VERIFICATION" || status === "IN_PROGRESS" ? "#58a6ff" : "#8b949e";
  const edgeSvg = data.edges
    .map((e) => {
      const a = pos.get(e.from);
      const b = pos.get(e.to);
      if (a === undefined || b === undefined) {
        return "";
      }
      const x1 = a.x + nodeW / 2;
      const y1 = a.y + nodeH;
      const x2 = b.x + nodeW / 2;
      const y2 = b.y;
      return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#58a6ff" stroke-width="1.5" marker-end="url(#arrow)"/>`;
    })
    .join("");
  const nodeSvg = [...pos.entries()]
    .map(([id, p]) => {
      const status = statusOf.get(id) ?? "?";
      return `<g><rect x="${p.x}" y="${p.y}" width="${nodeW}" height="${nodeH}" rx="6" fill="#161b22" stroke="${colorOf(status)}"/><text x="${p.x + 8}" y="${p.y + 18}" fill="#e6edf3" font-size="11" font-family="monospace">${esc(short(id))}</text><text x="${p.x + 8}" y="${p.y + 33}" fill="#8b949e" font-size="10">${esc(status)}</text><title>${esc(titleOf.get(id) ?? id)}</title></g>`;
    })
    .join("");
  const edgeList =
    data.edges.length === 0
      ? `<p class="muted">No edges — all tasks are independent.</p>`
      : `<ul class="plain">${data.edges.map((e) => `<li><span class="mono">${esc(short(e.from))}</span> ───→ <span class="mono">${esc(short(e.to))}</span></li>`).join("")}</ul>`;
  const body = `<h2>Dependencies (read-only)</h2>
<svg class="deps" viewBox="0 0 ${width} ${height}" role="img" aria-label="task dependency graph"><defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8" fill="none" stroke="#58a6ff" stroke-width="1.5"/></marker></defs>${edgeSvg}${nodeSvg}</svg>
<h2>Edges</h2>${edgeList}`;
  return layout("dependencies", featureId, "deps", body, live, notice, hudHtml);
}

export function renderClaims(featureId: string, data: ClaimData, live?: LiveOptions,
  notice?: NoticeOptions,
  hudHtml?: string): string {
  const perTask =
    data.perTask.length === 0
      ? `<div class="empty">No claims recorded.</div>`
      : data.perTask
          .map(
            (t) => `<details><summary><span class="mono">${esc(short(t.taskId))}</span> ${esc(t.title)} — ${t.claims.length} claim(s)</summary>
<ul class="plain">${t.claims.map((c) => `<li><code>${esc(c.resourceId)}</code> ${badge(c.access)}</li>`).join("") || "<li>none</li>"}</ul></details>`,
          )
          .join("");
  const overlaps =
    data.overlaps.length === 0
      ? `<p><span class="muted">Conflicts:</span> none</p>`
      : `<table><tr><th>Task A</th><th>Task B</th><th>Detail</th></tr>${data.overlaps
          .map((o) => `<tr><td class="mono">${esc(short(o.taskA))}</td><td class="mono">${esc(short(o.taskB))}</td><td><code>${esc(o.details)}</code></td></tr>`)
          .join("")}</table>`;
  return layout("claims", featureId, "claims", `<h2>Claims</h2>${perTask}<h2>Conflicts</h2>${overlaps}`, live, notice, hudHtml);
}

export function renderVerification(featureId: string, data: VerificationData, live?: LiveOptions,
  notice?: NoticeOptions,
  hudHtml?: string): string {
  if (data.total === 0) {
    return layout("verification", featureId, "verification", `<h2>Verification</h2><div class="empty">No tasks to verify yet.</div>`, live, notice, hudHtml);
  }
  const rows = data.findings
    .map(
      (f) => `<details><summary>${esc(f.title)} — ${badge(f.status)} · phase ${esc(f.phase)}${f.verdict === null ? "" : ` · verdict ${badge(f.verdict)}`}</summary>
<p><span class="muted">Task</span> <span class="mono">${esc(f.taskId)}</span></p>
<p>${esc(f.assessment)}${f.errorCode === undefined ? "" : ` <code>${esc(f.errorCode)}</code>`}</p>
${f.reasons.length === 0 ? "" : `<p><span class="muted">Reasons</span> ${esc(f.reasons.join("; "))}</p>`}
<p><span class="muted">Test runs</span> ${f.testRuns.map((r) => `${badge(r.status)} exit=${r.exitCode ?? "?"}`).join(" ") || "—"}</p>
</details>`,
    )
    .join("");
  return layout("verification", featureId, "verification", `<p class="eyebrow">Run · Verification</p><h2>Verification (${data.completed}/${data.total} completed)</h2>${rows}`, live, notice, hudHtml);
}

export function renderTrain(featureId: string, data: TrainData, live?: LiveOptions,
  notice?: NoticeOptions,
  hudHtml?: string): string {
  if (data.branches.length === 0) {
    return layout("train", featureId, "train", `<h2>Merge train</h2><div class="empty">No train branches recorded for this run yet. Read-only: integration happens through <code>atlas run</code>, never here.</div>`, live, notice, hudHtml);
  }
  const branches = data.branches
    .map(
      (b) => `<details open><summary><span class="mono">${esc(b.branch)}</span> ${b.status === null ? "" : badge(b.status)}${b.haltReason === null ? "" : ` — ${esc(b.haltReason)}`}</summary>
<ul class="plain">${b.items
        .map(
          (i) =>
            `<li><span class="mono" title="${esc(i.sha)}">${esc(short(i.taskId))}</span> ${esc(i.title)} ${i.verdict === null ? "" : badge(i.verdict)}<br><span class="muted">${esc(i.subject)}${i.createdAt === null ? "" : ` · ${esc(i.createdAt)}`}</span></li>`,
        )
        .join("")}</ul></details>`,
    )
    .join("");
  return layout("train", featureId, "train", `<p class="eyebrow">Run · Merge train</p><h2>Merge train (read-only — no merge actions here)</h2>${branches}`, live, notice, hudHtml);
}

export function renderEvents(featureId: string, data: EventData, live?: LiveOptions,
  notice?: NoticeOptions,
  hudHtml?: string): string {
  if (data.total === 0) {
    return layout("events", featureId, "events", `<h2>Events</h2><div class="empty">No events recorded for this run yet.</div>`, live, notice, hudHtml);
  }
  const rows = data.events
    .map(
      (e) => `<li><span class="mono">${esc(e.createdAt ?? "?")}</span> <strong>${esc(e.type)}</strong>${
        e.taskId === null ? "" : ` task=<span class="mono">${esc(short(e.taskId))}</span>`
      }${e.actor === null || e.actor.length === 0 ? "" : ` actor=${esc(e.actor)}`}
${e.payload === null || e.payload.length === 0 ? "" : `<details><summary class="muted">payload</summary><pre>${esc(e.payload)}</pre></details>`}</li>`,
    )
    .join("");
  return layout("events", featureId, "events", `<h2>Events (${data.total})</h2><ul class="plain">${rows}</ul>`, live, notice, hudHtml);
}

export function renderNotFound(message: string): string {
  return layout("not found", null, null, `<div class="err"><strong>Not found.</strong> ${esc(message)}</div><p><a href="/">← all projects and runs</a></p>`);
}

export function renderError(message: string): string {
  return layout("error", null, null, `<div class="err"><strong>Something went wrong.</strong> ${esc(message)}</div><p><a href="/">← all projects and runs</a></p>`);
}

export interface RecoverConfirmData {
  readonly taskId: string;
  readonly title: string;
  readonly status: string;
  readonly workerId: string | null;
  readonly workerStatus: string | null;
  readonly recoveryClass: string;
  readonly reason: string;
}

export function renderConfirmRecover(featureId: string, data: RecoverConfirmData): string {
  const body = `<h2>Recover task?</h2>
<p>Task <strong>${esc(data.title)}</strong> (<span class="mono">${esc(data.taskId)}</span>)</p>
<p>Current: ${badge(data.status)} · Worker: ${data.workerId === null ? "none" : `<span class="mono">${esc(short(data.workerId))}</span> ${badge(data.workerStatus ?? "?")}`}</p>
<p>Atlas says: <strong>${esc(data.recoveryClass)}</strong></p>
<p class="muted">${esc(data.reason)}</p>
<p>This will release the current assignment and return the task to READY. The service re-checks eligibility immediately before acting — if anything changed, it refuses safely.</p>
<form class="act" method="post" action="/actions/recover">
<input type="hidden" name="task" value="${esc(data.taskId)}">
<input type="hidden" name="feature" value="${esc(featureId)}">
<label for="actor">Actor (your name — recorded on the event)</label>
<input type="text" id="actor" name="actor" required maxlength="200" autocomplete="off">
<div class="row"><a class="btn" href="/run?feature=${esc(featureId)}&view=tasks">Cancel</a><button type="submit">Recover task</button></div>
</form>`;
  return layout("confirm recovery", featureId, "tasks", body);
}

export interface TransitionConfirmData {
  readonly taskId: string;
  readonly title: string;
  readonly current: string;
  readonly validNext: string[];
}

export function renderConfirmTransition(featureId: string, data: TransitionConfirmData): string {
  const options =
    data.validNext.length === 0
      ? `<p class="muted">No outgoing transitions from ${esc(data.current)} — this task cannot be transitioned.</p>`
      : data.validNext
          .map((s) => `<option value="${esc(s)}">${esc(data.current)} → ${esc(s)}</option>`)
          .join("");
  const body = `<h2>Transition task?</h2>
<p>Task <strong>${esc(data.title)}</strong> (<span class="mono">${esc(data.taskId)}</span>)</p>
<p>Current: ${badge(data.current)}</p>
<p class="muted">Only edges from the existing Atlas state machine are offered. The backend validates the transition again against current state — never trust this form.</p>
<form class="act" method="post" action="/actions/transition">
<input type="hidden" name="task" value="${esc(data.taskId)}">
<input type="hidden" name="feature" value="${esc(featureId)}">
<label for="to">Transition to</label>
<select id="to" name="to" required>${options}</select>
<label for="actor">Actor (your name — recorded on the event)</label>
<input type="text" id="actor" name="actor" required maxlength="200" autocomplete="off">
<label for="reason">Reason (recorded on the TASK_TRANSITIONED event)</label>
<textarea id="reason" name="reason" required maxlength="2000" rows="3"></textarea>
<div class="row"><a class="btn" href="/run?feature=${esc(featureId)}&view=tasks">Cancel</a><button type="submit">Confirm transition</button></div>
</form>`;
  return layout("confirm transition", featureId, "tasks", body);
}

export interface ApproveConfirmData {
  readonly id: string;
  readonly status: string;
  readonly context: string | null;
  readonly note: string | null;
  readonly taskCount: number;
}

export function renderConfirmApprove(featureId: string, data: ApproveConfirmData): string {
  const body = `<h2>Approve plan?</h2>
<p>Approval <span class="mono">${esc(short(data.id))}</span> · status ${badge(data.status)}</p>
<p class="muted">Context: ${esc(data.context ?? "—")} · ${esc(data.note ?? "")}</p>
<p>This approves the persisted plan of <strong>${data.taskCount} task(s)</strong>. Approving does not execute anything — execution still requires an explicit <code>atlas run</code>.</p>
<form class="act" method="post" action="/actions/plan/approve">
<input type="hidden" name="approval" value="${esc(data.id)}">
<input type="hidden" name="feature" value="${esc(featureId)}">
<label for="actor">Actor (your name — recorded on the decision)</label>
<input type="text" id="actor" name="actor" required maxlength="200" autocomplete="off">
<div class="row"><a class="btn" href="/run?feature=${esc(featureId)}&view=overview">Cancel</a><button type="submit">Approve plan</button></div>
</form>`;
  return layout("confirm approval", featureId, "overview", body);
}

export function statusGlyph(status: string): string {
  switch (status) {
    case "COMPLETED":
    case "COMPLETED_EMPTY":
    case "VERIFIED":
    case "INTEGRATED":
    case "PASSED":
      return "✓";
    case "CLAIMED":
    case "IN_PROGRESS":
    case "RUNNING":
    case "VERIFYING":
    case "ASSIGNED":
    case "VERIFICATION":
      return "●";
    case "FAILED":
    case "REJECTED":
    case "CANCELLED":
      return "×";
    default:
      return "○";
  }
}

export function renderWorkflow(
  featureId: string,
  data: import("./data.js").WorkflowGraphData,
  live?: LiveOptions,
  notice?: NoticeOptions,
  hudHtml?: string,
): string {
  if (data.nodes.length === 0) {
    return layout("workflow", featureId, "workflow", `<h2>Workflow</h2><div class="empty">No tasks yet — nothing to lay out. Add them with <code>atlas plan</code>.</div>`, live, notice, hudHtml);
  }
  const statusOf = new Map(data.nodes.map((n) => [n.id, n.status] as const));
  const levels = layoutLevels(
    data.nodes.map((n) => ({ id: n.id })),
    data.edges,
  );
  const nodeW = 200;
  const nodeH = 118;
  const gapX = 70;
  const gapY = 34;
  const bandPad = 30;
  const width = Math.max(...levels.map((l) => l.length)) * (nodeW + gapX) + gapX;
  let y = gapY;
  const pos = new Map<string, { x: number; y: number }>();
  const bandRects: Array<{ y: number; h: number; label: string }> = [];
  levels.forEach((level, li) => {
    const rowW = level.length * (nodeW + gapX) - gapX;
    const x0 = (width - rowW) / 2;
    const top = y;
    level.forEach((id, ni) => {
      pos.set(id, { x: x0 + ni * (nodeW + gapX), y });
    });
    const bandH = nodeH + bandPad * 2;
    bandRects.push({ y: top - bandPad + 8, h: bandH, label: `Level ${li + 1}` });
    y += nodeH + gapY + bandPad;
  });
  const height = y + gapY;
  const colorOf = (status: string): string =>
    status === "COMPLETED" || status === "COMPLETED_EMPTY"
      ? "#3fb950"
      : status === "FAILED"
        ? "#f85149"
        : status === "VERIFICATION" || status === "IN_PROGRESS" || status === "CLAIMED"
          ? "#58a6ff"
          : "#8b949e";
  const edgeSvg = data.edges
    .map((e) => {
      const a = pos.get(e.from);
      const b = pos.get(e.to);
      if (a === undefined || b === undefined) {
        return "";
      }
      const x1 = a.x + nodeW / 2;
      const y1 = a.y + nodeH;
      const x2 = b.x + nodeW / 2;
      const y2 = b.y;
      return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#58a6ff" stroke-width="1.5" marker-end="url(#wfarrow)"/>`;
    })
    .join("");
  const nodeById = new Map(data.nodes.map((n) => [n.id, n] as const));
  const nodeSvg = [...pos.entries()]
    .map(([id, p]) => {
      const node = nodeById.get(id);
      if (node === undefined) {
        return "";
      }
      const status = node.status;
      const title = node.title.length > 24 ? `${node.title.slice(0, 23)}…` : node.title;
      const workerLine =
        node.workerId === null
          ? "unassigned"
          : `${node.workerId.slice(0, 8)}${node.workerLink === "historical" ? " (historical)" : ""}`;
      const metaLine = `${node.wave === null ? "no sched wave" : `wave ${node.wave}`}${node.verdict === null ? "" : ` · ${node.verdict}`}${node.integrated ? " · INTEGRATED" : ""}`;
      return `<g data-task="${esc(id)}" data-status="${esc(status)}"><rect x="${p.x}" y="${p.y}" width="${nodeW}" height="${nodeH}" rx="6" fill="#161b22" stroke="${colorOf(status)}"/>` +
        `<a href="/run?feature=${esc(featureId)}&view=tasks#task-${esc(id)}"><text x="${p.x + 10}" y="${p.y + 22}" fill="#e6edf3" font-size="12" font-weight="bold">${esc(title)}</text><title>${esc(node.title)}</title></a>` +
        `<text x="${p.x + 10}" y="${p.y + 42}" fill="#e6edf3" font-size="11">${esc(statusGlyph(status))} ${esc(status)}</text>` +
        (node.workerId === null
          ? `<text x="${p.x + 10}" y="${p.y + 60}" fill="#8b949e" font-size="10">unassigned</text>`
          : `<a href="/run?feature=${esc(featureId)}&view=workers#worker-${esc(node.workerId)}"><text x="${p.x + 10}" y="${p.y + 60}" fill="#58a6ff" font-size="10">worker ${esc(workerLine)}</text></a>`) +
        `<text x="${p.x + 10}" y="${p.y + 78}" fill="#8b949e" font-size="10">${esc(metaLine)}</text>` +
        `<text x="${p.x + 10}" y="${p.y + 96}" fill="#6e7681" font-size="10">depends: ${node.dependsOn.length === 0 ? "—" : esc(node.dependsOn.map((d) => short(d)).join(", "))}</text></g>`;
    })
    .join("");
  const bandSvg = bandRects
    .map((b) => `<rect x="8" y="${b.y}" width="${width - 16}" height="${b.h}" rx="8" fill="none" stroke="#21262d" stroke-dasharray="5 4"/><text x="18" y="${b.y + 18}" fill="#6e7681" font-size="11">${esc(b.label)}</text>`)
    .join("");
  const pipeline = `<div class="cards">${data.phases
    .map((p) => `<div class="card"><div class="k">${esc(p.name)}</div><div class="v" style="font-size:16px;">${p.active ? "● active" : "○ idle"}</div><div class="muted" style="font-size:12px;">${esc(p.detail)}</div></div>`)
    .join("")}</div>`;
  const haltBanner =
    data.trainHalted !== true
      ? ""
      : `<div class="err">! Merge train halted — ${esc(data.trainHaltReason ?? "see train view")}.</div>`;
  const listRows = nodeTable(featureId, data.nodes);
  const body = `<h2>${esc(data.runTitle)} ${badge(data.runStatus)}</h2>${haltBanner}<h2>Pipeline</h2>${pipeline}
<h2>Workflow graph (read-only)</h2>
<div style="overflow-x:auto;"><svg class="deps" viewBox="0 0 ${width} ${height}" role="img" aria-label="task workflow graph"><defs><marker id="wfarrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8" fill="none" stroke="#58a6ff" stroke-width="1.5"/></marker></defs>${bandSvg}${edgeSvg}${nodeSvg}</svg></div>
<h2>Nodes (text equivalent)</h2>
${listRows}`;
  return layout("workflow", featureId, "workflow", body, live, notice, hudHtml);
}

/** Accessible text equivalent of graph nodes (shared by workflow and island views). */
export function nodeTable(featureId: string, nodes: Array<{ id: string; title: string; status: string; workerId: string | null; workerLink: string; wave: number | null; verdict: string | null; integrated: boolean; dependsOn: string[] }>): string {
  const listRows = nodes
    .map(
      (n) =>
        `<tr><td><a href="/run?feature=${esc(featureId)}&view=tasks#task-${esc(n.id)}">${esc(n.title)}</a><br><span class="muted mono">${esc(short(n.id))}</span></td>` +
        `<td>${esc(statusGlyph(n.status))} ${badge(n.status)}</td>` +
        `<td>${n.workerId === null ? "unassigned" : `<a href="/run?feature=${esc(featureId)}&view=workers#worker-${esc(n.workerId)}" class="mono" title="${esc(n.workerId)}">${esc(short(n.workerId))}</a> (${esc(n.workerLink)})`}</td>` +
        `<td>${n.wave === null ? "—" : `wave ${n.wave}`}</td>` +
        `<td>${n.verdict === null ? "—" : badge(n.verdict)}${n.integrated ? " ✓ integrated" : ""}</td>` +
        `<td>${n.dependsOn.map((d) => `<span class="mono">${esc(short(d))}</span>`).join(", ") || "—"}</td></tr>`,
    )
    .join("");
  return `<table><tr><th>Task</th><th>Status</th><th>Worker</th><th>Wave</th><th>Verification</th><th>Depends on</th></tr>${listRows}</table>`;
}

export function renderHome(
  data: import("./data.js").HomeData,
  projects: ProjectSummary[],
  live?: LiveOptions,
  notice?: NoticeOptions,
): string {
  const m = data.metrics;
  const runRow = (r: import("./data.js").RunSummary): string =>
    `<tr><td><a href="/run?feature=${esc(r.id)}">${esc(r.title)}</a><br><span class="muted mono">${esc(short(r.id))}</span></td>` +
    `<td>${badge(r.status)}</td><td>${r.totalTasks}</td><td>${r.workerCount}</td><td>${r.verifiedCount}</td><td>${r.mergeCount}</td>` +
    `<td><a class="btn" href="/run?feature=${esc(r.id)}&view=island">Open Island →</a></td></tr>`;
  const firstActive = data.activeRuns[0];
  const body =
    `<div class="hero"><p class="eyebrow">Atlas control plane</p><h2>Orchestrate AI coding work with evidence.</h2>` +
    `<p>Atlas decomposes features into claim-scoped tasks, executes them in isolated worktrees, verifies the results, and integrates through an ordered merge train — every step recorded.</p>` +
    (firstActive === undefined
      ? `<p class="muted">No active runs right now.</p>`
      : `<p><strong>${esc(firstActive.title)}</strong> ${badge(firstActive.status)} — ${firstActive.totalTasks} task(s), ${firstActive.workerCount} worker(s). <a class="btn" href="/run?feature=${esc(firstActive.id)}&view=island">Open Island →</a></p>`) +
    `</div>` +
    `<h2>System snapshot</h2>` +
    `<div class="cards">` +
    `<div class="card"><div class="k">Projects</div><div class="v">${m.projects}</div></div>` +
    `<div class="card"><div class="k">Runs</div><div class="v">${m.runs}</div></div>` +
    `<div class="card"><div class="k">Tasks</div><div class="v">${m.tasks}</div></div>` +
    `<div class="card"><div class="k">Live workers</div><div class="v">${m.liveWorkers}</div></div>` +
    `<div class="card"><div class="k">Verified</div><div class="v">${m.verified}</div></div>` +
    `<div class="card"><div class="k">Merges</div><div class="v">${m.merges}</div></div>` +
    `</div>` +
    `<h2>Active runs</h2>` +
    (data.activeRuns.length === 0
      ? `<div class="empty">No active runs. Register a repository with <code>atlas init</code>, then <code>atlas plan</code>.</div>`
      : `<table><tr><th>Run</th><th>Status</th><th>Tasks</th><th>Workers</th><th>Verified</th><th>Merges</th><th></th></tr>${data.activeRuns.map(runRow).join("")}</table>`) +
    `<h2>Recent runs</h2>` +
    (data.recentRuns.length === 0
      ? `<div class="empty">No runs yet.</div>`
      : `<table><tr><th>Run</th><th>Status</th><th>Tasks</th><th>Workers</th><th>Verified</th><th>Merges</th><th></th></tr>${data.recentRuns.map(runRow).join("")}</table>`) +
    `<h2>Projects</h2>` +
    (projects.length === 0
      ? `<div class="empty">No projects yet.</div>`
      : projectSections(projects));
  return layout("home", null, null, body, live, notice, undefined, "home");
}

export function renderRunsPage(
  runs: import("./data.js").RunSummary[],
  live?: LiveOptions,
  notice?: NoticeOptions,
): string {
  const body =
    `<h2>Runs (${runs.length})</h2>` +
    (runs.length === 0
      ? `<div class="empty">No runs yet.</div>`
      : `<table><tr><th>Run</th><th>Project</th><th>Status</th><th>Tasks</th><th>Workers</th><th>Verified</th><th>Merges</th><th></th></tr>${runs
          .map(
            (r) =>
              `<tr><td><a href="/run?feature=${esc(r.id)}">${esc(r.title)}</a><br><span class="muted mono">${esc(short(r.id))}</span></td>` +
              `<td>${esc(r.projectName)}</td><td>${badge(r.status)}</td><td>${r.totalTasks}</td><td>${r.workerCount}</td><td>${r.verifiedCount}</td><td>${r.mergeCount}</td>` +
              `<td><a class="btn" href="/run?feature=${esc(r.id)}&view=island">Open Island →</a></td></tr>`,
          )
          .join("")}</table>`);
  return layout("runs", null, null, body, live, notice, undefined, "runs");
}

export function renderGlobalWorkers(
  workers: import("./data.js").GlobalWorkerEntry[],
  live?: LiveOptions,
  notice?: NoticeOptions,
): string {
  const body =
    `<h2>Workers (${workers.length})</h2><p class="muted">Live assignments link to their task; released workers resolve per-run (see Workers view inside a run).</p>` +
    (workers.length === 0
      ? `<div class="empty">No workers yet.</div>`
      : `<table><tr><th>Worker</th><th>Status</th><th>Task</th><th>Run</th></tr>${workers
          .map(
            (w) =>
              `<tr><td class="mono">${esc(short(w.id))}</td><td>${badge(w.status)}</td>` +
              `<td>${w.taskId === null ? "<span class='muted'>released</span>" : `<a href="/run?feature=${esc(w.featureId ?? "")}&view=tasks#task-${esc(w.taskId)}">${esc(w.taskTitle ?? w.taskId)}</a>`}</td>` +
              `<td>${w.featureId === null ? "—" : `<a href="/run?feature=${esc(w.featureId)}">${esc(w.featureTitle ?? w.featureId)}</a>`}</td></tr>`,
          )
          .join("")}</table>`);
  return layout("workers", null, null, body, live, notice, undefined, "workers");
}

export function renderGlobalActivity(
  entries: import("./data.js").ActivityEntry[],
  live?: LiveOptions,
  notice?: NoticeOptions,
): string {
  const body =
    `<h2>Activity (${entries.length})</h2>` +
    (entries.length === 0
      ? `<div class="empty">No events yet.</div>`
      : `<ul class="plain timeline">${entries
          .map(
            (e) =>
              `<li><strong>${esc(e.type)}</strong> <span class="muted mono">${esc(e.createdAt ?? "?")}</span><br>` +
              `<span class="muted">${e.taskTitle === null ? "" : `${esc(e.taskTitle)} · `}${e.featureTitle === null ? "" : `<a href="/run?feature=${esc(e.featureId ?? "")}">${esc(e.featureTitle)}</a> · `}${e.actor === null || e.actor.length === 0 ? "" : `actor=${esc(e.actor)}`}</span></li>`,
          )
          .join("")}</ul>`);
  return layout("activity", null, null, body, live, notice, undefined, "activity");
}

export function renderRunActivity(
  featureId: string,
  data: import("./data.js").EventData,
  live?: LiveOptions,
  notice?: NoticeOptions,
  hudHtml?: string,
): string {
  const body =
    `<h2>Activity (${data.total})</h2>` +
    (data.total === 0
      ? `<div class="empty">No events recorded for this run yet.</div>`
      : `<ul class="plain timeline">${data.events
          .map(
            (e) =>
              `<li><strong>${esc(e.type)}</strong> <span class="muted mono">${esc(e.createdAt ?? "?")}</span>` +
              `${e.taskId === null ? "" : ` task=<a href="/run?feature=${esc(featureId)}&view=tasks#task-${esc(e.taskId)}" class="mono">${esc(short(e.taskId))}</a>`}` +
              `${e.actor === null || e.actor.length === 0 ? "" : ` <span class="muted">actor=${esc(e.actor)}</span>`}` +
              `${e.payload === null || e.payload.length === 0 ? "" : `<details><summary class="muted">payload</summary><pre>${esc(e.payload)}</pre></details>`}</li>`,
          )
          .join("")}</ul>`);
  return layout("activity", featureId, "activity", body, live, notice, hudHtml);
}

/** Compact run header/HUD rendered from RunHud (real counts + phase chips). */
export function renderHud(hud: import("./data.js").RunHud): string {
  const phaseChip = (p: { name: string; state: string }): string => {
    const mark = p.state === "done" ? "✓" : p.state === "active" ? "●" : "○";
    const cls = p.state === "done" ? "ok" : p.state === "active" ? "active" : "muted";
    return `<span class="badge ${cls}">${mark} ${esc(p.name)}</span>`;
  };
  return (
    `<div class="hud" id="run-hud"><div><p class="eyebrow">Run</p>` +
    `<strong>${esc(hud.title)}</strong> ${badge(hud.status)} <span class="muted mono">${esc(short(hud.featureId))}</span></div>` +
    `<div class="stat"><span class="k">Tasks</span><span class="v metric">${hud.totalTasks}</span></div>` +
    `<div class="stat"><span class="k">Active</span><span class="v metric">${hud.activeTasks}</span></div>` +
    `<div class="stat"><span class="k">Failed</span><span class="v metric">${hud.failedTasks}</span></div>` +
    `<div class="stat"><span class="k">Workers</span><span class="v metric">${hud.activeWorkers}</span></div>` +
    `<div class="stat"><span class="k">Verified</span><span class="v metric">${hud.verifiedCount}</span></div>` +
    `<div class="stat"><span class="k">Integrated</span><span class="v metric">${hud.integratedCount}</span></div>` +
    `<div class="stat"><span class="k">Pipeline</span><span>${hud.phases.map(phaseChip).join(" ")}</span></div>` +
    (hud.haltReason === null ? "" : `<div class="stat"><span class="k">Halted</span><span>${esc(hud.haltReason)}</span></div>`) +
    `</div>`
  );
}
