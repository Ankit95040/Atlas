import type { WorkflowGraphData } from "./data.js";
import { badge, esc, layout, layoutLevels, short, statusGlyph, nodeTable, type LiveOptions, type NoticeOptions } from "./views.js";

// Static Island projection (M24.6): a spatial view of WorkflowGraphData.
//
// Pure renderer: shaped Atlas state in, HTML/SVG string out. No client JS,
// no animation, no new data loading, no mutations. Levels are dependency
// depth (M24.4 layout); waves come from the scheduler preview; districts
// are presentation bands only and are not clickable. Every visual maps to
// existing state; the text-equivalent table below keeps it accessible.

const TERMINAL_PREREQ = new Set(["COMPLETED", "COMPLETED_EMPTY"]);

function colorOf(status: string): string {
  switch (status) {
    case "COMPLETED":
    case "COMPLETED_EMPTY":
      return "#3fb950";
    case "FAILED":
      return "#f85149";
    case "VERIFICATION":
    case "IN_PROGRESS":
    case "CLAIMED":
      return "#58a6ff";
    default:
      return "#8b949e";
  }
}

function trunc(title: string, max = 26): string {
  return title.length > max ? `${title.slice(0, max - 1)}…` : title;
}

export function renderIsland(
  featureId: string,
  data: WorkflowGraphData,
  live?: LiveOptions,
  notice?: NoticeOptions,
  hudHtml?: string,
): string {
  if (data.nodes.length === 0) {
    return layout("island", featureId, "island", `<h2>Island</h2><div class="empty">No tasks yet — open water. Add them with <code>atlas plan</code>.</div>`, live, notice, hudHtml);
  }
  const nodeById = new Map(data.nodes.map((n) => [n.id, n] as const));
  const titleOf = (id: string): string => nodeById.get(id)?.title ?? id;
  const levels = layoutLevels(
    data.nodes.map((n) => ({ id: n.id })),
    data.edges,
  );
  const statusOf = (id: string): string => nodeById.get(id)?.status ?? "?";

  // Wave banners group scheduled nodes; unscheduled nodes are listed, never hidden.
  const waveGroups = new Map<number, string[]>();
  const unscheduled: string[] = [];
  for (const node of data.nodes) {
    if (node.wave === null) {
      unscheduled.push(node.id);
    } else {
      const group = waveGroups.get(node.wave) ?? [];
      group.push(node.id);
      waveGroups.set(node.wave, group);
    }
  }
  const sortedWaves = [...waveGroups.entries()].sort((a, b) => a[0] - b[0]);

  const nodeW = 210;
  const nodeH = 116;
  const gapX = 84;
  const gapY = 30;
  const levelPad = 34;
  const colWidth = Math.max(...levels.map((l) => l.length)) * (nodeW + gapX) + gapX;
  const gates = data.nodes.filter((n) => n.verdict !== null);
  const perRow = (count: number): number => Math.max(1, Math.min(count, Math.max(1, Math.floor(colWidth / 190))));
  const width = Math.max(colWidth, 560);
  let y = 16;
  const parts: string[] = [];
  const landTop = y;

  // Control tower (conceptual anchor; links to overview, controls nothing).
  const towerW = 320;
  const towerX = (width - towerW) / 2;
  const phaseDots = data.phases.map((p) => `${p.active ? "●" : "○"} ${p.name}`).join("  ");
  parts.push(
    `<a href="/run?feature=${esc(featureId)}&view=overview"><rect x="${towerX}" y="${y}" width="${towerW}" height="64" rx="8" fill="#161b22" stroke="#1f6feb"/><text x="${towerX + 16}" y="${y + 26}" fill="#e6edf3" font-size="13" font-weight="bold">ATLAS CONTROL</text><text x="${towerX + 16}" y="${y + 46}" fill="#8b949e" font-size="10">${esc(phaseDots)}</text><title>Atlas control plane — open overview</title></a>`,
  );
  y += 64 + 22;

  // Wave banners (scheduler output; explicitly not levels).
  for (const [wave, ids] of sortedWaves) {
    const label = `WAVE ${wave} · ${ids.map((id) => titleOf(id)).join(", ")}`;
    parts.push(`<text x="${width / 2}" y="${y}" fill="#d29922" font-size="11" text-anchor="middle">${esc(label.length > 90 ? `${label.slice(0, 89)}…` : label)}</text>`);
    y += 22;
  }
  if (unscheduled.length > 0) {
    parts.push(`<text x="${width / 2}" y="${y}" fill="#6e7681" font-size="10" text-anchor="middle">unscheduled: ${esc(unscheduled.map((id) => short(id)).join(", "))}</text>`);
    y += 20;
  }
  y += 8;

  // Levels with task structures.
  const pos = new Map<string, { x: number; y: number }>();
  const bandRects: string[] = [];
  levels.forEach((level, li) => {
    const rowW = level.length * (nodeW + gapX) - gapX;
    const x0 = (width - rowW) / 2;
    const top = y;
    level.forEach((id, ni) => {
      pos.set(id, { x: x0 + ni * (nodeW + gapX), y });
    });
    bandRects.push(
      `<rect x="8" y="${top - levelPad + 10}" width="${width - 16}" height="${nodeH + levelPad * 2 - 10}" rx="10" fill="none" stroke="#21262d" stroke-dasharray="6 5"/><text x="20" y="${top - levelPad + 28}" fill="#6e7681" font-size="11">LEVEL ${li + 1} — dependency depth</text>`,
    );
    y += nodeH + gapY + levelPad;
  });

  // Dependency paths (rows only; direction + satisfied/waiting from state).
  const pathSvg = data.edges
    .map((e) => {
      const a = pos.get(e.from);
      const b = pos.get(e.to);
      if (a === undefined || b === undefined) {
        return "";
      }
      const satisfied = TERMINAL_PREREQ.has(statusOf(e.from));
      const x1 = a.x + nodeW / 2;
      const y1 = a.y + nodeH;
      const x2 = b.x + nodeW / 2;
      const y2 = b.y;
      const mid = `<text x="${(x1 + x2) / 2 + 6}" y="${(y1 + y2) / 2}" fill="#6e7681" font-size="9">${satisfied ? "" : esc(`waiting on ${short(e.from)}`)}</text>`;
      return (
        `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#58a6ff" stroke-width="2.5" marker-end="url(#isarrow)"` +
        (satisfied ? `/>` : ` stroke-dasharray="7 5" opacity="0.75"/>`) +
        `<path d="M ${x2 - 9} ${y2 - 2} l 7 2 l -7 2" fill="none" stroke="#58a6ff" stroke-width="1.5"/>${mid}`
      );
    })
    .join("");

  // Task structures with worker figures beside them (never inside).
  const nodeSvg = [...pos.entries()]
    .map(([id, p]) => {
      const node = nodeById.get(id);
      if (node === undefined) {
        return "";
      }
      const failed = node.status === "FAILED";
      const workerCircle =
        node.workerId === null
          ? ""
          : node.workerLink === "historical"
            ? `<a href="/run?feature=${esc(featureId)}&view=workers#worker-${esc(node.workerId)}"><circle cx="${p.x - 26}" cy="${p.y + 40}" r="10" fill="none" stroke="#8b949e" stroke-dasharray="3 2"/><text x="${p.x - 26}" y="${p.y + 62}" fill="#8b949e" font-size="9" text-anchor="middle">${esc(short(node.workerId))}</text><text x="${p.x - 26}" y="${p.y + 73}" fill="#6e7681" font-size="8" text-anchor="middle">historical</text><title>worker ${esc(node.workerId)} (${esc(node.workerStatus ?? "?")}, historical) — open worker</title></a>`
            : `<a href="/run?feature=${esc(featureId)}&view=workers#worker-${esc(node.workerId)}"><circle cx="${p.x - 26}" cy="${p.y + 40}" r="10" fill="${colorOf(node.workerStatus ?? "")}" opacity="0.85"/><text x="${p.x - 26}" y="${p.y + 62}" fill="#e6edf3" font-size="9" text-anchor="middle">${esc(short(node.workerId))}</text><text x="${p.x - 26}" y="${p.y + 73}" fill="#58a6ff" font-size="8" text-anchor="middle">live</text><title>worker ${esc(node.workerId)} (${esc(node.workerStatus ?? "?")}, current) — open worker</title></a>`;
      const metaLine = `${node.wave === null ? "no wave" : `wave ${node.wave}`}${node.verdict === null ? "" : ` · ${node.verdict}`}${node.integrated ? " · INTEGRATED" : ""}`;
      const waiting =
        node.status === "BLOCKED" && node.dependsOn.length > 0
          ? `waiting on ${node.dependsOn.map((d) => titleOf(d)).join(", ")}`
          : node.dependsOn.length === 0
            ? "—"
            : `depends: ${node.dependsOn.map((d) => short(d)).join(", ")}`;
      return `<g><rect x="${p.x}" y="${p.y}" width="${nodeW}" height="${nodeH}" rx="8" fill="#161b22" stroke="${failed ? "#f85149" : colorOf(node.status)}" stroke-width="${failed ? 2.5 : 1.5}"/>${workerCircle}` +
        `<a href="/run?feature=${esc(featureId)}&view=tasks#task-${esc(id)}"><text x="${p.x + 12}" y="${p.y + 24}" fill="#e6edf3" font-size="12" font-weight="bold">${esc(trunc(node.title))}</text><title>${esc(node.title)} — open task</title></a>` +
        `<text x="${p.x + 12}" y="${p.y + 44}" fill="#e6edf3" font-size="11">${esc(statusGlyph(node.status))} ${esc(node.status)}</text>` +
        `<text x="${p.x + 12}" y="${p.y + 62}" fill="#8b949e" font-size="10">${esc(metaLine)}</text>` +
        `<text x="${p.x + 12}" y="${p.y + 80}" fill="#6e7681" font-size="10">${esc(waiting.length > 34 ? `${waiting.slice(0, 33)}…` : waiting)}</text>` +
        `<text x="${p.x + 12}" y="${p.y + 98}" fill="#6e7681" font-size="10">deps: ${node.dependsOn.length}</text></g>`;
    })
    .join("");

  // Verification wall with per-verdict gates (only tasks that reached verification).
  y += 6;
  const wallY = y;
  y += 12;
  const gatesPerRow = perRow(Math.max(gates.length, 1));
  const gateW = 180;
  const gateH = 46;
  const gateGap = 16;
  const gateSvg: string[] = [];
  gates.forEach((node, gi) => {
    const row = Math.floor(gi / gatesPerRow);
    const col = gi % gatesPerRow;
    const rowCount = Math.min(gatesPerRow, gates.length - row * gatesPerRow);
    const rowW = rowCount * (gateW + gateGap) - gateGap;
    const gx = (width - rowW) / 2 + col * (gateW + gateGap);
    const gy = y + row * (gateH + 12);
    const passed = node.verdict === "VERIFIED";
    const reason = node.reasons.length === 0 ? "" : `: ${node.reasons.join("; ")}`;
    const label = `${passed ? "✓" : "×"} ${node.title.length > 16 ? `${node.title.slice(0, 15)}…` : node.title} ${node.verdict ?? ""}${reason.length > 26 ? `${reason.slice(0, 25)}…` : reason}`;
    gateSvg.push(
      `<a href="/run?feature=${esc(featureId)}&view=verification"><rect x="${gx}" y="${gy}" width="${gateW}" height="${gateH}" rx="6" fill="#161b22" stroke="${passed ? "#3fb950" : "#f85149"}"/><text x="${gx + 10}" y="${gy + 28}" fill="#e6edf3" font-size="10">${esc(label.length > 30 ? `${label.slice(0, 29)}…` : label)}</text><title>${esc(`${node.title}: ${node.verdict ?? "?"}${reason} — open verification`)}</title></a>`,
    );
  });
  const gateRows = gates.length === 0 ? 0 : Math.ceil(gates.length / gatesPerRow);
  y += gateRows * (gateH + 12) + 10;

  // Merge railyard: one car per integrated commit, in merge order.
  const cars = data.trainCars;
  const carW = 170;
  const carH = 48;
  const carGap = 14;
  const carsPerRow = perRow(Math.max(cars.length, 1));
  const carSvg: string[] = [];
  cars.forEach((car, ci) => {
    const row = Math.floor(ci / carsPerRow);
    const col = ci % carsPerRow;
    const rowCount = Math.min(carsPerRow, cars.length - row * carsPerRow);
    const rowW = rowCount * (carW + carGap) - carGap;
    const cx = (width - rowW) / 2 + col * (carW + carGap);
    const cy = y + row * (carH + 12);
    carSvg.push(
      `<a href="/run?feature=${esc(featureId)}&view=train"><rect x="${cx}" y="${cy}" width="${carW}" height="${carH}" rx="4" fill="#12261a" stroke="#2ea043"/><text x="${cx + 10}" y="${cy + 20}" fill="#e6edf3" font-size="10">${esc(trunc(car.title, 20))}</text><text x="${cx + 10}" y="${cy + 36}" fill="#8b949e" font-size="9" font-family="monospace">${esc(car.sha.slice(0, 12))}</text><title>${esc(`${car.title} · ${car.sha} · ${car.subject} — open merge train`)}</title></a>`,
    );
  });
  const carRows = cars.length === 0 ? 0 : Math.ceil(cars.length / carsPerRow);
  y += carRows * (carH + 12) + 8;
  let haltBeacon = "";
  if (data.trainHalted) {
    haltBeacon = `<g><rect x="${(width - 320) / 2}" y="${y}" width="320" height="40" rx="6" fill="#3d1113" stroke="#f85149"/><text x="${width / 2}" y="${y + 25}" fill="#f85149" font-size="11" text-anchor="middle">! HALTED — ${esc((data.trainHaltReason ?? "see train view").slice(0, 44))}</text><title>${esc(data.trainHaltReason ?? "halted")}</title></g>`;
    y += 40 + 10;
  } else if (cars.length === 0) {
    haltBeacon = `<text x="${width / 2}" y="${y + 14}" fill="#6e7681" font-size="10" text-anchor="middle">no cars yet — integration creates them, never worker completion</text>`;
    y += 14 + 10;
  }

  // Harbor: read-only main reference (Atlas stores no main SHA).
  const harborY = y + 8;
  const harbor =
    `<path d="M ${width / 2 - 130} ${harborY + 26} q 20 -12 40 0 t 40 0 t 40 0 t 40 0 t 40 0" fill="none" stroke="#1f6feb" stroke-width="1.5" opacity="0.6"/>` +
    `<text x="${width / 2}" y="${harborY}" fill="#e6edf3" font-size="11" text-anchor="middle">HARBOR · MAIN ${esc(data.defaultBranch)}</text>` +
    `<text x="${width / 2}" y="${harborY + 14}" fill="#6e7681" font-size="9" text-anchor="middle">Atlas stores no main SHA — integration lands on train branches</text>`;
  y = harborY + 34;
  const height = y + 16;

  const land = `<rect x="4" y="${landTop}" width="${width - 8}" height="${height - landTop - 4}" rx="26" fill="#10161d" stroke="#1f2a36" stroke-dasharray="10 7"/>`;
  const svg =
    `<div style="overflow-x:auto;background:#0a0e13;border:1px solid #21262d;border-radius:8px;padding:8px;"><svg class="deps" viewBox="0 0 ${width} ${height}" role="img" aria-label="atlas island projection" style="background:transparent;border:none;">` +
    `<defs><marker id="isarrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8" fill="none" stroke="#58a6ff" stroke-width="1.5"/></marker></defs>` +
    land +
    `<text x="20" y="${landTop + 20}" fill="#1f2a36" font-size="12" letter-spacing="3">ATLAS ISLAND · ${esc(data.runTitle)}</text>` +
    parts.join("") +
    bandRects.join("") +
    pathSvg +
    nodeSvg +
    `<rect x="8" y="${wallY}" width="${width - 16}" height="6" rx="3" fill="#21262d"/><text x="20" y="${wallY - 4}" fill="#6e7681" font-size="10">VERIFICATION WALL — gates open only on persisted verdicts</text>` +
    gateSvg.join("") +
    carSvg.join("") +
    haltBeacon +
    harbor +
    `</svg></div>`;

  const legend = `<p class="muted">Legend: LEVEL = dependency depth · WAVE = scheduler output (not levels) · solid path = prerequisite terminal · dashed path = waiting · figure: solid = live worker, hollow = historical · bands are presentation only, never clickable.</p>`;
  const table = nodeTable(featureId, data.nodes);
  const body =
    `<h2>${esc(data.runTitle)} ${badge(data.runStatus)}</h2>${legend}` +
    (data.trainHalted ? `<div class="err">! Merge train halted — ${esc(data.trainHaltReason ?? "see train view")}.</div>` : "") +
    `<p><a class="btn" href="/run?feature=${esc(featureId)}&view=island&mode=proto">Try the 2.5D prototype →</a> <span class="muted">Experimental static projection; this flat view stays.</span></p>` +
    svg +
    `<h2>Island nodes (text equivalent)</h2>${table}`;
  return layout("island", featureId, "island", body, live, notice, hudHtml);
}
