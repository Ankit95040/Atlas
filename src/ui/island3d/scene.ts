import type { WorkflowGraphData } from "../data.js";
import { layoutLevels } from "../views.js";

// Pure 3D scene descriptor for the Atlas Island visual engine (M25.1).
//
// Deterministic projection input: WorkflowGraphData in, plain JSON out.
// No rendering, no DOM, no WebGL, no Atlas writes here — the three.js client
// projector consumes this descriptor and nothing else. Levels reuse the
// existing dependency-depth layout; waves stay scheduler metadata.

export interface SceneBuilding {
  readonly taskId: string;
  readonly title: string;
  readonly status: string;
  readonly level: number;
  readonly col: number;
  readonly x: number;
  readonly z: number;
  readonly wave: number | null;
  readonly verdict: string | null;
  readonly integrated: boolean;
  readonly dependsOn: string[];
  readonly worker: { readonly id: string; readonly status: string; readonly link: "live" | "historical" } | null;
}

export interface ScenePath {
  readonly fromTaskId: string;
  readonly toTaskId: string;
  readonly satisfied: boolean;
}

export interface SceneGate {
  readonly taskId: string;
  readonly title: string;
  readonly verdict: string;
  readonly reasons: string[];
}

export interface SceneCar {
  readonly taskId: string;
  readonly title: string;
  readonly sha: string;
  readonly subject: string;
  readonly order: number;
}

export interface IslandScene {
  readonly runId: string;
  readonly runTitle: string;
  readonly runStatus: string;
  readonly seed: number;
  readonly bounds: { readonly cols: number; readonly rows: number };
  readonly buildings: SceneBuilding[];
  readonly paths: ScenePath[];
  readonly gates: SceneGate[];
  readonly cars: SceneCar[];
  readonly halt: { readonly reason: string } | null;
  readonly harbor: { readonly branch: string };
  readonly phases: Array<{ readonly name: string; readonly active: boolean }>;
  readonly waves: Array<{ readonly n: number; readonly titles: string[] }>;
}

const TERMINAL_PREREQ = new Set(["COMPLETED", "COMPLETED_EMPTY"]);

export const COL_GAP = 6;
export const ROW_GAP = 7;

/** Deterministic 32-bit hash for terrain seeding (FNV-1a, pure). */
export function hashSeed(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.codePointAt(i) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function buildIslandScene(data: WorkflowGraphData): IslandScene {
  const levels = layoutLevels(
    data.nodes.map((n) => ({ id: n.id })),
    data.edges,
  );
  const byId = new Map(data.nodes.map((n) => [n.id, n] as const));
  const buildings: SceneBuilding[] = [];
  levels.forEach((level, li) => {
    level.forEach((id, ni) => {
      const node = byId.get(id);
      if (node === undefined) {
        return;
      }
      buildings.push({
        taskId: node.id,
        title: node.title,
        status: node.status,
        level: li,
        col: ni,
        x: (ni - (level.length - 1) / 2) * COL_GAP,
        z: li * ROW_GAP,
        wave: node.wave,
        verdict: node.verdict,
        integrated: node.integrated,
        dependsOn: [...node.dependsOn],
        worker:
          node.workerId === null || node.workerLink === "none"
            ? null
            : { id: node.workerId, status: node.workerStatus ?? "?", link: node.workerLink },
      });
    });
  });
  // Deterministic order: level, then column.
  buildings.sort((a, b) => a.level - b.level || a.col - b.col);

  const edgeSet = new Set(data.edges.map((e) => `${e.from}→${e.to}`));
  const paths: ScenePath[] = [...edgeSet].map((key) => {
    const [from = "", to = ""] = key.split("→");
    const prereq = byId.get(from);
    return { fromTaskId: from, toTaskId: to, satisfied: prereq !== undefined && TERMINAL_PREREQ.has(prereq.status) };
  });
  paths.sort((a, b) => (a.fromTaskId < b.fromTaskId ? -1 : 1) || (a.toTaskId < b.toTaskId ? -1 : 1));

  const gates: SceneGate[] = data.nodes
    .filter((n) => n.verdict !== null)
    .map((n) => ({ taskId: n.id, title: n.title, verdict: n.verdict as string, reasons: [...n.reasons] }))
    .sort((a, b) => (a.taskId < b.taskId ? -1 : 1));

  const cars: SceneCar[] = data.trainCars.map((car, order) => ({
    taskId: car.taskId,
    title: car.title,
    sha: car.sha,
    subject: car.subject,
    order,
  }));

  const waveGroups = new Map<number, string[]>();
  for (const node of data.nodes) {
    if (node.wave !== null) {
      const group = waveGroups.get(node.wave) ?? [];
      group.push(node.title);
      waveGroups.set(node.wave, group);
    }
  }
  const maxCols = levels.reduce((m, l) => Math.max(m, l.length), 0);
  return {
    runId: data.runId,
    runTitle: data.runTitle,
    runStatus: data.runStatus,
    seed: hashSeed(data.runId),
    bounds: { cols: maxCols, rows: levels.length },
    buildings,
    paths,
    gates,
    cars,
    halt: data.trainHalted ? { reason: data.trainHaltReason ?? "see train view" } : null,
    harbor: { branch: data.defaultBranch },
    phases: data.phases.map((p) => ({ name: p.name, active: p.active })),
    waves: [...waveGroups.entries()].sort((a, b) => a[0] - b[0]).map(([n, titles]) => ({ n, titles: [...titles].sort() })),
  };
}
