import type { ApiHome, ApiRunSummary } from "../../../../src/ui/api";
import type { IslandScene } from "../../../../src/ui/island3d/scene";

export type { ApiHome, ApiRunSummary, IslandScene };

async function getData<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`Atlas API ${res.status} for ${path}`);
  }
  const body = (await res.json()) as { ok: boolean; data?: T; error?: string };
  if (body.ok !== true || body.data === undefined) {
    throw new Error(typeof body.error === "string" ? body.error : `Atlas API failed for ${path}`);
  }
  return body.data;
}

export function fetchHome(): Promise<ApiHome> {
  return getData<ApiHome>("/api/home");
}

export function fetchRuns(): Promise<ApiRunSummary[]> {
  return getData<ApiRunSummary[]>("/api/runs");
}

export function fetchIslandScene(featureId: string): Promise<IslandScene> {
  return getData<IslandScene>(`/api/run/${encodeURIComponent(featureId)}/island`);
}
