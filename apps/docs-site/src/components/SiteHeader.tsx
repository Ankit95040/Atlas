import { useEffect, useRef, useState } from "react";
import { BookOpen, FlaskConical, Home, Menu, Network, Search, X } from "lucide-react";
import { useHashRoute } from "../router.js";
import { searchSite, type SearchEntry } from "../content/search.js";
import { CONTACT } from "../content/site.js";
import { ThemeToggle } from "./ThemeToggle.js";
import { cn } from "./cn.js";

const LINKS = [
  { href: "#/", label: "Home", icon: Home, match: (r: string) => r === "#/" || r === "" },
  { href: "#/docs", label: "Docs", icon: BookOpen, match: (r: string) => r.startsWith("#/docs") && !r.startsWith("#/docs/architecture") },
  { href: "#/research", label: "Research", icon: FlaskConical, match: (r: string) => r.startsWith("#/research") || r.startsWith("#/timeline") },
  { href: "#/docs/architecture/overview", label: "Architecture", icon: Network, match: (r: string) => r.startsWith("#/docs/architecture") },
] as const;

// Geometric Atlas identity: one orchestration core fanning into three
// isolated worker nodes — the system map reduced to a mark. Single accent
// fill, graphite strokes, legible at 16px.
function BrandMark(): React.ReactElement {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden fill="none">
      <path d="M11 3v5M11 8L4.5 16M11 8l6.5 8" stroke="#2f7cf6" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="11" cy="3.4" r="2.4" fill="#2f7cf6" />
      <circle cx="3.6" cy="17.4" r="2" fill="#0b0e14" stroke="#5b9bff" strokeWidth="1.6" />
      <circle cx="11" cy="18.2" r="2" fill="#0b0e14" stroke="#5b9bff" strokeWidth="1.6" />
      <circle cx="18.4" cy="17.4" r="2" fill="#0b0e14" stroke="#5b9bff" strokeWidth="1.6" />
    </svg>
  );
}

function SearchBox({ onNavigate }: { onNavigate: () => void }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const results = searchSite(query);

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onDocClick = (e: MouseEvent): void => {
      if (boxRef.current !== null && !boxRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open ]);

  useEffect(() => {
    const onSlash = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      if (e.key === "/" && target !== null && !["INPUT", "TEXTAREA"].includes(target.tagName)) {
        e.preventDefault();
        setOpen(true);
        setTimeout(() => inputRef.current?.focus(), 0);
      }
    };
    document.addEventListener("keydown", onSlash);
    return () => {
      document.removeEventListener("keydown", onSlash);
    };
  }, []);

  const go = (entry: SearchEntry): void => {
    setOpen(false);
    setQuery("");
    onNavigate();
    window.location.hash = entry.path;
  };

  return (
    <div ref={boxRef} className="relative">
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          setTimeout(() => inputRef.current?.focus(), 0);
        }}
        aria-label="Search documentation and research"
        className="flex items-center gap-2 rounded-md border border-graphite-800 bg-graphite-900 px-2.5 py-1.5 text-[13px] text-ink-500 transition-colors hover:border-graphite-700 hover:text-ink-300"
      >
        <Search size={14} aria-hidden />
        <span className="hidden sm:inline">Search</span>
        <kbd className="hidden rounded border border-graphite-700 px-1 font-mono text-[10px] text-ink-600 md:inline">/</kbd>
      </button>
      {open && (
        <div className="absolute right-0 z-50 mt-2 w-[min(24rem,calc(100vw-2rem))] overflow-hidden rounded-lg border border-graphite-700 bg-graphite-900 shadow-2xl">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, results.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === "Enter" && results[active] !== undefined) {
                go(results[active] as SearchEntry);
              }
            }}
            placeholder="Search docs, commands, experiments…"
            aria-label="Search query"
            className="w-full border-b border-graphite-800 bg-transparent px-3.5 py-2.5 text-sm outline-none placeholder:text-ink-600"
          />
          <ul className="max-h-80 overflow-y-auto py-1" role="listbox" aria-label="Search results">
            {results.length === 0 && query.trim() !== "" && (
              <li className="px-3.5 py-3 text-sm text-ink-500">No results. Try a command name, concept, or milestone.</li>
            )}
            {results.map((entry, i) => (
              <li key={entry.path + entry.title}>
                <button
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  onMouseEnter={() => {
                    setActive(i);
                  }}
                  onClick={() => {
                    go(entry);
                  }}
                  className={cn(
                    "flex w-full flex-col gap-0.5 px-3.5 py-2 text-left",
                    i === active ? "bg-graphite-800" : "bg-transparent",
                  )}
                >
                  <span className="flex items-center gap-2 text-[13px] font-medium text-ink-100">
                    <span className="micro-label text-ink-600">{entry.kind}</span>
                    <span className="truncate">{entry.title}</span>
                  </span>
                  <span className="truncate text-xs text-ink-500">{entry.excerpt}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function SiteHeader({ onMenu }: { onMenu: () => void }): React.ReactElement {
  const route = useHashRoute();
  return (
    <header role="banner" className="sticky top-0 z-40 border-b border-graphite-800 bg-graphite-950/95 backdrop-blur">
      {/* Desktop: three zones — brand left, nav geometrically centered, actions right */}
      <div className="mx-auto hidden h-14 max-w-7xl grid-cols-[1fr_auto_1fr] items-center gap-3 px-4 sm:px-6 lg:grid">
        <div className="flex min-w-0 items-center justify-start">
          <a href="#/" className="flex shrink-0 items-center gap-2" aria-label="Atlas home">
            <BrandMark />
            <span className="text-[15px] font-semibold tracking-wide">Atlas</span>
            <span className="hidden rounded-full border border-graphite-700 px-1.5 py-px font-mono text-[10px] text-ink-500 xl:inline">
              v0.1 experimental
            </span>
          </a>
        </div>
        <nav aria-label="Primary" className="flex items-center gap-0.5 justify-self-center">
          {LINKS.map((item) => {
            const active = item.match(route);
            const Icon = item.icon;
            return (
              <a
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13.5px] transition-colors",
                  active ? "bg-graphite-800 text-ink-100" : "text-ink-300 hover:bg-graphite-900 hover:text-ink-100",
                )}
              >
                <Icon size={14} aria-hidden />
                {item.label}
              </a>
            );
          })}
        </nav>
        <div className="flex min-w-0 items-center justify-end gap-2">
          <ThemeToggle />
          <SearchBox onNavigate={() => undefined} />
          <a
            href={CONTACT.githubUrl}
            className="hidden shrink-0 rounded-md border border-graphite-800 px-2.5 py-1.5 text-[13px] text-ink-300 transition-colors hover:border-graphite-700 hover:text-ink-100 xl:inline-block"
          >
            GitHub
          </a>
          <a
            href="#/docs/reference/contact"
            className="shrink-0 rounded-md bg-accent-500 px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-accent-400"
          >
            Contact us
          </a>
        </div>
      </div>
      {/* Below lg: compact bar (brand + actions) */}
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-2 px-4 sm:px-6 lg:hidden">
        <button
          type="button"
          onClick={onMenu}
          aria-label="Open navigation"
          className="rounded-md p-1.5 text-ink-300 hover:bg-graphite-800 hover:text-ink-100"
        >
          <Menu size={18} aria-hidden />
        </button>
        <a href="#/" className="flex shrink-0 items-center gap-2" aria-label="Atlas home">
          <BrandMark />
          <span className="text-[15px] font-semibold tracking-wide">Atlas</span>
        </a>
        <div className="ml-auto flex items-center gap-2">
          <ThemeToggle />
          <SearchBox onNavigate={() => undefined} />
          <a
            href="#/docs/reference/contact"
            className="shrink-0 rounded-md bg-accent-500 px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-accent-400"
          >
            Contact us
          </a>
        </div>
      </div>
      <nav aria-label="Primary mobile" className="flex items-center gap-0.5 overflow-x-auto border-t border-graphite-800 px-4 py-1.5 lg:hidden">
        {LINKS.map((item) => {
          const active = item.match(route);
          return (
            <a
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "whitespace-nowrap rounded-md px-2.5 py-1 text-[13px]",
                active ? "bg-graphite-800 text-ink-100" : "text-ink-300",
              )}
            >
              {item.label}
            </a>
          );
        })}
      </nav>
    </header>
  );
}

export function MobileNav({ open, onClose }: { open: boolean; onClose: () => void }): React.ReactElement | null {
  const panelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) {
      return;
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    // Focus the close control on open.
    panelRef.current?.querySelector<HTMLButtonElement>('button[aria-label="Close navigation"]')?.focus();
    const panel = panelRef.current;
    const focusables = (): HTMLElement[] =>
      panel === null
        ? []
        : [...panel.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')].filter(
            (el) => el.offsetParent !== null,
          );
    const trap = (e: KeyboardEvent): void => {
      if (e.key !== "Tab") {
        return;
      }
      const items = focusables();
      if (items.length === 0) {
        return;
      }
      const first = items[0] as HTMLElement;
      const last = items[items.length - 1] as HTMLElement;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", trap);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("keydown", trap);
    };
  }, [open, onClose]);
  if (!open) {
    return null;
  }
  return (
    <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Site navigation">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} aria-hidden />
      <div ref={panelRef} className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col border-r border-graphite-800 bg-graphite-925 p-4">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-2">
            <BrandMark />
            <span className="text-sm font-semibold">Atlas</span>
          </span>
          <button type="button" onClick={onClose} aria-label="Close navigation" className="rounded-md p-1.5 text-ink-300 hover:bg-graphite-800">
            <X size={18} aria-hidden />
          </button>
        </div>
        <nav aria-label="Mobile site" className="mt-4 flex flex-col gap-0.5">
          {LINKS.map((item) => (
            <a
              key={item.href}
              href={item.href}
              onClick={onClose}
              className="rounded-md px-2.5 py-2 text-sm text-ink-300 hover:bg-graphite-800 hover:text-ink-100"
            >
              {item.label}
            </a>
          ))}
          <a href="#/docs" onClick={onClose} className="rounded-md px-2.5 py-2 text-sm text-ink-300 hover:bg-graphite-800 hover:text-ink-100">
            All documentation
          </a>
          <a href="#/research" onClick={onClose} className="rounded-md px-2.5 py-2 text-sm text-ink-300 hover:bg-graphite-800 hover:text-ink-100">
            All experiments
          </a>
          <a href="#/timeline" onClick={onClose} className="rounded-md px-2.5 py-2 text-sm text-ink-300 hover:bg-graphite-800 hover:text-ink-100">
            Timeline
          </a>
        </nav>
        <div className="mt-auto flex flex-col gap-2 pt-4">
          <a
            href={CONTACT.githubUrl}
            onClick={onClose}
            className="rounded-md border border-graphite-700 px-2.5 py-2 text-center text-sm text-ink-100 transition-colors hover:bg-graphite-800"
          >
            GitHub repository
          </a>
          <a
            href="#/docs/reference/contact"
            onClick={onClose}
            className="rounded-md bg-accent-500 px-2.5 py-2 text-center text-sm font-medium text-white transition-colors hover:bg-accent-400"
          >
            Contact us
          </a>
        </div>
      </div>
    </div>
  );
}
