import { describe, expect, it } from "vitest";
import { AGENT_CONSTRAINTS, renderSingleAgentPrompt, renderTaskPrompt } from "../src/benchmark/real/index.js";

const TASK = {
  key: "login",
  title: "Implement login helper",
  description: "Create src/auth/login.js with the specified behavior.",
  claims: [{ resource: "src/auth", access: "WRITE" }],
} as const;

describe("shared prompt renderer", () => {
  it("renders identical bytes for identical input", () => {
    const view = { ...TASK, claims: [...TASK.claims] };
    expect(renderTaskPrompt(view, "Feat")).toBe(renderTaskPrompt({ ...TASK, claims: [...TASK.claims] }, "Feat"));
  });

  it("derives the prompt from task data", () => {
    const prompt = renderTaskPrompt({ ...TASK, claims: [...TASK.claims] }, "My Feature");
    expect(prompt).toContain("Task key: login");
    expect(prompt).toContain("Implement login helper");
    expect(prompt).toContain("Create src/auth/login.js");
    expect(prompt).toContain("My Feature");
    expect(prompt).toContain("WRITE src/auth");
  });

  it("never names a strategy or the orchestration", () => {
    const prompt = renderTaskPrompt({ ...TASK, claims: [...TASK.claims] }, "Feat");
    for (const leaked of ["SINGLE_AGENT", "DUMB_PARALLEL", "ATLAS", "single-agent", "dumb", "wave", "scheduler", "orchestrat"]) {
      expect(prompt.toLowerCase()).not.toContain(leaked.toLowerCase());
    }
  });

  it("renders the union prompt from the same per-task sections", () => {
    const other = {
      key: "billing",
      title: "Implement billing helper",
      description: "Create src/billing/invoice.js.",
      claims: [{ resource: "src/billing", access: "WRITE" }],
    };
    const union = renderSingleAgentPrompt([other, { ...TASK, claims: [...TASK.claims] }], "Feat");
    expect(union).toContain(renderTaskPrompt({ ...TASK, claims: [...TASK.claims] }, "Feat"));
    expect(union).toContain(renderTaskPrompt(other, "Feat"));
    expect(union).toContain("ALL");
  });

  it("always carries the shared commit discipline", () => {
    expect(AGENT_CONSTRAINTS.join("\n")).toContain("git commit");
    const prompt = renderTaskPrompt({ ...TASK, claims: [...TASK.claims] }, "Feat");
    for (const rule of AGENT_CONSTRAINTS) {
      expect(prompt).toContain(rule);
    }
  });
});
