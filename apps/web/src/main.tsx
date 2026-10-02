import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Shell } from "./components/Shell.js";
import { EmptyState } from "./components/ui.js";
import { HomePage } from "./routes/Home.js";
import { RunsPage } from "./routes/Runs.js";
import { RunDetailPage } from "./routes/RunDetail.js";
import "./styles.css";

function useHashRoute(): string {
  const [route, setRoute] = useState(() => window.location.hash || "#/");
  useEffect(() => {
    const onChange = (): void => {
      setRoute(window.location.hash || "#/");
    };
    window.addEventListener("hashchange", onChange);
    return () => {
      window.removeEventListener("hashchange", onChange);
    };
  }, []);
  return route;
}

function RouteView({ route }: { route: string }) {
  if (route === "#/" || route === "") {
    return <HomePage />;
  }
  if (route === "#/runs") {
    return <RunsPage />;
  }
  const runMatch = /^#\/runs\/([^/]+)$/.exec(route);
  if (runMatch?.[1] !== undefined) {
    return <RunDetailPage featureId={decodeURIComponent(runMatch[1])} />;
  }
  if (route === "#/activity" || route === "#/workflow") {
    return (
      <EmptyState
        title="Classic UI covers this view"
        hint="Activity and Workflow stay in the SSR dashboard for this PoC; the React shell owns Home, Runs, and the Island."
      />
    );
  }
  return <EmptyState title="Unknown route" hint={route} />;
}

function App() {
  const route = useHashRoute();
  return (
    <Shell route={route}>
      <RouteView route={route} />
    </Shell>
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
