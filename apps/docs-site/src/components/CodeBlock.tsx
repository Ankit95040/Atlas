import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "./cn.js";

export type CodeBlockProps = {
  language: string;
  title?: string | undefined;
  children: string;
};

function highlightLine(line: string, language: string, key: number): React.ReactNode {
  if (language !== "sh" && language !== "bash" && language !== "json") {
    return <span key={key}>{line || " "}</span>;
  }
  // Minimal tokenizer: comments, flags/keys, strings, numbers, punctuation.
  const pattern = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|#[^\n]*|--?[a-zA-Z][\w-]*|\b\d+(?:\.\d+)?\b|\b(?:true|false|null)\b)/g;
  const parts: React.ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  let i = 0;
  while ((match = pattern.exec(line)) !== null) {
    if (match.index > last) {
      parts.push(<span key={`${key}-${i++}`}>{line.slice(last, match.index)}</span>);
    }
    const token = match[0];
    const cls = token.startsWith("#")
      ? "text-ink-600"
      : token.startsWith("--") || token.startsWith("-")
        ? "text-research-400"
        : token.startsWith('"') || token.startsWith("'")
          ? "text-ok-400"
          : "text-warn-text";
    parts.push(
      <span key={`${key}-${i++}`} className={cls}>
        {token}
      </span>,
    );
    last = match.index + token.length;
  }
  if (last < line.length) {
    parts.push(<span key={`${key}-${i++}`}>{line.slice(last)}</span>);
  }
  if (parts.length === 0) {
    return <span key={key}>{" "}</span>;
  }
  return <span key={key}>{parts}</span>;
}

export function CodeBlock({ language, title, children }: CodeBlockProps): React.ReactElement {
  const [copied, setCopied] = useState(false);
  const lines = children.replace(/\n$/, "").split("\n");
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(children);
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
      }, 1600);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="my-4 overflow-hidden rounded-lg border border-graphite-800 bg-graphite-925">
      <div className="flex items-center gap-2 border-b border-graphite-800 px-3.5 py-2">
        <span className="micro-label text-ink-500">{language}</span>
        {title !== undefined && <span className="truncate text-xs text-ink-500">{title}</span>}
        <button
          type="button"
          onClick={() => void copy()}
          aria-label={copied ? "Copied" : "Copy code to clipboard"}
          className="ml-auto flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-ink-300 transition-colors hover:bg-graphite-800 hover:text-ink-100"
        >
          {copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto p-3.5 font-mono text-[12.5px] leading-relaxed">
        <code>
          {lines.map((line, i) => (
            <span key={i} className="flex">
              <span aria-hidden className="w-8 shrink-0 select-none pr-3 text-right text-ink-600">
                {i + 1}
              </span>
              <span className="min-w-0 flex-1 whitespace-pre">{highlightLine(line, language, i)}</span>
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}

export function Callout({
  tone,
  title,
  children,
}: {
  tone: "info" | "warn" | "honest";
  title: string;
  children: React.ReactNode;
}): React.ReactElement {
  const styles =
    tone === "warn"
      ? "border-warn-500/40 bg-warn-500/10"
      : tone === "honest"
        ? "border-research-500/40 bg-research-dim"
        : "border-accent-500/40 bg-accent-dim";
  const titleColor = tone === "warn" ? "text-warn-text" : tone === "honest" ? "text-research-400" : "text-accent-400";
  return (
    <div className={cn("my-4 rounded-lg border px-4 py-3", styles)} role="note">
      <p className={cn("text-[13px] font-semibold", titleColor)}>{title}</p>
      <div className="mt-1 text-sm text-ink-100">{children}</div>
    </div>
  );
}
