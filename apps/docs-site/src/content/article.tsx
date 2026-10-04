import { useMemo } from "react";
import { CodeBlock, Callout } from "../components/CodeBlock.js";

export type ArticleBlock =
  | { kind: "intro"; text: string }
  | { kind: "h2"; id: string; text: string }
  | { kind: "h3"; id: string; text: string }
  | { kind: "p"; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "code"; language: string; title?: string; code: string }
  | { kind: "callout"; tone: "info" | "warn" | "honest"; title: string; text: string }
  | { kind: "table"; head: string[]; rows: string[][] };

export type TocHeading = { id: string; text: string; level: number };

export function headingsOf(blocks: ArticleBlock[]): TocHeading[] {
  return blocks
    .filter((b): b is { kind: "h2"; id: string; text: string } | { kind: "h3"; id: string; text: string } =>
      b.kind === "h2" || b.kind === "h3",
    )
    .map((b) => ({ id: b.id, text: b.text, level: b.kind === "h2" ? 2 : 3 }));
}

function renderInline(text: string, keyPrefix: string): React.ReactNode {
  // Minimal inline markdown: `code`, **bold**, [label](href).
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g;
  const parts: React.ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  let i = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) {
      parts.push(<span key={`${keyPrefix}-${i++}`}>{text.slice(last, match.index)}</span>);
    }
    const token = match[0];
    if (token.startsWith("`")) {
      parts.push(
        <code
          key={`${keyPrefix}-${i++}`}
          className="rounded-[5px] border border-graphite-700 bg-graphite-800 px-[0.38em] py-[0.1em] font-mono text-[0.82em]"
        >
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("**")) {
      parts.push(
        <strong key={`${keyPrefix}-${i++}`} className="font-semibold">
          {token.slice(2, -2)}
        </strong>,
      );
    } else {
      const label = /^\[([^\]]+)\]/.exec(token)?.[1] ?? token;
      const href = /^\[[^\]]+\]\(([^)]+)\)/.exec(token)?.[1] ?? "#";
      parts.push(
        <a key={`${keyPrefix}-${i++}`} href={href} className="text-accent-400 hover:underline">
          {label}
        </a>,
      );
    }
    last = match.index + token.length;
  }
  if (last < text.length) {
    parts.push(<span key={`${keyPrefix}-${i++}`}>{text.slice(last)}</span>);
  }
  return <>{parts}</>;
}

export function Article({ blocks }: { blocks: ArticleBlock[] }): React.ReactElement {
  const rendered = useMemo(
    () =>
      blocks.map((block, i) => {
        switch (block.kind) {
          case "intro":
            return (
              <p key={i} className="text-[1.05rem] leading-relaxed text-ink-300">
                {renderInline(block.text, `intro-${i}`)}
              </p>
            );
          case "h2":
            return (
              <h2 key={i} id={block.id}>
                {block.text}
              </h2>
            );
          case "h3":
            return (
              <h3 key={i} id={block.id}>
                {block.text}
              </h3>
            );
          case "p":
            return <p key={i}>{renderInline(block.text, `p-${i}`)}</p>;
          case "list":
            return (
              <ul key={i}>
                {block.items.map((item, j) => (
                  <li key={j}>{renderInline(item, `li-${i}-${j}`)}</li>
                ))}
              </ul>
            );
          case "code":
            return (
              <CodeBlock key={i} language={block.language} title={block.title}>
                {block.code}
              </CodeBlock>
            );
          case "callout":
            return (
              <Callout key={i} tone={block.tone} title={block.title}>
                {renderInline(block.text, `co-${i}`)}
              </Callout>
            );
          case "table":
            return (
              <div key={i} className="overflow-x-auto">
                <table>
                  <thead>
                    <tr>
                      {block.head.map((h, j) => (
                        <th key={j} scope="col">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, j) => (
                      <tr key={j}>
                        {row.map((cell, k) => (
                          <td key={k}>{renderInline(cell, `t-${i}-${j}-${k}`)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
        }
      }),
    [blocks],
  );
  return <div className="prose-atlas">{rendered}</div>;
}
