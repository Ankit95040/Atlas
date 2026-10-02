// Atlas read-only inspection commands (M19.5).
//
// All functions here only read: Prisma finds, Git worktree inspection is
// deliberately NOT included (worktrees may be cleaned; state rows are the
// contract). No task, worker, approval, or merge is created, decided, or
// executed. Output follows cli/output.py conventions: human text by default,
// the same data object as JSON with --json.
//
// Run scope: base Atlas has no Run entity, so run-scoped commands resolve
// <run-id> as a FEATURE id — one feature execution is one run. Anything else
// is a usage error naming the expectation explicitly.
import type { PrismaClient } from "@prisma/client";
import { getPrismaClient } from "../db/client.js";
import { compareClaimSets } from "../claims/conflicts.js";
import { getTaskClaims } from "../claims/service.js";
import { classifyRecoveryEligibility, findHistoricalWorkerId, payloadWorkerId } from "../workspaces/index.js";
import { EXIT_OK, type CommandOutput } from "./output.js";

function usageError(message: string): Error {
  const error = new Error(message);
  error.name = "ShowUsageError";
  return error;
}

function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : value;
}

async function resolveFeature(db: PrismaClient, runId: string) {
  const feature = await db.feature.findUnique({ where: { id: runId } });
  if (feature === null) {
    throw usageError(`unknown run scope: expected a feature ID, got ${JSON.stringify(runId)}`);
  }
  return feature;
}

function eventLine(row: { type: string; taskId: string | null; createdAt: Date }): string {
  return `${iso(row.createdAt)} ${row.type}${row.taskId !== null ? ` task=${row.taskId.slice(0, 8)}` : ""}`;
}

/** Latest payload for an event type, or null when absent/unparseable. */
function latestPayload(
  events: ReadonlyArray<{ type: string; payload: string | null }>,
  type: string,
): Record<string, unknown> | null {
  const found = [...events].reverse().find((e) => e.type === type);
  if (found?.payload == null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(found.payload);
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Corrupt payload: treat as absent rather than misdiagnosing.
  }
  return null;
}

function describeCommandKind(code: string): string {
  switch (code) {
    case "TIMEOUT":
      return "timed out";
    case "EXIT_NONZERO":
      return "exited non-zero";
    case "SPAWN_FAILED":
      return "failed to start";
    case "OUTPUT_OVERFLOW":
      return "produced excessive output";
    default:
      return `failed (${code})`;
  }
}

/** atlas status: active/recent runs, task/worker states, visible failures. */
export async function runStatusCommand(
  options: { limit?: number },
  db: PrismaClient = getPrismaClient(),
): Promise<CommandOutput> {
  const limit = options.limit ?? 20;
  const [tasks, workers, events] = await Promise.all([
    db.task.findMany({ select: { id: true, status: true, featureId: true } }),
    db.worker.findMany({ select: { id: true, status: true, taskId: true } }),
    db.event.findMany({ orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit }),
  ]);
  const taskStates: Record<string, number> = {};
  for (const task of tasks) {
    taskStates[task.status] = (taskStates[task.status] ?? 0) + 1;
  }
  const workerCounts: Record<string, number> = {};
  for (const worker of workers) {
    const status = (worker.status ?? "UNKNOWN") as string;
    workerCounts[status] = (workerCounts[status] ?? 0) + 1;
  }
  const failedTasks = tasks.filter((t) => t.status === "FAILED").length;
  const lines = [
    "atlas status",
    `tasks: ${tasks.length} (${Object.entries(taskStates)
      .map(([s, n]) => `${s}=${n}`)
      .join(", ") || "none"})`,
    `workers: ${workers.length} (${Object.entries(workerCounts)
      .map(([s, n]) => `${s}=${n}`)
      .join(", ") || "none"})`,
    `failed tasks: ${failedTasks}`,
    `recent events (${events.length}):`,
    ...events.map((e) => `  - ${eventLine(e)}`),
  ];
  return {
    exitCode: EXIT_OK,
    human: lines.join("\n"),
    data: {
      taskStates,
      workerStates: workerCounts,
      failedTasks,
      recentEvents: events.map((e) => ({ id: e.id, type: e.type, taskId: e.taskId, createdAt: iso(e.createdAt) })),
    },
  };
}

/** Shared feature-scope loader for run/history/claims/diagnose. */
async function loadFeatureScope(db: PrismaClient, runId: string) {
  const feature = await resolveFeature(db, runId);
  const [tasks, approvals] = await Promise.all([
    db.task.findMany({ where: { featureId: feature.id }, orderBy: { id: "asc" } }),
    db.approval.findMany({ where: { featureId: feature.id }, orderBy: { decidedAt: "asc" } }),
  ]);
  return { feature, tasks, approvals };
}

/** atlas show run <run-id>: identity, tasks, workers, integration, timing, failures. */
export async function runShowRunCommand(
  options: { runId: string },
  db: PrismaClient = getPrismaClient(),
): Promise<CommandOutput> {
  const { feature, tasks, approvals } = await loadFeatureScope(db, options.runId);
  const taskIds = tasks.map((t) => t.id);
  const [liveWorkers, testRuns, commits, events] = await Promise.all([
    db.worker.findMany({ where: { taskId: { in: taskIds } } }),
    db.testRun.findMany({ where: { taskId: { in: taskIds } }, orderBy: { createdAt: "asc" } }),
    db.commit.findMany({ where: { taskId: { in: taskIds } }, orderBy: { createdAt: "asc" } }),
    db.event.findMany({ where: { featureId: feature.id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
  ]);
  // M23.1: released terminal links vanish from the live query above; resolve
  // historical workers from this run's own event payloads so the run still
  // reports who did the work. Never confuse "unassigned now" with "no history".
  const liveIds = new Set(liveWorkers.map((w) => w.id));
  const historicalIds: string[] = [];
  for (const event of events) {
    const workerId = payloadWorkerId(event.payload);
    if (workerId !== null && !liveIds.has(workerId) && !historicalIds.includes(workerId)) {
      historicalIds.push(workerId);
    }
  }
  const historicalWorkers =
    historicalIds.length === 0 ? [] : await db.worker.findMany({ where: { id: { in: historicalIds } } });
  const workers = [
    ...liveWorkers.map((w) => ({ ...w, link: "live" as const })),
    ...historicalWorkers.map((w) => ({ ...w, link: "historical" as const })),
  ];
  const trainBranches = [...new Set(commits.map((c) => c.branch).filter((b): b is string => b !== null))];
  const failed = tasks.filter((t) => t.status === "FAILED");
  const lines = [
    `atlas show run ${feature.id}`,
    `feature: ${feature.title} (status ${feature.status})`,
    `tasks: ${tasks.length} (${tasks.map((t) => `${t.id.slice(0, 8)}=${t.status}`).join(", ") || "none"})`,
    `workers: ${workers.length} (${workers.map((w) => `${w.id.slice(0, 8)}=${w.status}${w.link === "historical" ? " (historical)" : ""}`).join(", ") || "none"})`,
    `test runs: ${testRuns.length} (latest: ${
      testRuns.length > 0 ? `${testRuns[testRuns.length - 1]?.status} exit=${testRuns[testRuns.length - 1]?.exitCode}` : "none"
    })`,
    `train branches: ${trainBranches.join(", ") || "none"}`,
    `merge commits: ${commits.length}`,
    `events: ${events.length}`,
    `failed tasks: ${failed.map((t) => t.id.slice(0, 8)).join(", ") || "none"}`,
    `approvals: ${approvals.map((a) => `${a.id.slice(0, 8)}=${a.status}`).join(", ") || "none"}`,
  ];
  return {
    exitCode: EXIT_OK,
    human: lines.join("\n"),
    data: {
      feature: { id: feature.id, title: feature.title, status: feature.status },
      tasks: tasks.map((t) => ({ id: t.id, title: t.title, status: t.status })),
      workers: workers.map((w) => ({ id: w.id, status: w.status, taskId: w.taskId, link: w.link })),
      testRuns: testRuns.map((r) => ({
        id: r.id,
        taskId: r.taskId,
        status: r.status,
        exitCode: r.exitCode,
        startedAt: iso(r.startedAt),
        finishedAt: iso(r.finishedAt),
      })),
      trainBranches,
      mergeCommits: commits.map((c) => ({ sha: c.sha, branch: c.branch, taskId: c.taskId })),
      eventCount: events.length,
      failedTasks: failed.map((t) => t.id),
      approvals: approvals.map((a) => ({ id: a.id, status: a.status })),
    },
  };
}

/** atlas show task <task-id>: identity, deps, claims, assignment, evidence, timing. */
export async function runShowTaskCommand(
  options: { taskId: string },
  db: PrismaClient = getPrismaClient(),
): Promise<CommandOutput> {
  const task = await db.task.findUnique({ where: { id: options.taskId } });
  if (task === null) {
    throw usageError(`unknown task: ${JSON.stringify(options.taskId)}`);
  }
  const [claims, liveWorker, testRuns, commits, events, dependsOn, dependents] = await Promise.all([
    getTaskClaims(task.id, db),
    db.worker.findFirst({ where: { taskId: task.id } }),
    db.testRun.findMany({ where: { taskId: task.id }, orderBy: { createdAt: "asc" } }),
    db.commit.findMany({ where: { taskId: task.id }, orderBy: { createdAt: "asc" } }),
    db.event.findMany({ where: { taskId: task.id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
    db.taskDependency.findMany({ where: { taskId: task.id } }),
    db.taskDependency.findMany({ where: { dependsOnTaskId: task.id } }),
  ]);
  // M23.1: the live link may be released (terminal worker); history still
  // names the latest worker via event payloads. Never confuse "unassigned
  // now" with "never had a worker".
  let worker = liveWorker;
  let workerLink: "live" | "historical" | null = liveWorker === null ? null : "live";
  if (worker === null) {
    const historicalId = await findHistoricalWorkerId(db, task.id);
    if (historicalId !== null) {
      worker = await db.worker.findUnique({ where: { id: historicalId } });
      workerLink = worker === null ? null : "historical";
    }
  }
  const workspace = worker === null ? null : await db.workspace.findUnique({ where: { workerId: worker.id } });
  const verified = events.filter((e) => e.type === "VERIFICATION_COMPLETED");
  // Read-only eligibility display from the single authoritative classifier;
  // never authorizes mutation by itself.
  const recovery = classifyRecoveryEligibility({
    taskId: task.id,
    taskStatus: task.status,
    worker: worker === null ? null : { id: worker.id, status: worker.status, taskId: worker.taskId },
    hasWorkspace: workspace !== null,
  });
  const lines = [
    `atlas show task ${task.id}`,
    `title: ${task.title}`,
    `status: ${task.status}`,
    `depends on: ${dependsOn.map((d) => d.dependsOnTaskId.slice(0, 8)).join(", ") || "none"}`,
    `required by: ${dependents.map((d) => d.taskId.slice(0, 8)).join(", ") || "none"}`,
    `claims: ${claims.map((c) => `${c.resourceId}:${c.access}`).join(", ") || "none"}`,
    `worker: ${
      worker === null
        ? "unassigned"
        : `${worker.id.slice(0, 8)} (${worker.status}${workerLink === "historical" ? ", historical" : ""})`
    }`,
    `workspace: ${workspace?.path ?? "none"}${workspace?.branch ? ` (branch ${workspace.branch})` : ""}`,
    `test runs: ${testRuns.map((r) => `${r.status}/exit=${r.exitCode}`).join(", ") || "none"}`,
    `verification: ${
      verified.length > 0 ? `completed (${verified.length}x; latest payload below)` : "no VERIFICATION_COMPLETED event recorded"
    }`,
    `merge commits: ${commits.map((c) => `${c.sha.slice(0, 12)}@${c.branch ?? "?"}`).join(", ") || "none"}`,
    `events: ${events.length}`,
    `recovery: ${recovery.class}`,
    `reason: ${recovery.reason}`,
    ...(recovery.nextCommand !== undefined ? [`next: ${recovery.nextCommand}`] : []),
  ];
  return {
    exitCode: EXIT_OK,
    human: lines.join("\n"),
    data: {
      task: { id: task.id, title: task.title, status: task.status, featureId: task.featureId },
      recovery: {
        class: recovery.class,
        reason: recovery.reason,
        ...(recovery.nextCommand !== undefined ? { nextCommand: recovery.nextCommand } : {}),
      },
      dependsOn: dependsOn.map((d) => d.dependsOnTaskId),
      requiredBy: dependents.map((d) => d.taskId),
      claims: claims.map((c) => ({ resourceId: c.resourceId, access: c.access })),
      worker:
        worker === null
          ? null
          : {
              id: worker.id,
              status: worker.status,
              ...(workerLink === "historical" ? { link: "historical" as const } : {}),
            },
      workspace: workspace === null ? null : { path: workspace.path, branch: workspace.branch, status: workspace.status },
      testRuns: testRuns.map((r) => ({
        id: r.id,
        status: r.status,
        exitCode: r.exitCode,
        startedAt: iso(r.startedAt),
        finishedAt: iso(r.finishedAt),
      })),
      verificationEvents: verified.map((e) => ({ createdAt: iso(e.createdAt), payload: e.payload })),
      mergeCommits: commits.map((c) => ({ sha: c.sha, branch: c.branch })),
      eventCount: events.length,
    },
  };
}

/** atlas show worker <worker-id>: assignment, workspace, execution, failures, timing. */
export async function runShowWorkerCommand(
  options: { workerId: string },
  db: PrismaClient = getPrismaClient(),
): Promise<CommandOutput> {
  const worker = await db.worker.findUnique({ where: { id: options.workerId }, include: { workspace: true } });
  if (worker === null) {
    throw usageError(`unknown worker: ${JSON.stringify(options.workerId)}`);
  }
  // M23.1: a terminal worker's live link is released; its historical task is
  // still provable from the canonical workspace branch
  // (atlas/worker/<worker-id>/task/<task-id>).
  let linkedTaskId = worker.taskId;
  let assignmentLink: "live" | "historical" | null = linkedTaskId === null ? null : "live";
  if (linkedTaskId === null && worker.workspace?.branch !== null && worker.workspace?.branch !== undefined) {
    const segments = worker.workspace.branch.split("/");
    if (
      segments.length === 5 &&
      segments[0] === "atlas" &&
      segments[1] === "worker" &&
      segments[2] === worker.id &&
      segments[3] === "task" &&
      (segments[4]?.length ?? 0) > 0
    ) {
      linkedTaskId = segments[4] as string;
      assignmentLink = "historical";
    }
  }
  const task = linkedTaskId === null ? null : await db.task.findUnique({ where: { id: linkedTaskId } });
  const testRuns = linkedTaskId === null ? [] : await db.testRun.findMany({ where: { taskId: linkedTaskId }, orderBy: { createdAt: "asc" } });
  const events = linkedTaskId === null ? [] : await db.event.findMany({ where: { taskId: linkedTaskId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  const failures = events.filter((e) => e.type === "TASK_FAILED");
  const lines = [
    `atlas show worker ${worker.id}`,
    `status: ${worker.status}`,
    `assignment: ${
      linkedTaskId === null
        ? "none"
        : `${linkedTaskId.slice(0, 8)} (task ${task?.status ?? "?"}${assignmentLink === "historical" ? ", historical" : ""})`
    }`,
    `workspace: ${worker.workspace?.path ?? "none"}${worker.workspace?.branch ? ` (branch ${worker.workspace.branch}, ${worker.workspace.status})` : ""}`,
    `test runs: ${testRuns.map((r) => `${r.status}/exit=${r.exitCode}`).join(", ") || "none"}`,
    `failures recorded: ${failures.length}`,
    `events: ${events.length}`,
  ];
  return {
    exitCode: EXIT_OK,
    human: lines.join("\n"),
    data: {
      worker: { id: worker.id, status: worker.status, taskId: worker.taskId },
      task: task === null ? null : { id: task.id, title: task.title, status: task.status },
      workspace: worker.workspace === null ? null : { path: worker.workspace.path, branch: worker.workspace.branch, status: worker.workspace.status },
      testRuns: testRuns.map((r) => ({
        id: r.id,
        status: r.status,
        exitCode: r.exitCode,
        startedAt: iso(r.startedAt),
        finishedAt: iso(r.finishedAt),
      })),
      failureCount: failures.length,
      eventCount: events.length,
    },
  };
}

/** atlas history <run-id>: chronological event history for the run scope. */
export async function runHistoryCommand(
  options: { runId: string },
  db: PrismaClient = getPrismaClient(),
): Promise<CommandOutput> {
  const { feature } = await loadFeatureScope(db, options.runId);
  const events = await db.event.findMany({ where: { featureId: feature.id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  const lines = [
    `atlas history ${feature.id} (${events.length} events)`,
    ...events.map(
      (e) => `  - ${iso(e.createdAt)} ${e.type}${e.taskId !== null ? ` task=${e.taskId.slice(0, 8)}` : ""}${e.actor !== null ? ` actor=${e.actor}` : ""}`,
    ),
  ];
  return {
    exitCode: EXIT_OK,
    human: lines.join("\n"),
    data: {
      runId: feature.id,
      events: events.map((e) => ({ id: e.id, type: e.type, taskId: e.taskId, actor: e.actor, createdAt: iso(e.createdAt), payload: e.payload })),
    },
  };
}

/** atlas claims <run-id>: task/resource claims with pairwise overlaps. */
export async function runClaimsCommand(
  options: { runId: string },
  db: PrismaClient = getPrismaClient(),
): Promise<CommandOutput> {
  const { feature, tasks } = await loadFeatureScope(db, options.runId);
  const perTask: Array<{ taskId: string; claims: Array<{ resourceId: string; access: string }> }> = [];
  const claimSets = new Map<string, Awaited<ReturnType<typeof getTaskClaims>>>();
  for (const task of tasks) {
    const claims = await getTaskClaims(task.id, db);
    claimSets.set(task.id, claims);
    perTask.push({ taskId: task.id, claims: claims.map((c) => ({ resourceId: c.resourceId, access: c.access })) });
  }
  const overlaps: Array<{ taskA: string; taskB: string; details: unknown }> = [];
  for (let i = 0; i < perTask.length; i += 1) {
    for (let j = i + 1; j < perTask.length; j += 1) {
      const a = perTask[i];
      const b = perTask[j];
      if (a === undefined || b === undefined) {
        continue;
      }
      const comparison = compareClaimSets(claimSets.get(a.taskId) ?? [], claimSets.get(b.taskId) ?? []);
      if (comparison.status === "CONFLICT") {
        overlaps.push({ taskA: a.taskId, taskB: b.taskId, details: comparison.conflicts });
      }
    }
  }
  const lines = [
    `atlas claims ${feature.id} (${tasks.length} tasks)`,
    ...perTask.map((t) => `  - ${t.taskId.slice(0, 8)}: ${t.claims.map((c) => `${c.resourceId}:${c.access}`).join(", ") || "none"}`),
    `overlaps: ${overlaps.length === 0 ? "none" : ""}`,
    ...overlaps.map((o) => `  - ${o.taskA.slice(0, 8)} <-> ${o.taskB.slice(0, 8)}: ${JSON.stringify(o.details)}`),
  ];
  return { exitCode: EXIT_OK, human: lines.join("\n"), data: { runId: feature.id, claims: perTask, overlaps } };
}

/** atlas diagnose <run-id>: failure analysis from persisted structured evidence. */
export async function runDiagnoseCommand(
  options: { runId: string },
  db: PrismaClient = getPrismaClient(),
): Promise<CommandOutput> {
  const { feature, tasks } = await loadFeatureScope(db, options.runId);
  const lines: string[] = [`atlas diagnose ${feature.id}`];
  const findings: unknown[] = [];
  for (const task of tasks) {
    const [liveWorker, testRuns, events, commits, execArtifacts] = await Promise.all([
      db.worker.findFirst({ where: { taskId: task.id } }),
      db.testRun.findMany({ where: { taskId: task.id }, orderBy: { createdAt: "asc" } }),
      db.event.findMany({ where: { taskId: task.id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
      db.commit.findMany({ where: { taskId: task.id }, orderBy: { createdAt: "asc" } }),
      db.artifact.findMany({ where: { taskId: task.id, label: { startsWith: "worker-execution" } }, orderBy: { createdAt: "desc" } }),
    ]);
    // M23.1 historical fallback (same rule as show task): released terminal
    // links resolve to the latest event-named worker for truthful display.
    let worker = liveWorker;
    let workerLink: "live" | "historical" | null = liveWorker === null ? null : "live";
    if (worker === null) {
      const historicalId = await findHistoricalWorkerId(db, task.id);
      if (historicalId !== null) {
        worker = await db.worker.findUnique({ where: { id: historicalId } });
        workerLink = worker === null ? null : "historical";
      }
    }
    const verdicts = events.filter((e) => e.type === "VERIFICATION_COMPLETED");
    const failedTest = [...testRuns].reverse().find((r) => r.status === "FAILED");
    const executionOutcome = (execArtifacts[0]?.label ?? "").match(/status=([A-Z_]+)/)?.[1] ?? null;
    // Recovery eligibility from the single authoritative classifier (read-only;
    // never authorizes mutation — only `atlas recover task` does that).
    const recoveryWorkspace =
      worker === null ? null : await db.workspace.findUnique({ where: { workerId: worker.id } });
    const recovery = classifyRecoveryEligibility({
      taskId: task.id,
      taskStatus: task.status,
      worker: worker === null ? null : { id: worker.id, status: worker.status, taskId: worker.taskId },
      hasWorkspace: recoveryWorkspace !== null,
    });
    const failedPayload = latestPayload(events, "TASK_FAILED");
    const failedErrorCode = typeof failedPayload?.errorCode === "string" ? failedPayload.errorCode : null;
    const failedError =
      typeof failedPayload?.error === "string" && failedPayload.error.length > 0
        ? failedPayload.error.slice(0, 200)
        : null;
    const completedPayload = latestPayload(events, "VERIFICATION_COMPLETED");
    const storedReasons = Array.isArray(completedPayload?.reasons)
      ? completedPayload.reasons.filter((r): r is string => typeof r === "string")
      : [];
    let assessment: string;
    let phase: string;
    if (executionOutcome === "COMPLETED_EMPTY") {
      phase = "empty-outcome (valid hygiene, no contribution)";
      assessment = "worker valid but contributed nothing; inspect worktree or replan";
    } else if (executionOutcome === "CLAIM_VIOLATION") {
      phase = "claim enforcement";
      assessment = "undeclared modifications rejected; see task claims vs worktree diff";
    } else if (task.status === "COMPLETED") {
      phase = "completed";
      assessment = "completed successfully";
    } else if (executionOutcome === "FAILED" && testRuns.length === 0) {
      // M20.3: prefer persisted failure evidence over generic inference.
      const errorText = failedError !== null ? `: ${failedError}` : "";
      if (failedErrorCode === "RATE_LIMIT") {
        phase = "worker execution";
        assessment = `Provider rate limit${errorText} — no tests executed`;
      } else if (failedErrorCode !== null) {
        phase = "worker execution";
        assessment = `Worker ${describeCommandKind(failedErrorCode)} before any test ran${errorText}`;
      } else {
        phase = "worker execution";
        assessment = "worker failed before any test ran (provider/timeout path; see worker status)";
      }
    } else if (failedTest !== undefined) {
      phase = "testing";
      assessment = `latest test run FAILED (exit ${failedTest.exitCode})`;
    } else if (task.status === "VERIFICATION" || verdicts.some((e) => (e.payload ?? "").includes("REJECTED"))) {
      // M21.2: render persisted reasons when present; old events without
      // them keep the generic fallback (never invent reasons).
      phase = "verification";
      assessment =
        storedReasons.length > 0
          ? `work did not verify: ${storedReasons.join(", ")}`
          : "work did not verify (see VERIFICATION_COMPLETED payloads for the verdict)";
    } else {
      phase = "unknown";
      assessment = "insufficient persisted evidence to determine the failing phase";
    }
    lines.push(`  - ${task.id.slice(0, 8)} (${task.title}): status=${task.status} phase=${phase}: ${assessment}`);
    lines.push(
      `    worker=${
        worker === null
          ? "none"
          : `${worker.id.slice(0, 8)}/${worker.status}${workerLink === "historical" ? " (historical)" : ""}`
      } tests=${testRuns.length} merges=${commits.length} events=${events.length}`,
    );
    lines.push(
      `    recovery: ${recovery.class} — ${recovery.reason}${
        recovery.nextCommand !== undefined ? ` — next: ${recovery.nextCommand}` : ""
      }`,
    );
    // M22: stuck states have an operator-driven exit (`atlas task transition`,
    // single allowed edges, human actor + reason recorded). Suggest it only
    // when no live worker could still be active — never for RUNNING-linked
    // tasks, never for terminal states (start a new attempt instead).
    const liveWorkerActive =
      worker !== null && worker.status === "RUNNING" && worker.taskId === task.id;
    let operatorTransition: string | undefined;
    if (task.status === "VERIFICATION" && !liveWorkerActive) {
      operatorTransition =
        `atlas task transition ${task.id} --to IN_PROGRESS --actor <actor> --reason <text> (rework) ` +
        `| atlas task transition ${task.id} --to FAILED --actor <actor> --reason <text> (accept failure)`;
    } else if (task.status === "IN_PROGRESS" && !liveWorkerActive) {
      operatorTransition =
        `atlas task transition ${task.id} --to FAILED --actor <actor> --reason <text> ` +
        `(then --to READY to make it schedulable again)`;
    }
    if (operatorTransition !== undefined) {
      lines.push(`    operator: ${operatorTransition}`);
    }
    findings.push({
      taskId: task.id,
      title: task.title,
      status: task.status,
      phase,
      assessment,
      worker:
        worker === null
          ? null
          : {
              id: worker.id,
              status: worker.status,
              ...(workerLink === "historical" ? { link: "historical" as const } : {}),
            },
      testRuns: testRuns.map((r) => ({ id: r.id, status: r.status, exitCode: r.exitCode })),
      mergeCommits: commits.map((c) => ({ sha: c.sha, branch: c.branch })),
      ...(failedErrorCode !== null ? { errorCode: failedErrorCode } : {}),
      ...(failedError !== null ? { error: failedError } : {}),
      recovery: {
        class: recovery.class,
        reason: recovery.reason,
        ...(recovery.nextCommand !== undefined ? { nextCommand: recovery.nextCommand } : {}),
      },
      ...(operatorTransition !== undefined ? { operatorTransition } : {}),
    });
  }
  const completed = tasks.filter((t) => t.status === "COMPLETED").length;
  const lines2 = [`summary: ${completed}/${tasks.length} tasks COMPLETED`];
  return { exitCode: EXIT_OK, human: [...lines, ...lines2].join("\n"), data: { runId: feature.id, findings, completed, total: tasks.length } };
}
