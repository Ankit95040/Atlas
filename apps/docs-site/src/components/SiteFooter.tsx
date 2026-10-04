import { CONTACT } from "../content/site.js";

export function SiteFooter(): React.ReactElement {
  return (
    <footer className="border-t border-graphite-800 bg-graphite-925">
      <div className="mx-auto grid max-w-7xl gap-8 px-4 py-10 sm:px-6 md:grid-cols-4">
        <div>
          <p className="flex items-center gap-2">
            <span aria-hidden className="h-4 w-4 rounded-[4px] bg-accent-500" />
            <span className="text-sm font-semibold">Atlas</span>
          </p>
          <p className="mt-2 max-w-xs text-[13px] text-ink-500">
            Experimental control plane for orchestrating AI coding agents with isolation, verification, and human
            control.
          </p>
          {!CONTACT.emailConfigured && (
            <p className="mt-2 max-w-xs text-xs text-ink-600">
              Project email pending configuration — GitHub Issues is the primary contact route.
            </p>
          )}
        </div>
        <nav aria-label="Documentation">
          <p className="micro-label mb-2 text-ink-500">Documentation</p>
          <ul className="flex flex-col gap-1.5 text-[13px]">
            <li><a className="text-ink-300 hover:text-ink-100" href="#/docs/start/what-is-atlas">Getting started</a></li>
            <li><a className="text-ink-300 hover:text-ink-100" href="#/docs/concepts/plans">Core concepts</a></li>
            <li><a className="text-ink-300 hover:text-ink-100" href="#/docs/cli/doctor">CLI reference</a></li>
            <li><a className="text-ink-300 hover:text-ink-100" href="#/docs/operations/provider-timeout">Fallbacks &amp; recovery</a></li>
            <li><a className="text-ink-300 hover:text-ink-100" href="#/docs/reference/troubleshooting">Troubleshooting</a></li>
          </ul>
        </nav>
        <nav aria-label="Research">
          <p className="micro-label mb-2 text-ink-500">Research</p>
          <ul className="flex flex-col gap-1.5 text-[13px]">
            <li><a className="text-ink-300 hover:text-ink-100" href="#/research">Experiment archive</a></li>
            <li><a className="text-ink-300 hover:text-ink-100" href="#/timeline">Timeline</a></li>
            <li><a className="text-ink-300 hover:text-ink-100" href="#/research/m29-screening">Latest screening</a></li>
            <li><a className="text-ink-300 hover:text-ink-100" href="#/docs/reference/project-status">Project status</a></li>
          </ul>
        </nav>
        <nav aria-label="Contact">
          <p className="micro-label mb-2 text-ink-500">Contact</p>
          <ul className="flex flex-col gap-1.5 text-[13px]">
            <li>
              <a className="text-ink-300 hover:text-ink-100" href={CONTACT.githubUrl}>
                GitHub repository
              </a>
            </li>
            <li>
              <a className="text-ink-300 hover:text-ink-100" href={CONTACT.issuesUrl}>
                Report an issue
              </a>
            </li>
            <li><a className="text-ink-300 hover:text-ink-100" href="#/docs/reference/contributing">Contributing</a></li>
            <li><a className="text-ink-300 hover:text-ink-100" href="#/docs/reference/contact">Collaboration</a></li>
          </ul>
        </nav>
      </div>
      <div className="border-t border-graphite-800">
        <p className="mx-auto max-w-7xl px-4 py-4 text-xs text-ink-600 sm:px-6">
          Atlas v0.1 — experimental. Benchmark figures show sample sizes beside every claim. Routing remains
          advisory; automatic routing is disabled.
        </p>
      </div>
    </footer>
  );
}
