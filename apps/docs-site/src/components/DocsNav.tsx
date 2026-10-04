import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import { DOC_SECTIONS, pageNeighbors } from "../content/navigation.js";
import { cn } from "./cn.js";

export function DocsSidebar({ section: activeSection, page: activePage }: { section: string; page: string }): React.ReactElement {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  useEffect(() => {
    setOpen((prev) => ({ ...prev, [activeSection]: true }));
  }, [activeSection]);
  return (
    <nav aria-label="Documentation sections" className="flex flex-col gap-4">
      {DOC_SECTIONS.map((section) => {
        const expanded = open[section.id] ?? section.id === activeSection;
        return (
          <div key={section.id}>
            <button
              type="button"
              onClick={() => {
                setOpen((prev) => ({ ...prev, [section.id]: !expanded }));
              }}
              aria-expanded={expanded}
              className="flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-graphite-900"
            >
              <span className={cn("text-[13px] font-semibold", section.id === activeSection ? "text-ink-100" : "text-ink-300")}>
                {section.title}
              </span>
              <ChevronDown
                size={14}
                aria-hidden
                className={cn("shrink-0 text-ink-500 transition-transform", expanded ? "rotate-180" : "rotate-0")}
              />
            </button>
            {expanded && (
              <ul className="mt-0.5 flex flex-col gap-px border-l border-graphite-800 pl-1">
                {section.pages.map((p) => {
                  const active = section.id === activeSection && p.id === activePage;
                  return (
                    <li key={p.id}>
                      <a
                        href={`#/docs/${section.id}/${p.id}`}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "block rounded-md px-2.5 py-1.5 text-[13px] transition-colors",
                          active
                            ? "border-l-2 border-accent-500 bg-graphite-800 text-ink-100"
                            : "border-l-2 border-transparent text-ink-300 hover:bg-graphite-900 hover:text-ink-100",
                        )}
                      >
                        {p.title}
                      </a>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        );
      })}
    </nav>
  );
}

export function TableOfContents({ headings }: { headings: Array<{ id: string; text: string; level: number }> }): React.ReactElement | null {
  const [current, setCurrent] = useState<string | null>(null);
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setCurrent(entry.target.id);
          }
        }
      },
      { rootMargin: "-20% 0px -70% 0px" },
    );
    for (const h of headings) {
      const el = document.getElementById(h.id);
      if (el !== null) {
        observer.observe(el);
      }
    }
    return () => {
      observer.disconnect();
    };
  }, [headings]);
  if (headings.length === 0) {
    return (
      <nav aria-label="On this page" className="text-[13px]">
        <p className="micro-label mb-2 text-ink-500">On this page</p>
        <p className="text-ink-600">Single-section reference.</p>
      </nav>
    );
  }
  return (
    <nav aria-label="On this page" className="text-[13px]">
      <p className="micro-label mb-2 text-ink-500">On this page</p>
      <ul className="flex flex-col gap-1 border-l border-graphite-800">
        {headings.map((h) => (
          <li key={h.id}>
            <a
              href={`#${h.id}`}
              onClick={(e) => {
                e.preventDefault();
                document.getElementById(h.id)?.scrollIntoView({ behavior: "smooth", block: "start" });
                window.history.replaceState(null, "", `#${h.id}`);
              }}
              aria-current={current === h.id ? "true" : undefined}
              className={cn(
                "-ml-px block border-l-2 py-0.5 pr-2 transition-colors",
                h.level === 3 ? "pl-6" : "pl-3",
                current === h.id ? "border-accent-500 text-ink-100" : "border-transparent text-ink-500 hover:text-ink-300",
              )}
            >
              {h.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function PrevNext({ section, page }: { section: string; page: string }): React.ReactElement {
  const { prev, next } = pageNeighbors(section, page);
  return (
    <nav aria-label="Documentation pages" className="mt-10 grid gap-3 border-t border-graphite-800 pt-6 sm:grid-cols-2">
      {prev !== null ? (
        <a
          href={`#/docs/${prev.sectionId}/${prev.id}`}
          className="group rounded-lg border border-graphite-800 bg-graphite-900 px-4 py-3 transition-colors hover:border-graphite-700"
        >
          <span className="micro-label text-ink-500">← Previous</span>
          <span className="mt-0.5 block text-sm font-medium text-ink-100 group-hover:underline">{prev.title}</span>
        </a>
      ) : (
        <span />
      )}
      {next !== null ? (
        <a
          href={`#/docs/${next.sectionId}/${next.id}`}
          className="group rounded-lg border border-graphite-800 bg-graphite-900 px-4 py-3 text-right transition-colors hover:border-graphite-700"
        >
          <span className="micro-label text-ink-500">Next →</span>
          <span className="mt-0.5 block text-sm font-medium text-ink-100 group-hover:underline">{next.title}</span>
        </a>
      ) : (
        <span />
      )}
    </nav>
  );
}

export function Breadcrumbs({ trail }: { trail: Array<{ label: string; href?: string }> }): React.ReactElement {
  return (
    <nav aria-label="Breadcrumb">
      <ol className="flex flex-wrap items-center gap-1.5 text-[13px] text-ink-500">
        {trail.map((item, i) => (
          <li key={i} className="flex items-center gap-1.5">
            {i > 0 && (
              <span aria-hidden className="text-ink-600">
                /
              </span>
            )}
            {item.href !== undefined ? (
              <a href={item.href} className="transition-colors hover:text-ink-100">
                {item.label}
              </a>
            ) : (
              <span aria-current="page" className="text-ink-300">
                {item.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
