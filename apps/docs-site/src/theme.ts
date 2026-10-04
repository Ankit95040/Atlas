import { useCallback, useEffect, useState } from "react";

export type ThemeChoice = "dark" | "light" | "system";
export type ResolvedTheme = "dark" | "light";

const STORAGE_KEY = "atlas-docs-theme";

function systemTheme(): ResolvedTheme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "dark";
  }
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function readStored(): ThemeChoice {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === "dark" || raw === "light" || raw === "system") {
      return raw;
    }
  } catch {
    // Private mode / blocked storage: fall through to system.
  }
  return "system";
}

function applyTheme(choice: ThemeChoice): ResolvedTheme {
  const resolved: ResolvedTheme = choice === "system" ? systemTheme() : choice;
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.classList.toggle("light", resolved === "light");
  root.classList.toggle("dark", resolved === "dark");
  return resolved;
}

export function useTheme(): { choice: ThemeChoice; resolved: ResolvedTheme; setChoice: (c: ThemeChoice) => void } {
  const [choice, setChoiceState] = useState<ThemeChoice>(() => readStored());
  const [resolved, setResolved] = useState<ResolvedTheme>(() =>
    typeof window === "undefined" ? "dark" : applyTheme(readStored()),
  );

  useEffect(() => {
    setResolved(applyTheme(choice));
    try {
      window.localStorage.setItem(STORAGE_KEY, choice);
    } catch {
      // Storage unavailable: theme still applies for this session.
    }
  }, [choice]);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") {
      return;
    }
    const query = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = (): void => {
      setResolved(applyTheme(readStored()));
    };
    query.addEventListener("change", onChange);
    return () => {
      query.removeEventListener("change", onChange);
    };
  }, []);

  const setChoice = useCallback((c: ThemeChoice) => {
    setChoiceState(c);
  }, []);

  return { choice, resolved, setChoice };
}
