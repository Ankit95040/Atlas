import { ALL_PAGES } from "./navigation.js";
import { EXPERIMENTS } from "./experiments.js";

export type SearchEntry = {
  kind: "page" | "experiment" | "command" | "concept";
  title: string;
  path: string;
  excerpt: string;
  haystack: string;
};

const COMMANDS: Array<{ name: string; summary: string; path: string }> = [
  { name: "atlas doctor", summary: "Check Node.js, Git, Docker, configuration, and database connectivity.", path: "/docs/start/prerequisites" },
  { name: "atlas init", summary: "Create project, repository, and feature rows for a Git checkout.", path: "/docs/cli/init" },
  { name: "atlas plan", summary: "Validate a proposal file, persist tasks, preview the schedule.", path: "/docs/cli/plan" },
  { name: "atlas run", summary: "Execute an approved plan through the wave loop.", path: "/docs/cli/run" },
  { name: "atlas task transition", summary: "Move a stuck task along one allowed edge with actor and reason.", path: "/docs/cli/task-transition" },
  { name: "atlas recover task", summary: "Release a stranded assignment with human confirmation.", path: "/docs/cli/recover" },
  { name: "atlas status", summary: "Read-only overview of task/worker states and failures.", path: "/docs/cli/inspect" },
  { name: "atlas show run", summary: "Show a run scope: tasks, workers, integration, timing.", path: "/docs/cli/inspect" },
  { name: "atlas show task", summary: "Show a task: status, dependencies, claims, evidence.", path: "/docs/cli/inspect" },
  { name: "atlas show worker", summary: "Show a worker: assignment, workspace, execution, failures.", path: "/docs/cli/inspect" },
  { name: "atlas history", summary: "Chronological event history for a run.", path: "/docs/cli/inspect" },
  { name: "atlas claims", summary: "Task/resource claims with pairwise overlaps.", path: "/docs/cli/inspect" },
  { name: "atlas diagnose", summary: "Failure analysis from persisted structured evidence.", path: "/docs/cli/inspect" },
];

const CONCEPTS: Array<{ name: string; summary: string; path: string }> = [
  { name: "Claims", summary: "Filesystem paths plus read/write access; unclaimed writes are rejected.", path: "/docs/concepts/claims" },
  { name: "Worktree isolation", summary: "One isolated Git worktree per worker; Git diff is the truth.", path: "/docs/concepts/workers" },
  { name: "Verification", summary: "Atlas-executed tests; provider self-report is metadata only.", path: "/docs/concepts/verification" },
  { name: "Merge train", summary: "Ordered integration; halts on conflict; main is never merged.", path: "/docs/concepts/merge-train" },
  { name: "Human approval", summary: "Plan approval and merge approval are explicit, actor-stamped decisions.", path: "/docs/concepts/events" },
  { name: "Recovery", summary: "Stranded assignments released only with human confirmation.", path: "/docs/concepts/recovery" },
  { name: "Routing advisory", summary: "Deterministic classifier; advisory only; automatic routing disabled.", path: "/docs/reference/project-status" },
  { name: "Shadow mode", summary: "Recommendations recorded but never acted upon without the adoption gate.", path: "/docs/reference/project-status" },
  { name: "COMPLETED_EMPTY", summary: "Valid execution with no effective contribution; distinct from success and failure.", path: "/docs/operations/verification-failure" },
  { name: "TASK_TRANSITIONED", summary: "Event recording a human-confirmed stuck-state exit with actor and reason.", path: "/docs/concepts/recovery" },
];

export const SEARCH_INDEX: SearchEntry[] = [
  ...ALL_PAGES.map((p) => ({
    kind: "page" as const,
    title: p.title,
    path: `/docs/${p.sectionId}/${p.id}`,
    excerpt: p.description,
    haystack: `${p.title} ${p.description} ${p.keywords.join(" ")} ${p.sectionTitle}`.toLowerCase(),
  })),
  ...EXPERIMENTS.map((e) => ({
    kind: "experiment" as const,
    title: `${e.milestone}: ${e.title}`,
    path: `/research/${e.id}`,
    excerpt: e.verdict,
    haystack: `${e.milestone} ${e.title} ${e.question} ${e.verdict} ${e.categories.join(" ")} ${e.era}`.toLowerCase(),
  })),
  ...COMMANDS.map((c) => ({
    kind: "command" as const,
    title: c.name,
    path: c.path,
    excerpt: c.summary,
    haystack: `${c.name} ${c.summary} cli command`.toLowerCase(),
  })),
  ...CONCEPTS.map((c) => ({
    kind: "concept" as const,
    title: c.name,
    path: c.path,
    excerpt: c.summary,
    haystack: `${c.name} ${c.summary} concept`.toLowerCase(),
  })),
];

export function searchSite(query: string, limit = 12): SearchEntry[] {
  const terms = query.toLowerCase().trim().split(/\s+/).filter((t) => t.length > 0);
  if (terms.length === 0) {
    return [];
  }
  const scored = SEARCH_INDEX.map((entry) => {
    let score = 0;
    for (const term of terms) {
      if (entry.title.toLowerCase().includes(term)) {
        score += 3;
      }
      if (entry.haystack.includes(term)) {
        score += 1;
      }
    }
    return { entry, score };
  }).filter((s) => s.score >= terms.length);
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.entry);
}
