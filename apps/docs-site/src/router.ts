import { useEffect, useState } from "react";

export function useHashRoute(): string {
  const [route, setRoute] = useState(() => window.location.hash || "#/");
  useEffect(() => {
    const onChange = (): void => {
      setRoute(window.location.hash || "#/");
      window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
    };
    window.addEventListener("hashchange", onChange);
    return () => {
      window.removeEventListener("hashchange", onChange);
    };
  }, []);
  return route;
}

export type SiteRoute =
  | { kind: "home" }
  | { kind: "docs-index" }
  | { kind: "doc"; section: string; page: string }
  | { kind: "research-index" }
  | { kind: "experiment"; id: string }
  | { kind: "timeline" }
  | { kind: "not-found"; route: string };

export function parseRoute(hash: string): SiteRoute {
  const clean = hash.startsWith("#") ? hash.slice(1) : hash;
  if (clean === "/" || clean === "") {
    return { kind: "home" };
  }
  if (clean === "/docs") {
    return { kind: "docs-index" };
  }
  const doc = /^\/docs\/([^/]+)\/([^/]+)$/.exec(clean);
  if (doc?.[1] !== undefined && doc?.[2] !== undefined) {
    return { kind: "doc", section: decodeURIComponent(doc[1]), page: decodeURIComponent(doc[2]) };
  }
  if (clean === "/research") {
    return { kind: "research-index" };
  }
  const exp = /^\/research\/([^/]+)$/.exec(clean);
  if (exp?.[1] !== undefined) {
    return { kind: "experiment", id: decodeURIComponent(exp[1]) };
  }
  if (clean === "/timeline") {
    return { kind: "timeline" };
  }
  if (clean === "/contact") {
    return { kind: "doc", section: "reference", page: "contact" };
  }
  return { kind: "not-found", route: clean };
}
