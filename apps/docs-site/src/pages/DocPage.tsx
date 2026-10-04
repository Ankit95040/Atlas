import { Article, headingsOf, type ArticleBlock } from "../content/article.js";
import { findPage } from "../content/navigation.js";
import { START_ARTICLES } from "../content/articles-start.js";
import { CONCEPTS_ARTICLES } from "../content/articles-concepts.js";
import { ARCH_ARTICLES } from "../content/articles-arch.js";
import { CLI_ARTICLES } from "../content/articles-cli.js";
import { OPS_ARTICLES } from "../content/articles-ops.js";
import { REF_ARTICLES } from "../content/articles-ref.js";
import { DocsSidebar, TableOfContents, PrevNext, Breadcrumbs } from "../components/DocsNav.js";

const MAP: Record<string, Record<string, ArticleBlock[]>> = {
  start: START_ARTICLES,
  concepts: CONCEPTS_ARTICLES,
  architecture: ARCH_ARTICLES,
  cli: CLI_ARTICLES,
  operations: OPS_ARTICLES,
  reference: REF_ARTICLES,
};

export function DocPage({ section, page }: { section: string; page: string }): React.ReactElement {
  const meta = findPage(section, page);
  const blocks = MAP[section]?.[page];
  if (meta === null || blocks === undefined) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
        <h1 className="display-title">Page not found</h1>
        <p className="mt-2 text-ink-300">
          No documentation page exists at this address. <a href="#/docs" className="text-accent-400 hover:underline">Browse all documentation</a>.
        </p>
      </div>
    );
  }
  const headings = headingsOf(blocks);
  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <div className="grid gap-10 lg:grid-cols-[15rem_minmax(0,1fr)_12rem]">
        <aside className="hidden lg:block">
          <div className="sticky top-24 max-h-[calc(100vh-7rem)] overflow-y-auto">
            <DocsSidebar section={section} page={page} />
          </div>
        </aside>
        <article className="min-w-0">
          <Breadcrumbs trail={[{ label: "Docs", href: "#/docs" }, { label: meta.sectionTitle }, { label: meta.title }]} />
          <h1 className="display-title mt-3">{meta.title}</h1>
          <p className="mt-1.5 text-[15px] text-ink-500">{meta.description}</p>
          <div className="mt-5">
            <Article blocks={blocks} />
          </div>
          <PrevNext section={section} page={page} />
        </article>
        <aside className="hidden xl:block">
          <div className="sticky top-24 max-h-[calc(100vh-7rem)] overflow-y-auto">
            <TableOfContents headings={headings} />
          </div>
        </aside>
      </div>
    </div>
  );
}

export function DocsIndex(): React.ReactElement {
  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <h1 className="display-title">Documentation</h1>
      <p className="mt-2 max-w-2xl text-ink-300">
        Everything Atlas does, stated plainly: setup, concepts, architecture, CLI, recovery, and reference.
      </p>
      <div className="mt-8 grid gap-4 md:grid-cols-2">
        {(
          [
            { href: "#/docs/start/what-is-atlas", title: "Getting started", text: "Install, configure, and complete your first safe run." },
            { href: "#/docs/concepts/plans", title: "Core concepts", text: "Plans, tasks, claims, workers, verification, merge train." },
            { href: "#/docs/architecture/overview", title: "Architecture", text: "System layers, lifecycle, trust boundaries, security model." },
            { href: "#/docs/cli/doctor", title: "CLI reference", text: "Every command and flag, verified against source." },
            { href: "#/docs/operations/provider-timeout", title: "Fallbacks & recovery", text: "What happened, what is guaranteed, how to recover safely." },
            { href: "#/docs/reference/troubleshooting", title: "Reference", text: "Troubleshooting, contributing, security, status, contact." },
          ] as const
        ).map((card) => (
          <a
            key={card.href}
            href={card.href}
            className="group rounded-lg border border-graphite-800 bg-graphite-900 px-5 py-4 transition-colors hover:border-graphite-700"
          >
            <span className="text-[15px] font-semibold text-ink-100 group-hover:underline">{card.title}</span>
            <span className="mt-1 block text-sm text-ink-500">{card.text}</span>
          </a>
        ))}
      </div>
    </div>
  );
}
