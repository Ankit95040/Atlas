import type { ReactNode } from "react";
import { Activity, Boxes, Home, Workflow } from "lucide-react";
import { cn } from "./cn.js";

const NAV = [
  { href: "#/", label: "Home", icon: Home, exact: true },
  { href: "#/runs", label: "Runs", icon: Boxes, exact: false },
  { href: "#/activity", label: "Activity", icon: Activity, exact: false },
  { href: "#/workflow", label: "Workflow", icon: Workflow, exact: false },
] as const;

export function Shell({ route, children }: { route: string; children: ReactNode }) {
  return (
    <div className="min-h-screen bg-graphite-950 text-ink-100">
      <a href="#main" className="sr-only focus:not-sr-only">
        Skip to content
      </a>
      <header className="border-b border-graphite-800 px-5 py-3 flex items-center gap-3">
        <span className="text-[15px] font-semibold tracking-wide">Atlas</span>
        <span className="text-xs text-ink-500">AI Software Engineering Control Plane</span>
      </header>
      <nav aria-label="Primary" className="border-b border-graphite-800 px-5 flex gap-1 overflow-x-auto">
        {NAV.map((item) => {
          const active = item.exact ? route === "#/" : route === item.href || route.startsWith(item.href + "/");
          const Icon = item.icon;
          return (
            <a
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-center gap-1.5 px-3 py-2.5 text-sm border-b-2 -mb-px transition-colors",
                active
                  ? "text-ink-100 border-accent-500"
                  : "text-ink-300 border-transparent hover:text-ink-100",
              )}
            >
              <Icon size={15} aria-hidden />
              {item.label}
            </a>
          );
        })}
      </nav>
      <main id="main" className="px-5 py-5 max-w-6xl mx-auto">
        {children}
      </main>
      <footer className="px-5 py-3 text-xs text-ink-500 border-t border-graphite-800">
        Atlas projection UI — orchestration stays in the engine. No actions here mutate runs.
      </footer>
    </div>
  );
}
