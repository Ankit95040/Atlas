#!/usr/bin/env node
// Atlas M14 deterministic fake CLI fixture (tests only).
//
// Stands in for a real coding-agent CLI when testing the real-agent
// benchmark harness itself: reads a behaviors file mapping task keys to
// script-agent argv, extracts the task key from the shared rendered prompt
// (proving the prompt bytes reach the worker), and delegates to
// script-agent.mjs in the same workspace. Hermetic, no network, no
// dependencies. MUST NOT be presented as real-agent performance evidence.
//
// Usage: node real-benchmark-agent.mjs <behaviors.json> <prompt>
// Behaviors file: { "<task-key>": ["--write", "path=content", "--commit", "msg"] }

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [, , behaviorsFile, ...rest] = process.argv;
const prompt = rest.join("\n");
// Every task key in the prompt gets its behavior, in prompt order. A union
// (single-agent) prompt names several keys; per-task prompts name exactly one.
const keys = [...new Set([...prompt.matchAll(/Task key: ([A-Za-z0-9][A-Za-z0-9_-]*)/g)].map((m) => m[1]))];
if (behaviorsFile === undefined || keys.length === 0) {
  console.error("real-benchmark-agent: expected <behaviors.json> and a prompt containing 'Task key: <key>'");
  process.exit(2);
}
let behaviors;
try {
  behaviors = JSON.parse(readFileSync(behaviorsFile, "utf8"));
} catch {
  console.error("real-benchmark-agent: cannot read behaviors file");
  process.exit(2);
}
const here = dirname(fileURLToPath(import.meta.url));
for (const key of keys) {
  const taskArgs = behaviors[key];
  if (!Array.isArray(taskArgs)) {
    console.error(`real-benchmark-agent: no behavior for task key ${JSON.stringify(key)}`);
    process.exit(2);
  }
  try {
    execFileSync(process.execPath, [join(here, "script-agent.mjs"), ...taskArgs], { cwd: process.cwd(), stdio: "inherit" });
  } catch {
    process.exit(1);
  }
}
