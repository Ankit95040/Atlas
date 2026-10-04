export type DocSection = {
  id: string;
  title: string;
  pages: DocPage[];
};

export type DocPage = {
  id: string;
  title: string;
  description: string;
  keywords: string[];
};

export const DOC_SECTIONS: DocSection[] = [
  {
    id: "start",
    title: "Getting started",
    pages: [
      {
        id: "what-is-atlas",
        title: "What Atlas is",
        description: "Headless orchestration engine: plans, claims, isolated workers, verification, ordered integration.",
        keywords: ["overview", "introduction", "control plane", "headless", "v0.1"],
      },
      {
        id: "prerequisites",
        title: "Prerequisites",
        description: "Node.js 20+, pnpm, Git identity, a coding-agent CLI, and an Atlas checkout.",
        keywords: ["install", "requirements", "node", "pnpm", "git", "opencode"],
      },
      {
        id: "configuration",
        title: "Configuration",
        description: "DATABASE_URL state resolution: explicit env, per-project .atlas/atlas.db, or legacy default.",
        keywords: ["database", "DATABASE_URL", "state-dir", "dotenv", "sqlite", "config"],
      },
      {
        id: "first-run",
        title: "First safe run",
        description: "init, proposal, plan, approve, run — the full loop on a scratch repository.",
        keywords: ["init", "plan", "run", "proposal", "approval", "tutorial"],
      },
      {
        id: "inspecting-output",
        title: "Inspecting output",
        description: "status, show, history, claims, diagnose: reading what a run actually did.",
        keywords: ["status", "show", "history", "diagnose", "claims", "inspect"],
      },
      {
        id: "cleanup",
        title: "Safe cleanup",
        description: "Worktree pruning, scratch removal, and what never to delete by hand.",
        keywords: ["cleanup", "worktree", "prune", "scratch", ".atlas"],
      },
      {
        id: "common-errors",
        title: "Common errors",
        description: "Frequent failure messages, what they mean, and the safe next step.",
        keywords: ["errors", "failed", "troubleshoot", "TIMEOUT", "NOT_AUTHORIZED"],
      },
    ],
  },
  {
    id: "concepts",
    title: "Core concepts",
    pages: [
      {
        id: "plans",
        title: "Plans and proposals",
        description: "Untrusted JSON proposals pass deterministic validation before they can influence execution.",
        keywords: ["plan", "proposal", "validation", "planner", "untrusted"],
      },
      {
        id: "tasks",
        title: "Tasks and dependencies",
        description: "Task lifecycle, dependency edges, and the deterministic claim-aware scheduler.",
        keywords: ["task", "dependency", "dag", "scheduler", "PENDING", "READY", "BLOCKED"],
      },
      {
        id: "workers",
        title: "Workers and isolation",
        description: "Approved task to isolated Git worktree to provider subprocess; Git diff is the truth.",
        keywords: ["worker", "worktree", "isolation", "provider", "argv"],
      },
      {
        id: "claims",
        title: "Claims",
        description: "Filesystem paths plus read/write access; anything unclaimed is rejected after the fact.",
        keywords: ["claims", "resource", "WRITE", "READ", "conflict", "overlap"],
      },
      {
        id: "verification",
        title: "Verification",
        description: "Atlas-executed tests and independent verification; provider self-report is metadata only.",
        keywords: ["verify", "tests", "VERIFIED", "REJECTED", "evidence"],
      },
      {
        id: "merge-train",
        title: "Merge train",
        description: "Approval-gated ordered integration onto a train branch; main is never merged; conflicts halt.",
        keywords: ["merge", "train", "integration", "conflict", "HALTED", "branch"],
      },
      {
        id: "events",
        title: "Events and approvals",
        description: "Append-only history with actors; approvals are explicit human decisions, never silent.",
        keywords: ["event", "history", "approval", "actor", "audit"],
      },
      {
        id: "recovery",
        title: "Recovery",
        description: "Stranded assignments, stuck states, and human-confirmed transitions with reasons.",
        keywords: ["recover", "stranded", "transition", "stuck", "TASK_TRANSITIONED"],
      },
    ],
  },
  {
    id: "architecture",
    title: "Architecture",
    pages: [
      {
        id: "overview",
        title: "System overview",
        description: "CLI, engine services, SQLite state, and Git as source of truth — what lives where.",
        keywords: ["architecture", "overview", "sqlite", "git", "services"],
      },
      {
        id: "lifecycle",
        title: "Execution lifecycle",
        description: "From proposal file to integrated train: every stage in order with its gates.",
        keywords: ["lifecycle", "wave", "execute", "verify", "integrate"],
      },
      {
        id: "boundaries",
        title: "Trust boundaries",
        description: "Planner boundary, provider boundary, verification boundary: who is never trusted and why.",
        keywords: ["trust", "boundary", "untrusted", "provider", "sandbox"],
      },
      {
        id: "state",
        title: "State persistence",
        description: "What SQLite holds, per-project resolution, legacy default, and migration posture.",
        keywords: ["state", "database", "prisma", "state-dir", ".atlas"],
      },
      {
        id: "security",
        title: "Security model",
        description: "Isolation guarantees and explicit non-guarantees: process isolation is not a sandbox.",
        keywords: ["security", "isolation", "sandbox", "secrets", "env"],
      },
    ],
  },
  {
    id: "cli",
    title: "CLI reference",
    pages: [
      {
        id: "doctor",
        title: "atlas doctor",
        description: "Environment and configuration diagnostics.",
        keywords: ["doctor", "diagnostics", "environment"],
      },
      {
        id: "init",
        title: "atlas init",
        description: "Register a project, repository, and first feature for a Git checkout.",
        keywords: ["init", "project", "repository", "feature", "repo-path", "state-dir"],
      },
      {
        id: "plan",
        title: "atlas plan",
        description: "Validate a proposal, persist tasks, preview the schedule, record approval.",
        keywords: ["plan", "proposal", "approve", "approval", "schedule", "max-concurrency"],
      },
      {
        id: "run",
        title: "atlas run",
        description: "Execute an approved plan through the wave loop with an explicit agent and merge approval.",
        keywords: ["run", "agent", "approve-merge", "wave", "workspace-root", "train-branch", "test-command"],
      },
      {
        id: "task-transition",
        title: "atlas task transition",
        description: "Move a stuck task along one allowed edge with actor and reason.",
        keywords: ["task", "transition", "stuck", "actor", "reason"],
      },
      {
        id: "recover",
        title: "atlas recover",
        description: "Release stranded assignments with explicit human confirmation.",
        keywords: ["recover", "stranded", "assignment", "actor"],
      },
      {
        id: "inspect",
        title: "status, show, history, claims, diagnose",
        description: "Read-only inspection paths for runs, tasks, workers, claims, and failures.",
        keywords: ["status", "show", "history", "claims", "diagnose", "inspect"],
      },
    ],
  },
  {
    id: "operations",
    title: "Fallbacks & recovery",
    pages: [
      {
        id: "provider-timeout",
        title: "Provider timeout",
        description: "Worker killed by timeout escalation: what is guaranteed and how to proceed.",
        keywords: ["timeout", "SIGTERM", "provider", "TIMEOUT", "escalation"],
      },
      {
        id: "provider-failure",
        title: "Provider failure",
        description: "Non-zero exits and spawn failures: structured classification, no silent retries.",
        keywords: ["failure", "exit", "spawn", "EXIT_NONZERO", "structured"],
      },
      {
        id: "claim-violation",
        title: "Claim violation",
        description: "Undeclared modifications rejected after the fact; task fails, evidence persists.",
        keywords: ["claim", "violation", "undeclared", "CLAIM_VIOLATION"],
      },
      {
        id: "merge-conflict",
        title: "Merge conflict",
        description: "Train halts with named items; main untouched; how to inspect and what not to force.",
        keywords: ["merge", "conflict", "HALTED", "train", "CONFLICT"],
      },
      {
        id: "verification-failure",
        title: "Verification failure",
        description: "Verdict REJECTED with reasons; nothing integrates; how to replan.",
        keywords: ["verification", "REJECTED", "reasons", "NOT_EVALUATED"],
      },
      {
        id: "stuck-states",
        title: "Stuck and interrupted runs",
        description: "Diagnosing orphaned assignments, then recover or transition with actor and reason.",
        keywords: ["stuck", "stranded", "interrupted", "orphaned", "recover", "transition"],
      },
      {
        id: "state-database",
        title: "State database failure",
        description: "Missing, locked, or unreachable SQLite state: diagnosis without destructive cleanup.",
        keywords: ["database", "sqlite", "locked", "DATABASE_URL", "prisma"],
      },
    ],
  },
  {
    id: "reference",
    title: "Reference",
    pages: [
      {
        id: "troubleshooting",
        title: "Troubleshooting",
        description: "Symptom, likely cause, diagnosis, safe resolution — indexed by what you see.",
        keywords: ["troubleshoot", "symptom", "diagnosis", "fix", "error"],
      },
      {
        id: "contributing",
        title: "Contributing",
        description: "Development setup, layout, test commands, conventions, and how to propose experiments.",
        keywords: ["contribute", "development", "pull request", "tests", "conventions"],
      },
      {
        id: "security-policy",
        title: "Security policy",
        description: "Trust boundaries, secrets handling, and how to report vulnerabilities.",
        keywords: ["security", "vulnerability", "report", "secrets", "trust"],
      },
      {
        id: "project-status",
        title: "Project status",
        description: "Experimental status, benchmark findings, advisory routing, and unproven fit — stated plainly.",
        keywords: ["status", "experimental", "roadmap", "benchmark", "routing"],
      },
      {
        id: "contact",
        title: "Contact",
        description: "Email, repository, bug reports, and research collaboration.",
        keywords: ["contact", "email", "github", "collaboration", "feedback"],
      },
    ],
  },
];

export const ALL_PAGES: Array<DocPage & { sectionId: string; sectionTitle: string }> = DOC_SECTIONS.flatMap((s) =>
  s.pages.map((p) => ({ ...p, sectionId: s.id, sectionTitle: s.title })),
);

export function findPage(sectionId: string, pageId: string): (DocPage & { sectionId: string; sectionTitle: string }) | null {
  const section = DOC_SECTIONS.find((s) => s.id === sectionId);
  const page = section?.pages.find((p) => p.id === pageId);
  if (section === undefined || page === undefined) {
    return null;
  }
  return { ...page, sectionId: section.id, sectionTitle: section.title };
}

export function pageNeighbors(sectionId: string, pageId: string): {
  prev: (DocPage & { sectionId: string }) | null;
  next: (DocPage & { sectionId: string }) | null;
} {
  const flat = ALL_PAGES;
  const index = flat.findIndex((p) => p.sectionId === sectionId && p.id === pageId);
  if (index === -1) {
    return { prev: null, next: null };
  }
  return {
    prev: flat[index - 1] ?? null,
    next: flat[index + 1] ?? null,
  };
}
