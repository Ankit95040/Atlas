// React wrapper around the proven 3D projector (src/ui/island3d/client.ts).
//
// Reuses createIslandRenderer + diff/play directly — no forked WebGL code.
// Polling mirrors the M24.2/M25.2 contract: fetch scene JSON, diff against the
// previous snapshot, update + play transitions, reduced-motion respected by
// the projector itself (nothing animates on its own).
import { useEffect, useRef, useState } from "react";
import { createIslandRenderer } from "../../../../src/ui/island3d/client";
import { diffIslandScenes } from "../../../../src/ui/island3d/transitions";
import type { IslandScene } from "../../../../src/ui/island3d/scene";
import { fetchIslandScene } from "../api/client";

const POLL_MS = 2500;

export function IslandCanvas({ featureId }: { featureId: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<string>("Loading island…");

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) {
      return;
    }
    let stopped = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let previous: IslandScene | null = null;
    let renderer: ReturnType<typeof createIslandRenderer> | null = null;

    try {
      renderer = createIslandRenderer(canvas);
    } catch (err) {
      setError(err instanceof Error ? err.message : "WebGL unavailable");
      return;
    }

    const tick = async (): Promise<void> => {
      try {
        const scene = await fetchIslandScene(featureId);
        if (stopped) {
          return;
        }
        const transitions = diffIslandScenes(previous, scene);
        previous = scene;
        renderer?.update(scene);
        if (transitions.length > 0) {
          void renderer?.play(transitions);
        }
        const d = renderer?.describe();
        setSummary(
          `${scene.buildings.length} tasks · ${scene.cars.length} merges${d === undefined ? "" : ` · ${d.objects} objects`}`,
        );
        setError(null);
      } catch (err) {
        if (!stopped) {
          setError(err instanceof Error ? err.message : "Island fetch failed");
        }
      }
    };

    void tick();
    timer = setInterval(() => {
      void tick();
    }, POLL_MS);
    return () => {
      stopped = true;
      if (timer !== undefined) {
        clearInterval(timer);
      }
      renderer?.dispose();
    };
  }, [featureId]);

  return (
    <div>
      <canvas ref={canvasRef} width={960} height={540} className="w-full rounded-md border border-graphite-800" aria-label="Atlas 3D island" />
      <p className="text-xs text-ink-500 mt-1.5" role="status">
        {error ?? summary}
      </p>
    </div>
  );
}
