import { useEffect, useState } from "react";
import { fetchRuns, type ApiRunSummary } from "../api/client.js";
import { EmptyState, Eyebrow } from "../components/ui.js";
import { StatusBadge } from "../components/ui.js";

export function RunsPage() {
  const [runs, setRuns] = useState<ApiRunSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetchRuns()
      .then((list) => {
        if (live) {
          setRuns(list);
        }
      })
      .catch((err: unknown) => {
        if (live) {
          setError(err instanceof Error ? err.message : "Runs fetch failed");
        }
      });
    return () => {
      live = false;
    };
  }, []);

  if (error !== null) {
    return <EmptyState title="Runs unavailable" hint={error} />;
  }
  if (runs === null) {
    return <p role="status">Loading runs…</p>;
  }

  return (
    <section aria-label="All runs">
      <Eyebrow>Runs</Eyebrow>
      {runs.length === 0 ? (
        <EmptyState title="No runs yet" hint="Create a feature run from the CLI." />
      ) : (
        <ul className="flex flex-col gap-2">
          {runs.map((r) => (
            <li key={r.id} className="border border-graphite-800 rounded-md bg-graphite-900 px-3 py-2.5">
              <a href={`#/runs/${encodeURIComponent(r.id)}`} className="font-medium hover:underline">
                {r.title}
              </a>
              <div className="flex items-center gap-2 mt-1 text-xs text-ink-300">
                <StatusBadge status={r.status} />
                <span>{r.projectName}</span>
                <span>
                  {r.totalTasks} tasks · {r.workerCount} workers
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
