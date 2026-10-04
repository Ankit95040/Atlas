import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { parseRoute, useHashRoute } from "./router.js";
import { SiteHeader, MobileNav } from "./components/SiteHeader.js";
import { SiteFooter } from "./components/SiteFooter.js";
import { LandingPage } from "./pages/LandingPage.js";
import { DocPage, DocsIndex } from "./pages/DocPage.js";
import { ResearchIndex, ExperimentCard, TimelinePage } from "./pages/Research.js";
import { ResearchCharts } from "./pages/ResearchCharts.js";
import "./styles.css";

function NotFound({ route }: { route: string }): React.ReactElement {
  return (
    <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
      <h1 className="display-title">Page not found</h1>
      <p className="mt-2 text-ink-300">
        No page exists at <code className="font-mono text-sm">{route}</code>. Try{" "}
        <a href="#/docs" className="text-accent-400 hover:underline">documentation</a>,{" "}
        <a href="#/research" className="text-accent-400 hover:underline">research</a>, or the search box above.
      </p>
    </div>
  );
}

function ResearchLanding(): React.ReactElement {
  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <p className="micro-label text-research-400">Research &amp; experiments</p>
      <h1 className="display-section mt-2 max-w-3xl">Built in the open. Tested against evidence.</h1>
      <p className="mt-3 max-w-2xl text-ink-300">
        Atlas documents what worked, what failed, and what the experiments could not establish. Start with the
        numbers, then read the full record — including the negative results.
      </p>
      <div className="mt-8">
        <ResearchCharts />
      </div>
      <div className="mt-6 flex flex-wrap gap-3">
        <a
          href="#/research"
          className="inline-flex items-center gap-1.5 rounded-md border border-research-500/50 bg-research-dim px-4 py-2 text-sm font-medium text-research-400"
        >
          Browse all experiments
        </a>
        <a
          href="#/timeline"
          className="inline-flex items-center gap-1.5 rounded-md border border-graphite-700 px-4 py-2 text-sm font-medium text-ink-100 transition-colors hover:bg-graphite-900"
        >
          Engineering timeline
        </a>
      </div>
    </div>
  );
}

function App(): React.ReactElement {
  const hash = useHashRoute();
  const [menuOpen, setMenuOpen] = useState(false);
  const route = parseRoute(hash);
  return (
    <div className="flex min-h-screen flex-col bg-graphite-950 text-ink-100">
      <a href="#main" className="sr-only focus:not-sr-only">
        Skip to content
      </a>
      <SiteHeader
        onMenu={() => {
          setMenuOpen(true);
        }}
      />
      <MobileNav
        open={menuOpen}
        onClose={() => {
          setMenuOpen(false);
        }}
      />
      <main id="main" className="flex-1">
        {route.kind === "home" && <LandingPage />}
        {route.kind === "docs-index" && <DocsIndex />}
        {route.kind === "doc" && <DocPage section={route.section} page={route.page} />}
        {route.kind === "research-index" && (
          <>
            <ResearchLanding />
            <div className="mx-auto max-w-6xl px-4 pb-10 sm:px-6">
              <ResearchIndex compact />
            </div>
          </>
        )}
        {route.kind === "experiment" && <ExperimentCard id={route.id} />}
        {route.kind === "timeline" && <TimelinePage />}
        {route.kind === "not-found" && <NotFound route={route.route} />}
      </main>
      <SiteFooter />
    </div>
  );
}

const rootEl = document.getElementById("root");
if (rootEl === null) {
  throw new Error("missing #root");
}
createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
