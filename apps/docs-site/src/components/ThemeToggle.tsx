import { useEffect, useRef, useState } from "react";
import { Check, Laptop, Moon, Sun } from "lucide-react";
import { useTheme, type ThemeChoice } from "../theme.js";
import { cn } from "./cn.js";

const OPTIONS: Array<{ value: ThemeChoice; label: string; hint: string; Icon: typeof Sun }> = [
  { value: "light", label: "Light", hint: "Paper surfaces", Icon: Sun },
  { value: "dark", label: "Dark", hint: "Graphite instrument", Icon: Moon },
  { value: "system", label: "System", hint: "Follow the OS", Icon: Laptop },
];

export function ThemeToggle(): React.ReactElement {
  const { choice, setChoice } = useTheme();
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const CurrentIcon = OPTIONS.find((o) => o.value === choice)?.Icon ?? Moon;

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

  return (
    <div ref={boxRef} className="relative">
      <button
        type="button"
        onClick={() => {
          setOpen((o) => !o);
        }}
        aria-label={`Theme: ${choice}. Activate to change.`}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded-md border border-graphite-800 bg-graphite-900 px-2.5 py-1.5 text-[13px] text-ink-300 transition-colors hover:border-graphite-700 hover:text-ink-100"
      >
        <CurrentIcon size={14} aria-hidden />
        <span className="hidden capitalize xl:inline">{choice}</span>
      </button>
      {open && (
        <div className="absolute right-0 z-50 mt-2 w-52 overflow-hidden rounded-lg border border-graphite-700 bg-graphite-900 shadow-2xl">
          <ul role="listbox" aria-label="Color theme" className="py-1">
            {OPTIONS.map((opt) => {
              const Icon = opt.Icon;
              const selected = choice === opt.value;
              return (
                <li key={opt.value}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onClick={() => {
                      setChoice(opt.value);
                      setOpen(false);
                    }}
                    className={cn(
                      "flex w-full items-center gap-2.5 px-3.5 py-2 text-left",
                      selected ? "bg-graphite-800" : "bg-transparent hover:bg-graphite-800/60",
                    )}
                  >
                    <Icon size={15} aria-hidden className="shrink-0 text-ink-300" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-medium text-ink-100">{opt.label}</span>
                      <span className="block truncate text-xs text-ink-500">{opt.hint}</span>
                    </span>
                    {selected && <Check size={14} aria-hidden className="shrink-0 text-accent-400" />}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
