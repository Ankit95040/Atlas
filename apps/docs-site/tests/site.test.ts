import { describe, expect, it } from "vitest";
import { parseRoute } from "../src/router.js";
import { DOC_SECTIONS, ALL_PAGES, findPage, pageNeighbors } from "../src/content/navigation.js";
import { EXPERIMENTS, ERAS, experimentById } from "../src/content/experiments.js";
import { SEARCH_INDEX, searchSite } from "../src/content/search.js";
import { CONTACT } from "../src/content/site.js";

describe("docs-site routing", () => {
  it("parses all route shapes", () => {
    expect(parseRoute("#/")).toEqual({ kind: "home" });
    expect(parseRoute("#/docs")).toEqual({ kind: "docs-index" });
    expect(parseRoute("#/docs/cli/run")).toEqual({ kind: "doc", section: "cli", page: "run" });
    expect(parseRoute("#/research")).toEqual({ kind: "research-index" });
    expect(parseRoute("#/research/m29-screening")).toEqual({ kind: "experiment", id: "m29-screening" });
    expect(parseRoute("#/timeline")).toEqual({ kind: "timeline" });
    expect(parseRoute("#/contact")).toEqual({ kind: "doc", section: "reference", page: "contact" });
    const nf = parseRoute("#/nope");
    expect(nf.kind).toBe("not-found");
  });
});

describe("docs-site navigation completeness", () => {
  it("every nav page resolves", () => {
    for (const p of ALL_PAGES) {
      expect(findPage(p.sectionId, p.id), `${p.sectionId}/${p.id}`).not.toBeNull();
    }
  });

  it("every nav page is reachable via prev/next chain", () => {
    const visited = new Set<string>();
    let current: { sectionId: string; id: string } | null = {
      sectionId: ALL_PAGES[0]?.sectionId ?? "",
      id: ALL_PAGES[0]?.id ?? "",
    };
    while (current !== null) {
      visited.add(`${current.sectionId}/${current.id}`);
      const { next } = pageNeighbors(current.sectionId, current.id);
      current = next === null ? null : { sectionId: next.sectionId, id: next.id };
    }
    expect(visited.size).toBe(ALL_PAGES.length);
  });

  it("has no duplicate page ids within a section", () => {
    for (const s of DOC_SECTIONS) {
      expect(new Set(s.pages.map((p) => p.id)).size).toBe(s.pages.length);
    }
  });
});

describe("docs-site experiments", () => {
  it("every experiment id is unique and resolvable", () => {
    expect(new Set(EXPERIMENTS.map((e) => e.id)).size).toBe(EXPERIMENTS.length);
    for (const e of EXPERIMENTS) {
      expect(experimentById(e.id)?.title).toBe(e.title);
    }
  });

  it("every experiment belongs to a known era", () => {
    for (const e of EXPERIMENTS) {
      expect((ERAS as readonly string[]).includes(e.era), e.id).toBe(true);
    }
  });

  it("every experiment has verdict, question, and sample size", () => {
    for (const e of EXPERIMENTS) {
      expect(e.verdict.length, e.id).toBeGreaterThan(0);
      expect(e.question.length, e.id).toBeGreaterThan(0);
      expect(e.sampleSize.length, e.id).toBeGreaterThan(0);
      expect(e.body.length, e.id).toBeGreaterThan(0);
    }
  });
});

describe("docs-site search", () => {
  it("finds pages by title and keyword", () => {
    expect(searchSite("merge train").length).toBeGreaterThan(0);
    expect(searchSite("atlas run").some((r) => r.kind === "command")).toBe(true);
    expect(searchSite("M29").some((r) => r.kind === "experiment")).toBe(true);
    expect(searchSite("claims").length).toBeGreaterThan(0);
  });

  it("returns nothing for empty queries and ranks title matches first", () => {
    expect(searchSite("   ")).toEqual([]);
    const results = searchSite("verification");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.title.toLowerCase()).toContain("verif");
  });

  it("every search entry points at a real route", () => {
    for (const entry of SEARCH_INDEX) {
      const route = entry.path.startsWith("#/") ? entry.path : `#${entry.path}`;
      const parsed = parseRoute(route);
      expect(parsed.kind, `${entry.title} -> ${entry.path}`).not.toBe("not-found");
      if (parsed.kind === "doc") {
        expect(findPage(parsed.section, parsed.page), entry.path).not.toBeNull();
      }
      if (parsed.kind === "experiment") {
        expect(experimentById(parsed.id), entry.path).toBeDefined();
      }
    }
  });
});

describe("docs-site contact config", () => {
  it("GitHub identity is live and email stays explicitly unconfigured", () => {
    expect(CONTACT.githubUrl).toBe("https://github.com/Ankit95040/Atlas");
    expect(CONTACT.issuesUrl).toBe("https://github.com/Ankit95040/Atlas/issues");
    expect(CONTACT.emailConfigured).toBe(false);
  });
});
