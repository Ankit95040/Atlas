import { useEffect, useState } from "react";
import { fetchHome, type ApiHome } from "../api/client.js";
import { EmptyState, Eyebrow, Metric } from "../components/ui.js";
import { StatusBadge } from "../components/ui.js";

export function HomePage() {
  const [home, setHome] = useState<ApiHome | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetchHome()
      .then((h) => {
        if (live) {
          setHome(h);
        }
      })
      .catch((err: unknown) => {
        if (live) {
          setError(err instanceof Error ? err.message : "Home fetch failed");
        }
      });
    return () => {
      live = false;
    };
  }, []);

  if (error !== null) {
    return <EmptyState title="Home unavailable" hint={error} />;
  }
  if (home === null) {
    return <p role="status">Loading control-plane state…</p>;
  }

  return (
    <div className="flex flex-col gap-6">
      <section aria-label="Fleet metrics">
        <Eyebrow>Control plane</Eyebrow>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
          <Metric label="Projects" value={home.metrics.projects} />
          <Metric label="Runs" value={home.metrics.runs} />
          <Metric label="Tasks" value={home.metrics.tasks} />
          <Metric label="Live workers" value={home.metrics.liveWorkers} />
          <Metric label="Verified" value={home.metrics.verified} />
          <Metric label="Merges" value={home.metrics.merges} />
        </div>
      </section>

      <section aria-label="Active runs">
        <Eyebrow>Active runs</Eyebrow>
        {home.activeRuns.length === 0 ? (
          <EmptyState title="No active runs" hint="Start a run from the CLI; it appears here." />
        ) : (
          <ul className="flex flex-col gap-2">
            {home.activeRuns.map((r) => (
              <li key={r.id} className="border border-graphite-800 rounded-md bg-graphite-900 px-3 py-2.5">
                <a href={`#/runs/${encodeURIComponent(r.id)}`} className="font-medium hover:underline">
                  {r.title}
                </a>
                <div className="flex items-center gap-2 mt-1 text-xs text-ink-300">
                  <StatusBadge status={r.status} />
                  <span>
                    {r.totalTasks} tasks · {r.workerCount} workers · {r.verifiedCount} verified · {r.mergeCount} merges
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Recent runs">
        <Eyebrow>Recent runs</Eyebrow>
        {home.recentRuns.length === 0 ? (
          <EmptyState title="No recent runs" />
        ) : (
          <ul className="flex flex-col gap-2">
            {home.recentRuns.map((r) => (
              <li key={r.id} className="border border-graphite-800 rounded-md bg-graphite-900 px-3 py-2.5">
                <a href={`#/runs/${encodeURIComponent(r.id)}`} className="font-medium hover:underline">
                  {r.title}
                </a>
                <div className="flex items-center gap-2 mt-1 text-xs text-ink-300">
                  <StatusBadge status={r.status} />
                  <span>
                    {r.totalTasks} tasks · {r.verifiedCount} verified · {r.mergeCount} merges
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
