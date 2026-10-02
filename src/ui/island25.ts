import type { WorkflowGraphData } from "./data.js";
import { badge, esc, layout, nodeTable, short, statusGlyph, type LiveOptions, type NoticeOptions } from "./views.js";
import { layoutLevels } from "./views.js";

// 2.5D isometric prototype renderer (M24.8): a miniature-engineering-facility
// projection of WorkflowGraphData. Pure function of Atlas state — no client
// JS, no animation, no WebGL, no new dependencies. Isometric boxes, gradient
// lighting, and soft shadows are plain SVG. Every visual maps to existing
// state; the text-equivalent table below keeps it accessible.

const HX = 34;
const HY = 17;

export interface IsoPoint {
  readonly x: number;
  readonly y: number;
}

/** Dimetric projection of tile space to screen space (exported for tests). */
export function isoProject(i: number, j: number, height = 0): IsoPoint {
  return { x: (i - j) * HX, y: (i + j) * HY - height };
}

function pts(points: IsoPoint[]): string {
  return points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
}

/** Vertical faces + top of an axis-aligned footprint box. */
export function isoBox(
  i0: number,
  j0: number,
  i1: number,
  j1: number,
  height: number,
  fills: { top: string; left: string; right: string },
): { top: string; left: string; right: string } {
  const a = isoProject(i0, j0, height);
  const b = isoProject(i1, j0, height);
  const c = isoProject(i1, j1, height);
  const d = isoProject(i0, j1, height);
  const ah = isoProject(i0, j0, 0);
  const bh = isoProject(i1, j0, 0);
  const ch = isoProject(i1, j1, 0);
  const dh = isoProject(i0, j1, 0);
  void ah;
  void bh;
  return {
    top: `<polygon points="${pts([a, b, c, d])}" fill="${fills.top}"/>`,
    left: `<polygon points="${pts([d, c, ch, dh])}" fill="${fills.left}"/>`,
    right: `<polygon points="${pts([b, c, ch, bh])}" fill="${fills.right}"/>`,
  };
}

function statusPalette(status: string): { top: string; left: string; right: string; lamp: string } {
  switch (status) {
    case "COMPLETED":
    case "COMPLETED_EMPTY":
      return { top: "#2c3a2e", left: "#1e2a21", right: "#141d16", lamp: "#3fb950" };
    case "FAILED":
      return { top: "#3a2a2c", left: "#2a1e20", right: "#1d1416", lamp: "#f85149" };
    case "CLAIMED":
    case "IN_PROGRESS":
    case "VERIFICATION":
      return { top: "#2a3648", left: "#1e2836", right: "#141c26", lamp: "#58a6ff" };
    default:
      return { top: "#2a313c", left: "#1e242e", right: "#141920", lamp: "#8b949e" };
  }
}

function trunc(title: string, max = 22): string {
  return title.length > max ? `${title.slice(0, max - 1)}…` : title;
}

export interface ProtoLayout {
  readonly buildingTiles: Map<string, { i: number; j: number }>;
  readonly levels: string[][];
}

export function layoutProtoTiles(
  nodes: Array<{ id: string }>,
  edges: Array<{ from: string; to: string }>,
): ProtoLayout {
  const levels = layoutLevels(nodes, edges);
  const buildingTiles = new Map<string, { i: number; j: number }>();
  levels.forEach((level, li) => {
    level.forEach((id, ni) => {
      buildingTiles.set(id, { i: ni * 2.4 - ((level.length - 1) * 2.4) / 2, j: li * 3.2 });
    });
  });
  return { buildingTiles, levels };
}

export function renderIslandProto(
  featureId: string,
  data: WorkflowGraphData,
  live?: LiveOptions,
  notice?: NoticeOptions,
  hudHtml?: string,
): string {
  if (data.nodes.length === 0) {
    return layout("island prototype", featureId, "island", `<h2>Island prototype</h2><div class="empty">Open water — no tasks yet. Add them with <code>atlas plan</code>.</div>`, live, notice, hudHtml);
  }
  const nodeById = new Map(data.nodes.map((n) => [n.id, n] as const));
  const titleOf = (id: string): string => nodeById.get(id)?.title ?? id;
  const statusOf = (id: string): string => nodeById.get(id)?.status ?? "?";
  const { buildingTiles, levels } = layoutProtoTiles(data.nodes, data.edges);
  const maxJ = levels.length === 0 ? 0 : (levels.length - 1) * 3.2;

  const parts: string[] = [];
  const min = { x: Number.POSITIVE_INFINITY, y: Number.POSITIVE_INFINITY };
  const max = { x: Number.NEGATIVE_INFINITY, y: Number.NEGATIVE_INFINITY };
  const track = (p: IsoPoint): void => {
    min.x = Math.min(min.x, p.x);
    min.y = Math.min(min.y, p.y);
    max.x = Math.max(max.x, p.x);
    max.y = Math.max(max.y, p.y);
  };
  // Track corners conservatively from tile extents.
  for (const { i, j } of buildingTiles.values()) {
    for (const [di, dj, h] of [[-1, -1, 60], [1, 1, 0]] as const) {
      track(isoProject(i + di, j + dj, h));
    }
  }
  track(isoProject(0, maxJ + 6.5, 0));

  // Water + landmass (presentation only; out-of-scope vs run scope).
  const land = `<rect x="${min.x - 150}" y="${min.y - 130}" width="${max.x - min.x + 300}" height="${max.y - min.y + 420}" rx="60" fill="#0e141c" stroke="#1c2836" stroke-dasharray="12 8"/>` +
    `<rect x="${min.x - 110}" y="${min.y - 100}" width="${max.x - min.x + 220}" height="${max.y - min.y + 360}" rx="46" fill="#111927" stroke="#22303f"/>`;
  const waterArcs = [-120, 40, 200]
    .map((dy, k) => `<path d="M ${min.x - 90 + k * 40} ${max.y + 150 + dy * 0.2} q 25 -10 50 0 t 50 0" fill="none" stroke="#1f6feb" stroke-width="1.2" opacity="0.25"/>`)
    .join("");
  parts.push(
    `<rect x="${min.x - 400}" y="${min.y - 400}" width="${max.x - min.x + 800}" height="${max.y - min.y + 1000}" fill="url(#iswater)"/>${waterArcs}${land}` +
      `<text x="${min.x - 120}" y="${min.y - 108}" fill="#334155" font-size="12" letter-spacing="4">ATLAS ISLAND · ${esc(data.runTitle)}</text>`,
  );
  // Level bands behind the structures (presentation only, never clickable).
  levels.forEach((level, li) => {
    let loX = Number.POSITIVE_INFINITY;
    let hiX = Number.NEGATIVE_INFINITY;
    let loY = Number.POSITIVE_INFINITY;
    let hiY = Number.NEGATIVE_INFINITY;
    for (const id of level) {
      const tile = buildingTiles.get(id);
      if (tile === undefined) {
        continue;
      }
      const c = isoProject(tile.i, tile.j, 0);
      loX = Math.min(loX, c.x);
      hiX = Math.max(hiX, c.x);
      loY = Math.min(loY, c.y);
      hiY = Math.max(hiY, c.y);
    }
    if (loX === Number.POSITIVE_INFINITY) {
      return;
    }
    parts.push(
      `<rect x="${loX - 110}" y="${loY - 110}" width="${hiX - loX + 220}" height="${hiY - loY + 220}" rx="18" fill="none" stroke="#21262d" stroke-dasharray="6 5"/>` +
        `<text x="${loX - 98}" y="${loY - 88}" fill="#6e7681" font-size="11">LEVEL ${li + 1} — dependency depth</text>`,
    );
  });

  // Control tower (conceptual anchor → overview; controls nothing).
  const tower = { i: 0, j: -2.6 };
  const tb = isoBox(tower.i - 0.55, tower.j - 0.55, tower.i + 0.55, tower.j + 0.55, 120, { top: "#31405a", left: "#223052", right: "#16213a" });
  const tBase = isoProject(tower.i, tower.j, 0);
  const tTop = isoProject(tower.i, tower.j, 120);
  const lampRow = data.phases
    .map((p, k) => `<circle cx="${tBase.x - 44 + k * 22}" cy="${tBase.y - 108}" r="5" fill="${p.active ? "#58a6ff" : "#334155"}"><title>${esc(p.name)}: ${esc(p.detail)}</title></circle>`)
    .join("");
  parts.push(
    `<ellipse cx="${tBase.x}" cy="${tBase.y + 4}" rx="46" ry="13" fill="#000" opacity="0.35"/>` +
      tb.left + tb.right + tb.top +
      `<line x1="${tTop.x}" y1="${tTop.y}" x2="${tTop.x}" y2="${tTop.y - 26}" stroke="#8b949e" stroke-width="2"/><circle cx="${tTop.x}" cy="${tTop.y - 30}" r="4" fill="#f85149"><title>beacon</title></circle>` +
      `<a href="/run?feature=${esc(featureId)}&view=overview"><text x="${tBase.x}" y="${tBase.y + 30}" fill="#e6edf3" font-size="12" font-weight="bold" text-anchor="middle">ATLAS CONTROL</text><title>Atlas control plane — open overview</title></a>` +
      lampRow +
      `<text x="${tBase.x}" y="${tBase.y + 46}" fill="#8b949e" font-size="9" text-anchor="middle">PLAN · SCHED · EXEC · VER · MER</text>`,
  );

  // Wave banners (scheduler output; explicitly not territories).
  let bannerY = tBase.y + 66;
  const waveGroups = new Map<number, string[]>();
  for (const node of data.nodes) {
    if (node.wave !== null) {
      const group = waveGroups.get(node.wave) ?? [];
      group.push(node.title);
      waveGroups.set(node.wave, group);
    }
  }
  for (const [wave, titles] of [...waveGroups.entries()].sort((a, b) => a[0] - b[0])) {
    const label = `WAVE ${wave} · ${titles.join(" · ")}`;
    parts.push(`<text x="${tBase.x}" y="${bannerY}" fill="#d29922" font-size="11" text-anchor="middle">${esc(label.length > 80 ? `${label.slice(0, 79)}…` : label)}</text>`);
    bannerY += 18;
  }

  // Task structures with worker units beside them.
  const TERMINAL_PREREQ = new Set(["COMPLETED", "COMPLETED_EMPTY"]);
  for (const [id, tile] of buildingTiles) {
    const node = nodeById.get(id);
    if (node === undefined) {
      continue;
    }
    const pal = statusPalette(node.status);
    const h = node.status === "FAILED" ? 40 : 52;
    const b = isoBox(tile.i - 0.45, tile.j - 0.45, tile.i + 0.45, tile.j + 0.45, h, { top: pal.top, left: pal.left, right: pal.right });
    const c = isoProject(tile.i, tile.j, 0);
    const ct = isoProject(tile.i, tile.j, h);
    const failed = node.status === "FAILED";
    // One group per structure carries the diff hooks (M24.9 polling).
    const nodeParts: string[] = [];
    nodeParts.push(`<ellipse cx="${c.x}" cy="${c.y + 4}" rx="34" ry="10" fill="#000" opacity="0.35"/>`);
    nodeParts.push(`<g>${b.left}${b.right}${b.top}</g>`);
    // Status lamp on the roof (emissive dot; static, no animation).
    nodeParts.push(`<circle cx="${ct.x}" cy="${ct.y}" r="4.5" fill="${pal.lamp}"><title>${esc(node.status)}</title></circle>`);
    if (failed) {
      nodeParts.push(`<text x="${ct.x}" y="${ct.y - 12}" fill="#f85149" font-size="13" font-weight="bold" text-anchor="middle">×</text>`);
    }
    // Worker unit beside the structure (M23.1: solid live, hollow historical).
    if (node.workerId !== null) {
      const w = isoProject(tile.i + 0.85, tile.j + 0.5, 0);
      const wb = isoBox(tile.i + 0.68, tile.j + 0.33, tile.i + 1.02, tile.j + 0.67, 14, { top: "#3a4556", left: "#2a3340", right: "#1b2330" });
      const fig = node.workerLink === "historical"
        ? `<g opacity="0.55" stroke-dasharray="3 2">${wb.left}${wb.right}${wb.top}</g>`
        : `<g>${wb.left}${wb.right}${wb.top}</g>`;
      nodeParts.push(
        `<ellipse cx="${w.x}" cy="${w.y + 3}" rx="14" ry="4.5" fill="#000" opacity="0.3"/>` +
          `<a href="/run?feature=${esc(featureId)}&view=workers#worker-${esc(node.workerId)}" data-worker="${esc(node.workerId)}" data-wlink="${esc(node.workerLink)}">${fig}` +
          `<text x="${w.x}" y="${w.y + 20}" fill="${node.workerLink === "historical" ? "#8b949e" : "#e6edf3"}" font-size="9" text-anchor="middle">worker ${esc(short(node.workerId))}</text>` +
          `<text x="${w.x}" y="${w.y + 31}" fill="#6e7681" font-size="8" text-anchor="middle">${esc(node.workerLink)}</text>` +
          `<title>worker ${esc(node.workerId)} (${esc(node.workerStatus ?? "?")}, ${esc(node.workerLink)}) — open worker</title></a>`,
      );
    }
    const metaLine = `${node.wave === null ? "no wave" : `wave ${node.wave}`}${node.verdict === null ? "" : ` · ${node.verdict}`}${node.integrated ? " · INTEGRATED" : ""}`;
    nodeParts.push(
      `<a href="/run?feature=${esc(featureId)}&view=tasks#task-${esc(id)}">` +
        `<text x="${c.x}" y="${ct.y - 34}" fill="#e6edf3" font-size="12" font-weight="bold" text-anchor="middle">${esc(node.title.length > 24 ? `${node.title.slice(0, 23)}…` : node.title)}</text>` +
        `<title>${esc(node.title)} — open task</title></a>` +
        `<text x="${c.x}" y="${ct.y - 18}" fill="#e6edf3" font-size="11" text-anchor="middle">${esc(statusGlyph(node.status))} ${esc(node.status)}</text>` +
        `<text x="${c.x}" y="${c.y + 30}" fill="#8b949e" font-size="9" text-anchor="middle">${esc(metaLine)}</text>`,
    );
    parts.push(`<g data-task="${esc(id)}" data-status="${esc(node.status)}">${nodeParts.join("")}</g>`);
  }

  // Dependency conduits on the ground plane (rows only).
  for (const edge of data.edges) {
    const a = buildingTiles.get(edge.from);
    const b = buildingTiles.get(edge.to);
    if (a === undefined || b === undefined) {
      continue;
    }
    const p1 = isoProject(a.i, a.j, 0);
    const p2 = isoProject(b.i, b.j, 0);
    const satisfied = TERMINAL_PREREQ.has(statusOf(edge.from));
    const mx = (p1.x + p2.x) / 2;
    const my = (p1.y + p2.y) / 2;
    parts.push(
      `<line x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}" stroke="#0d1117" stroke-width="7" stroke-linecap="round"/>` +
        `<line x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}" stroke="#58a6ff" stroke-width="2"` +
        (satisfied ? `/>` : ` stroke-dasharray="6 5" opacity="0.7"/>`) +
        `<path d="M ${mx - 7} ${my} l 6 -4 M ${mx - 7} ${my} l 6 4" fill="none" stroke="#58a6ff" stroke-width="1.5"><title>${esc(satisfied ? `satisfied: ${titleOf(edge.from)} → ${titleOf(edge.to)}` : `waiting on ${titleOf(edge.from)}`)}</title></path>` +
        (satisfied ? "" : `<text x="${mx + 8}" y="${my - 6}" fill="#6e7681" font-size="8">waiting</text>`),
    );
  }

  // Verification wall with per-verdict gates.
  const gated = data.nodes.filter((n) => n.verdict !== null);
  const wallY = isoProject(0, maxJ + 2.6, 0).y;
  const wallX0 = min.x - 90;
  const wallX1 = max.x + 90;
  parts.push(
    `<rect x="${wallX0}" y="${wallY - 4}" width="${wallX1 - wallX0}" height="8" rx="4" fill="#21262d"/>` +
      `<text x="${wallX0 + 10}" y="${wallY - 12}" fill="#6e7681" font-size="10">VERIFICATION WALL — gates open only on persisted verdicts</text>`,
  );
  gated.forEach((node, gi) => {
    const gx = wallX0 + 30 + gi * 200;
    const gy = wallY + 16;
    const passed = node.verdict === "VERIFIED";
    const reason = node.reasons.length === 0 ? "" : `: ${node.reasons.join("; ")}`;
    const label = `${passed ? "✓" : "×"} ${node.title.length > 14 ? `${node.title.slice(0, 13)}…` : node.title} ${node.verdict ?? ""}`;
    parts.push(
      `<a href="/run?feature=${esc(featureId)}&view=verification" data-gate="${esc(node.id)}" data-verdict="${esc(node.verdict ?? "")}">` +
        `<rect x="${gx - 8}" y="${gy - 30}" width="14" height="44" fill="#161b22" stroke="#8b949e"/>` +
        `<rect x="${gx + 178}" y="${gy - 30}" width="14" height="44" fill="#161b22" stroke="#8b949e"/>` +
        `<rect x="${gx - 8}" y="${gy - 38}" width="200" height="14" rx="3" fill="${passed ? "#12261a" : "#3d1113"}" stroke="${passed ? "#2ea043" : "#f85149"}"/>` +
        `<text x="${gx + 96}" y="${gy + 28}" fill="#e6edf3" font-size="10" text-anchor="middle">${esc(label.length > 30 ? `${label.slice(0, 29)}…` : label)}</text>` +
        `<title>${esc(`${node.title}: ${node.verdict ?? "?"}${reason} — open verification`)}</title></a>`,
    );
    track(isoProject(gx / HX, gy / HY, 0));
  });

  // Merge railyard: one car per integrated commit, in merge order.
  const cars = data.trainCars;
  const railBaseY = wallY + 150 + (gated.length === 0 ? 0 : Math.ceil(gated.length / Math.max(1, Math.floor((max.x - min.x + 180) / 200))) * 62);
  const railX0 = min.x - 60;
  const railX1 = max.x + 60;
  const carSlot = 190;
  const carsPerRow = Math.max(1, Math.floor((railX1 - railX0) / carSlot));
  const carRowsPre = cars.length === 0 ? 0 : Math.ceil(cars.length / carsPerRow);
  const yardTop = railBaseY - 56;
  const yardBottom = railBaseY + carRowsPre * 64 + (cars.length === 0 ? 44 : 24) + (data.trainHalted ? 70 : 0);
  parts.push(
    `<rect x="${railX0 - 24}" y="${yardTop}" width="${railX1 - railX0 + 48}" height="${yardBottom - yardTop}" rx="10" fill="none" stroke="#2ea043" stroke-dasharray="8 6" opacity="0.7"/>` +
      `<text x="${railX0 - 12}" y="${yardTop + 18}" fill="#2ea043" font-size="10" letter-spacing="2">RAILYARD — cars appear only on integration</text>`,
  );
  cars.forEach((car, ci) => {
    const row = Math.floor(ci / carsPerRow);
    const col = ci % carsPerRow;
    const cx = railX0 + 20 + col * carSlot;
    const cy = railBaseY + row * 64;
    parts.push(`<line x1="${railX0}" y1="${cy + 26}" x2="${railX1}" y2="${cy + 26}" stroke="#30363d" stroke-width="3"/>`);
    for (let s = 0; s < 5; s++) {
      const sx = railX0 + 8 + s * ((railX1 - railX0 - 16) / 4);
      parts.push(`<line x1="${sx}" y1="${cy + 20}" x2="${sx}" y2="${cy + 32}" stroke="#21262d" stroke-width="3"/>`);
    }
    parts.push(
      `<a href="/run?feature=${esc(featureId)}&view=train" data-car="${esc(car.sha)}">` +
        `<rect x="${cx}" y="${cy - 14}" width="150" height="40" rx="4" fill="#12261a" stroke="#2ea043"/>` +
        `<text x="${cx + 10}" y="${cy + 4}" fill="#e6edf3" font-size="10">${esc(car.title.length > 18 ? `${car.title.slice(0, 17)}…` : car.title)}</text>` +
        `<text x="${cx + 10}" y="${cy + 20}" fill="#8b949e" font-size="9" font-family="monospace">${esc(car.sha.slice(0, 12))}</text>` +
        `<title>${esc(`${car.title} · ${car.sha} · ${car.subject} — open merge train`)}</title></a>`,
    );
  });
  const carRows = cars.length === 0 ? 0 : Math.ceil(cars.length / carsPerRow);
  let belowRail = railBaseY + carRows * 64 + 10;
  if (cars.length === 0) {
    parts.push(`<text x="${(railX0 + railX1) / 2}" y="${belowRail}" fill="#6e7681" font-size="10" text-anchor="middle">no cars yet — integration creates them, never worker completion</text>`);
    belowRail += 22;
  }
  if (data.trainHalted) {
    const hx = (railX0 + railX1) / 2;
    parts.push(
      `<g data-halt="true"><polygon points="${hx},${belowRail} ${hx + 14},${belowRail + 14} ${hx},${belowRail + 28} ${hx - 14},${belowRail + 14}" fill="#3d1113" stroke="#f85149"/>` +
        `<text x="${hx}" y="${belowRail + 19}" fill="#f85149" font-size="12" font-weight="bold" text-anchor="middle">!</text>` +
        `<text x="${hx}" y="${belowRail + 44}" fill="#f85149" font-size="10" text-anchor="middle">HALTED — ${esc((data.trainHaltReason ?? "see train view").slice(0, 60))}</text>` +
        `<title>${esc(data.trainHaltReason ?? "halted")}</title></g>`,
    );
    belowRail += 58;
  }

  // Harbor: boxed final destination fed by the main route double track.
  // Read-only: branch name is real Atlas data; no main SHA is persisted,
  // so none is shown (truthful fallback, never invented).
  const harborCx = (railX0 + railX1) / 2;
  const routeTop = yardBottom;
  const harborTop = belowRail + 30;
  const harborBottom = harborTop + 96;
  parts.push(
    `<line x1="${harborCx - 7}" y1="${routeTop}" x2="${harborCx - 7}" y2="${harborTop}" stroke="#2ea043" stroke-width="2.5"/>` +
      `<line x1="${harborCx + 7}" y1="${routeTop}" x2="${harborCx + 7}" y2="${harborTop}" stroke="#2ea043" stroke-width="2.5"/>` +
      `<text x="${harborCx + 16}" y="${(routeTop + harborTop) / 2}" fill="#6e7681" font-size="9">MAIN ROUTE</text>` +
      `<rect x="${harborCx - 150}" y="${harborTop}" width="300" height="${harborBottom - harborTop}" rx="10" fill="none" stroke="#1f6feb" stroke-dasharray="8 6" opacity="0.8"/>` +
      `<path d="M ${harborCx - 130} ${harborBottom - 14} q 20 -12 40 0 t 40 0 t 40 0 t 40 0 t 40 0" fill="none" stroke="#1f6feb" stroke-width="1.5" opacity="0.6"/>` +
      `<rect x="${harborCx - 8}" y="${harborTop + 8}" width="16" height="34" fill="#161b22" stroke="#8b949e"/>` +
      `<ellipse cx="${harborCx}" cy="${harborTop + 4}" rx="10" ry="5" fill="#d29922" opacity="0.85"><title>harbor beacon</title></ellipse>` +
      `<text x="${harborCx}" y="${harborTop + 58}" fill="#e6edf3" font-size="11" text-anchor="middle">HARBOR · MAIN ${esc(data.defaultBranch)}</text>` +
      `<text x="${harborCx}" y="${harborTop + 74}" fill="#6e7681" font-size="9" text-anchor="middle">SHA unavailable — integration lands on train branches</text>`,
  );
  track({ x: railX0, y: harborBottom + 14 });
  track({ x: railX1, y: harborBottom + 14 });

  const pad = 40;
  const vbX = min.x - 160 - pad;
  const vbY = min.y - 170 - pad;
  const vbW = max.x - min.x + 320 + pad * 2;
  const vbH = max.y - min.y + 560 + pad * 2;
  const svg =
    `<div style="overflow-x:auto;background:#0a0e13;border:1px solid #21262d;border-radius:8px;padding:8px;"><svg class="deps" viewBox="${vbX} ${vbY} ${vbW} ${vbH}" role="img" aria-label="atlas island 2.5d prototype" style="background:transparent;border:none;">` +
    `<defs><filter id="issoft" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="5"/></filter>` +
    `<linearGradient id="iswater" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0b1420"/><stop offset="1" stop-color="#080e16"/></linearGradient></defs>` +
    `<rect x="${vbX}" y="${vbY}" width="${vbW}" height="${vbH}" fill="url(#iswater)"/>` +
    parts.join("") +
    `</svg></div>`;

  const legend = `<p class="muted">Prototype legend: LEVEL = dependency depth · WAVE = scheduler output (not levels) · solid conduit = prerequisite terminal · dashed = waiting · solid figure = live worker, hollow = historical · projection only — Atlas state wins.</p>`;
  const table = nodeTable(featureId, data.nodes);
  const body =
    `<h2>${esc(data.runTitle)} ${badge(data.runStatus)} <span class="tag">2.5D prototype</span></h2>${legend}` +
    (data.trainHalted ? `<div class="err">! Merge train halted — ${esc(data.trainHaltReason ?? "see train view")}.</div>` : "") +
    `<p><a class="btn" href="/run?feature=${esc(featureId)}&view=island">← proven flat Island</a> <span class="muted">The prototype is experimental; the flat view remains authoritative display.</span></p>` +
    svg +
    `<h2>Island nodes (text equivalent)</h2>${table}`;
  return layout("island prototype", featureId, "island", body, live, notice, hudHtml);
}
