import type { RealWorkloadTaskSpec } from "./types.js";

export interface PromptTaskView {
  readonly key: string;
  readonly title: string;
  readonly description: string;
  readonly claims: ReadonlyArray<{ readonly resource: string; readonly access: string }>;
}

/**
 * Fixed harness constraints shared by every strategy. These describe the
 * execution contract (workspace isolation, claim enforcement, commit
 * discipline) — never which strategy the agent serves, and never a hint
 * about the "right" implementation.
 */
export const AGENT_CONSTRAINTS: readonly string[] = [
  "Work only inside the current directory: it is your isolated workspace.",
  "Only create or modify files covered by your WRITE resource claims; anything else fails claim enforcement.",
  "Do not modify files outside your claims, do not push, do not change branches.",
  "When finished, stage and commit your work with git (git add -A and git commit).",
  "Verify your work by running the repository test command before committing when one exists.",
];

function claimsBlock(claims: PromptTaskView["claims"]): string {
  return claims.map((claim) => `- ${claim.access} ${claim.resource}`).join("\n");
}

/**
 * Render one task prompt from task data only. The identical function feeds
 * SINGLE_AGENT (per section), DUMB_PARALLEL, and ATLAS — prompt quality can
 * never explain a strategy gap because the bytes are shared.
 */
export function renderTaskPrompt(task: PromptTaskView, featureTitle: string): string {
  return [
    `Task key: ${task.key}`,
    `Feature: ${featureTitle}`,
    `Title: ${task.title}`,
    ``,
    task.description,
    ``,
    `Resource claims:`,
    claimsBlock(task.claims),
    ``,
    `Constraints:`,
    ...AGENT_CONSTRAINTS.map((rule) => `- ${rule}`),
  ].join("\n");
}

/** Union prompt for the single-agent arm: every task section, same renderer, same constraints. */
export function renderSingleAgentPrompt(tasks: ReadonlyArray<PromptTaskView>, featureTitle: string): string {
  const sections = [...tasks]
    .sort((a, b) => (a.key < b.key ? -1 : 1))
    .map((task) => renderTaskPrompt(task, featureTitle));
  return [`Complete ALL of the following tasks in this workspace.`, ``, ...sections].join("\n");
}
