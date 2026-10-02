import { IslandCanvas } from "../three/IslandCanvas.js";
import { Eyebrow } from "../components/ui.js";

export function RunDetailPage({ featureId }: { featureId: string }) {
  return (
    <div className="flex flex-col gap-4">
      <section aria-label="Run island">
        <Eyebrow>Run island · {featureId}</Eyebrow>
        <IslandCanvas featureId={featureId} />
        <p className="text-xs text-ink-500 mt-2">
          Live projection — polls every 2.5s. Drag to orbit, scroll to zoom, click a building for task detail in
          the classic UI. Nothing here mutates the run.
        </p>
      </section>
    </div>
  );
}
