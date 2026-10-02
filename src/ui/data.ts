import type { PrismaClient } from "@prisma/client";
import { TaskStatus, WorkerStatus } from "@prisma/client";
import { getPrismaClient } from "../db/client.js";
import { getTaskClaims } from "../claims/service.js";
import { planSchedule } from "../dag/index.js";
import { payloadWorkerId, findHistoricalWorkerId, WORKER_LINK_EVENT_TYPES } from "../workspaces/index.js";
import { FEATURE_TRANSITIONS, TASK_TRANSITIONS } from "../core/transitions.js";import { runClaimsCommand, runDiagnoseCommand, runHistoryCommand } from "../cli/show.js";

// Read-only data loaders for the Atlas web dashboard (M24.1).
//
// Projection only: every loader reads via Prisma finds or the existing
// read-only CLI command outputs. Nothing here creates, updates, or deletes
// rows — a static test enforces that (see tests/ui.test.ts). Orchestration
// stays in the control plane; the UI only shapes its state for display.

export interface RunState {
  readonly featureId: string;
  readonly status: string;
  /** True when Atlas itself can no longer change this run: the feature is
   * terminal per FEATURE_TRANSITIONS, or every task is terminal per
   * TASK_TRANSITIONS. Unknown statuses fail open (keep polling) so a
   * read-only UI never goes blind on model evolution. */
  readonly terminal: boolean;
}

function isTerminalState(transitions: Record<string, readonly string[]>, status: string): boolean {
  const next = transitions[status];
  if (next === undefined) {
    return false;
  }
  return next.length === 0;
}

export async function loadRunState(db: PrismaClient, featureId: string): Promise<RunState> {
  const feature = await db.feature.findUnique({ where: { id: featureId } });
  if (feature === null) {
    throw new Error(`unknown run scope: expected a feature ID, got ${JSON.stringify(featureId)}`);
  }
  if (isTerminalState(FEATURE_TRANSITIONS as Record<string, readonly string[]>, feature.status)) {
    return { featureId, status: feature.status, terminal: true };
  }
  const tasks = await db.task.findMany({ where: { featureId }, select: { status: true } });
  const allTerminal =
    tasks.length > 0 &&
    tasks.every((t) => isTerminalState(TASK_TRANSITIONS as Record<string, readonly string[]>, t.status));
  return { featureId, status: feature.status, terminal: allTerminal };
}

export interface ProjectSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly repositoryCount: number;
  readonly runCount: number;
  /** Runs belonging to this project (run = feature). Present so operators
   * never guess IDs: a project always leads to its runs deterministically. */
  readonly runs: RunSummary[];
}

export interface RunSummary {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly taskCounts: Record<string, number>;
  readonly totalTasks: number;
  /** Workers ever linked (live + historical via event payloads). */
  readonly workerCount: number;
  readonly verifiedCount: number;
  readonly mergeCount: number;
}

export interface WavePreview {
  readonly groups: Array<{ readonly tasks: string[] }>;
  readonly blocked: Array<{ readonly taskId: string; readonly reason: string }>;
  readonly note: string;
}

export interface OverviewData {
  readonly project: { readonly id: string; readonly name: string };
  readonly repository: { readonly id: string; readonly name: string; readonly localPath: string } | null;
  readonly run: RunSummary;
  readonly workers: Array<{ readonly id: string; readonly status: string; readonly taskId: string | null; readonly link: string }>;
  readonly waves: WavePreview;
  readonly verification: { readonly verified: number; readonly rejected: number; readonly unevaluated: number };
  readonly pendingApprovals: Array<{ readonly id: string; readonly context: string | null; readonly note: string | null }>;
  readonly merge: {
    readonly trainBranches: string[];
    readonly mergeCommits: number;
    readonly lastStatus: string | null;
    readonly lastHaltReason: string | null;
  };
}

export async function loadProjects(db: PrismaClient = getPrismaClient(), projectIds?: string[]): Promise<ProjectSummary[]> {
  const projects = await db.project.findMany({
    where: projectIds === undefined ? {} : { id: { in: projectIds } },
    orderBy: { createdAt: "asc" },
  });
  if (projects.length === 0) {
    return [];
  }
  // Scoped queries stay scoped (tests, single-project views); the unscoped
  // landing path batches once instead of fanning out per project.
  const runsByProject = new Map<string, RunSummary[]>();
  if (projectIds !== undefined) {
    const perProject = await Promise.all(projects.map((p) => loadRuns(db, p.id)));
    perProject.forEach((runs, index) => {
      const project = projects[index];
      if (project !== undefined) {
        runsByProject.set(project.id, runs);
      }
    });
  } else {
    for (const run of await loadRuns(db)) {
      const list = runsByProject.get(run.projectId) ?? [];
      list.push(run);
      runsByProject.set(run.projectId, list);
    }
  }
  const repoCounts = await db.repository.groupBy({ by: ["projectId"], where: { projectId: { in: projects.map((p) => p.id) } }, _count: { _all: true } });
  const reposByProject = new Map(repoCounts.map((r) => [r.projectId, r._count._all] as const));
  return projects.map((project) => {
    const runs = runsByProject.get(project.id) ?? [];
    return {
      id: project.id,
      name: project.name,
      description: project.description,
      repositoryCount: reposByProject.get(project.id) ?? 0,
      runCount: runs.length,
      runs,
    };
  });
}

async function summarizeRuns(
  db: PrismaClient,
  features: Array<{ id: string; title: string; status: string; projectId: string; project: { name: string } }>,
): Promise<RunSummary[]> {
  const featureIds = features.map((f) => f.id);
  // Batched reads (one round trip per table): identical semantics to the
  // per-feature version, without N+1 query storms on large databases.
  const [taskRows, workerRows, linkEvents, verifyMerges] = await Promise.all([
    db.task.findMany({ where: { featureId: { in: featureIds } }, select: { featureId: true, status: true } }),
    db.worker.findMany({ where: { task: { featureId: { in: featureIds } } }, select: { id: true, task: { select: { featureId: true } } } }),
    db.event.findMany({ where: { featureId: { in: featureIds }, type: { in: WORKER_LINK_EVENT_TYPES } }, select: { featureId: true, payload: true } }),
    db.event.groupBy({
      by: ["featureId", "type"],
      where: { featureId: { in: featureIds }, type: { in: ["VERIFICATION_COMPLETED", "INTEGRATION_COMPLETED", "INTEGRATION_FAILED"] } },
      _count: { _all: true },
    }),
  ]);
  const tasksByFeature = new Map<string, string[]>();
  for (const row of taskRows) {
    const list = tasksByFeature.get(row.featureId) ?? [];
    list.push(row.status);
    tasksByFeature.set(row.featureId, list);
  }
  const workersByFeature = new Map<string, Set<string>>();
  for (const row of workerRows) {
    if (row.task === null) {
      continue;
    }
    const set = workersByFeature.get(row.task.featureId) ?? new Set<string>();
    set.add(row.id);
    workersByFeature.set(row.task.featureId, set);
  }
  for (const row of linkEvents) {
    if (row.featureId === null) {
      continue;
    }
    const wid = payloadWorkerId(row.payload);
    if (wid !== null) {
      const set = workersByFeature.get(row.featureId) ?? new Set<string>();
      set.add(wid);
      workersByFeature.set(row.featureId, set);
    }
  }
  const countsByFeature = new Map<string, { verified: number; merges: number }>();
  for (const row of verifyMerges) {
    if (row.featureId === null) {
      continue;
    }
    const entry = countsByFeature.get(row.featureId) ?? { verified: 0, merges: 0 };
    if (row.type === "VERIFICATION_COMPLETED") {
      entry.verified += row._count._all;
    } else {
      entry.merges += row._count._all;
    }
    countsByFeature.set(row.featureId, entry);
  }
  return features.map((feature) => {
    const statuses = tasksByFeature.get(feature.id) ?? [];
    const taskCounts: Record<string, number> = {};
    for (const status of statuses) {
      taskCounts[status] = (taskCounts[status] ?? 0) + 1;
    }
    const counts = countsByFeature.get(feature.id) ?? { verified: 0, merges: 0 };
    return {
      id: feature.id,
      title: feature.title,
      status: feature.status,
      projectId: feature.projectId,
      projectName: feature.project.name,
      taskCounts,
      totalTasks: statuses.length,
      workerCount: workersByFeature.get(feature.id)?.size ?? 0,
      verifiedCount: counts.verified,
      mergeCount: counts.merges,
    };
  });
}

export async function loadRuns(db: PrismaClient = getPrismaClient(), projectId?: string): Promise<RunSummary[]> {
  const features = await db.feature.findMany({
    where: projectId === undefined ? {} : { projectId },
    orderBy: { createdAt: "asc" },
    include: { project: true },
  });
  if (features.length === 0) {
    return [];
  }
  return summarizeRuns(db, features);
}

async function loadRun(db: PrismaClient, featureId: string): Promise<RunSummary> {  const feature = await db.feature.findUnique({ where: { id: featureId }, include: { project: true } });
  if (feature === null) {
    throw new Error(`unknown run scope: expected a feature ID, got ${JSON.stringify(featureId)}`);
  }
  const [summary] = await summarizeRuns(db, [feature]);
  if (summary === undefined) {
    throw new Error(`unknown run scope: expected a feature ID, got ${JSON.stringify(featureId)}`);
  }
  return summary;
}

async function involvedWorkers(
  db: PrismaClient,
  taskIds: string[],
  featureEvents: Array<{ payload: string | null }>,
): Promise<Array<{ id: string; status: string; taskId: string | null; link: string }>> {
  const live = await db.worker.findMany({ where: { taskId: { in: taskIds } } });
  const liveIds = new Set(live.map((w) => w.id));
  const historicalIds: string[] = [];
  for (const event of featureEvents) {
    const wid = payloadWorkerId(event.payload);
    if (wid !== null && !liveIds.has(wid) && !historicalIds.includes(wid)) {
      historicalIds.push(wid);
    }
  }
  const historical = historicalIds.length === 0 ? [] : await db.worker.findMany({ where: { id: { in: historicalIds } } });
  return [
    ...live.map((w) => ({ id: w.id, status: w.status, taskId: w.taskId, link: "live" })),
    ...historical.map((w) => ({ id: w.id, status: w.status, taskId: w.taskId, link: "historical" })),
  ];
}

async function schedulePreview(
  db: PrismaClient,
  featureId: string,
): Promise<WavePreview> {
  const [tasks, edges] = await Promise.all([
    db.task.findMany({ where: { featureId } }),
    db.taskDependency.findMany({ where: { task: { featureId } } }),
  ]);
  if (tasks.length === 0) {
    return { groups: [], blocked: [], note: "No tasks yet." };
  }
  const claimsByTask = new Map<string, Array<{ resourceId: string; kind: "FILE" | "DIRECTORY"; access: "READ" | "WRITE" }>>();
  for (const task of tasks) {
    const claims = await getTaskClaims(task.id, db);
    claimsByTask.set(
      task.id,
      claims.map((c) => ({ resourceId: c.resourceId, kind: c.kind, access: c.access })),
    );
  }
  // Same honesty contract as `atlas plan` previews: hypothetical workers,
  // display only — the scheduler answers dependency-readiness.
  const previewWorkers = ["ui-preview-1", "ui-preview-2", "ui-preview-3", "ui-preview-4"].map((id) => ({
    id,
    status: WorkerStatus.IDLE,
  }));
  const plan = planSchedule({
    tasks: tasks.map((t) => ({ id: t.id, status: t.status as TaskStatus, claims: claimsByTask.get(t.id) ?? [] })),
    dependencies: edges.map((e) => ({ taskId: e.taskId, dependsOnTaskId: e.dependsOnTaskId })),
    workers: previewWorkers,
    maxConcurrency: 4,
  });
  return {
    groups: plan.groups.map((g) => ({ tasks: [...g.tasks] })),
    blocked: plan.blockedTasks.map((b) => ({ taskId: b.taskId, reason: b.reason })),
    note: "Schedule preview with 4 hypothetical workers (display only).",
  };
}

export async function loadOverview(db: PrismaClient, featureId: string): Promise<OverviewData> {
  const run = await loadRun(db, featureId);
  const [project, repository, tasks] = await Promise.all([
    db.project.findUniqueOrThrow({ where: { id: run.projectId } }),
    db.repository.findFirst({ where: { projectId: run.projectId } }),
    db.task.findMany({ where: { featureId } }),
  ]);
  const taskIds = tasks.map((t) => t.id);
  const [featureEvents, verifyEvents, integrationEvents, mergeCommits] = await Promise.all([
    db.event.findMany({ where: { featureId }, select: { payload: true } }),
    db.event.findMany({ where: { featureId, type: "VERIFICATION_COMPLETED" }, select: { taskId: true, payload: true } }),
    db.event.findMany({
      where: { featureId, type: { in: ["INTEGRATION_COMPLETED", "INTEGRATION_FAILED"] } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 5,
    }),
    taskIds.length === 0
      ? []
      : await db.commit.findMany({ where: { taskId: { in: taskIds }, branch: { startsWith: "atlas/" } } }),
  ]);
  const latestVerdict = new Map<string, string>();
  for (const event of verifyEvents) {
    if (event.taskId === null) {
      continue;
    }
    try {
      const verdict = (JSON.parse(event.payload ?? "") as { verdict?: unknown }).verdict;
      if (verdict === "VERIFIED" || verdict === "REJECTED") {
        latestVerdict.set(event.taskId, verdict);
      }
    } catch {
      // Unparseable payloads contribute no verdict.
    }
  }
  let verified = 0;
  let rejected = 0;
  for (const taskId of taskIds) {
    const verdict = latestVerdict.get(taskId);
    if (verdict === "VERIFIED") {
      verified += 1;
    } else if (verdict === "REJECTED") {
      rejected += 1;
    }
  }
  const trainBranches = [...new Set(mergeCommits.map((c) => c.branch).filter((b): b is string => b !== null))];
  const lastIntegration = integrationEvents[0];
  let lastStatus: string | null = null;
  let lastHaltReason: string | null = null;
  if (lastIntegration !== undefined) {
    try {
      const payload = JSON.parse(lastIntegration.payload ?? "") as { status?: unknown; haltReason?: unknown };
      lastStatus = typeof payload.status === "string" ? payload.status : lastIntegration.type;
      lastHaltReason = typeof payload.haltReason === "string" ? payload.haltReason : null;
    } catch {
      lastStatus = lastIntegration.type;
    }
  }
  return {
    project: { id: project.id, name: project.name },
    repository:
      repository === null
        ? null
        : { id: repository.id, name: repository.name, localPath: repository.localPath },
    run,
    workers: await involvedWorkers(db, taskIds, featureEvents),
    waves: await schedulePreview(db, featureId),
    verification: { verified, rejected, unevaluated: taskIds.length - verified - rejected },
    pendingApprovals: (
      await db.approval.findMany({ where: { featureId, status: "PENDING" }, orderBy: { createdAt: "asc" } })
    ).map((a) => ({ id: a.id, context: a.context, note: a.note })),
    merge: { trainBranches, mergeCommits: mergeCommits.length, lastStatus, lastHaltReason },
  };
}

export interface TaskDetail {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly dependsOn: string[];
  readonly requiredBy: string[];
  readonly claims: Array<{ readonly resourceId: string; readonly access: string }>;
  readonly worker: { readonly id: string; readonly status: string; readonly link: "live" | "historical" } | null;
  readonly testRuns: Array<{ readonly status: string; readonly exitCode: number | null }>;
  readonly verdict: string | null;
  readonly reasons: string[];
}

async function resolveTaskWorker(
  db: PrismaClient,
  taskId: string,
): Promise<{ id: string; status: string; link: "live" | "historical" } | null> {
  const live = await db.worker.findFirst({ where: { taskId } });
  if (live !== null) {
    return { id: live.id, status: live.status, link: "live" };
  }
  const historicalId = await findHistoricalWorkerId(db, taskId);
  if (historicalId === null) {
    return null;
  }
  const historical = await db.worker.findUnique({ where: { id: historicalId } });
  return historical === null ? null : { id: historical.id, status: historical.status, link: "historical" };
}

export async function loadTasks(db: PrismaClient, featureId: string): Promise<TaskDetail[]> {
  const tasks = await db.task.findMany({ where: { featureId }, orderBy: { id: "asc" } });
  const out: TaskDetail[] = [];
  for (const task of tasks) {
    const [claims, testRuns, verifyEvents, dependsOn, dependents] = await Promise.all([
      getTaskClaims(task.id, db),
      db.testRun.findMany({ where: { taskId: task.id }, orderBy: { createdAt: "asc" } }),
      db.event.findMany({ where: { taskId: task.id, type: "VERIFICATION_COMPLETED" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1 }),
      db.taskDependency.findMany({ where: { taskId: task.id } }),
      db.taskDependency.findMany({ where: { dependsOnTaskId: task.id } }),
    ]);
    const resolvedWorker = await resolveTaskWorker(db, task.id);
    let verdict: string | null = null;
    let reasons: string[] = [];
    const latest = verifyEvents[0];
    if (latest !== undefined) {
      try {
        const payload = JSON.parse(latest.payload ?? "") as { verdict?: unknown; reasons?: unknown };
        verdict = typeof payload.verdict === "string" ? payload.verdict : null;
        reasons = Array.isArray(payload.reasons) ? payload.reasons.filter((r): r is string => typeof r === "string") : [];
      } catch {
        // Keep verdict unknown on unparseable payloads.
      }
    }
    out.push({
      id: task.id,
      title: task.title,
      status: task.status,
      dependsOn: dependsOn.map((d) => d.dependsOnTaskId),
      requiredBy: dependents.map((d) => d.taskId),
      claims: claims.map((c) => ({ resourceId: c.resourceId, access: c.access })),
      worker: resolvedWorker === null ? null : { id: resolvedWorker.id, status: resolvedWorker.status, link: resolvedWorker.link },
      testRuns: testRuns.map((r) => ({ status: r.status, exitCode: r.exitCode })),
      verdict,
      reasons,
    });
  }
  return out;
}

export interface WorkerDetail {
  readonly id: string;
  readonly status: string;
  readonly taskId: string | null;
  readonly link: string;
  readonly taskTitle: string | null;
  readonly taskStatus: string | null;
  readonly branch: string | null;
  readonly workspacePath: string | null;
  readonly testRuns: number;
  readonly failures: number;
}

export async function loadWorkers(db: PrismaClient, featureId: string): Promise<WorkerDetail[]> {
  const overview = await loadOverview(db, featureId);
  const out: WorkerDetail[] = [];
  for (const entry of overview.workers) {
    const [row, task] = await Promise.all([
      db.worker.findUnique({ where: { id: entry.id }, include: { workspace: true } }),
      entry.taskId === null
        ? null
        : await db.task.findFirst({ where: { id: entry.taskId, featureId } }),
    ]);
    // Historical display needs the worker's own task even after release:
    // resolve through the canonical workspace branch when the live link is gone.
    let taskId = entry.taskId;
    if (taskId === null && row?.workspace?.branch) {
      const segments = row.workspace.branch.split("/");
      if (segments.length === 5 && segments[0] === "atlas" && segments[1] === "worker" && segments[2] === row.id && segments[3] === "task") {
        taskId = segments[4] ?? null;
      }
    }
    const resolvedTask =
      task ??
      (taskId === null ? null : await db.task.findFirst({ where: { id: taskId, featureId } }));
    const [testRunCount, failureCount] =
      taskId === null
        ? [0, 0]
        : await Promise.all([
            db.testRun.count({ where: { taskId } }),
            db.event.count({ where: { taskId, type: "TASK_FAILED" } }),
          ]);
    out.push({
      id: entry.id,
      status: entry.status,
      taskId,
      link: entry.link,
      taskTitle: resolvedTask?.title ?? null,
      taskStatus: resolvedTask?.status ?? null,
      branch: row?.workspace?.branch ?? null,
      workspacePath: row?.workspace?.path ?? null,
      testRuns: testRunCount,
      failures: failureCount,
    });
  }
  return out;
}

export interface DependencyData {
  readonly tasks: Array<{ readonly id: string; readonly title: string; readonly status: string }>;
  readonly edges: Array<{ readonly from: string; readonly to: string }>;
}

export async function loadDependencies(db: PrismaClient, featureId: string): Promise<DependencyData> {
  const [tasks, edges] = await Promise.all([
    db.task.findMany({ where: { featureId }, orderBy: { id: "asc" } }),
    db.taskDependency.findMany({ where: { task: { featureId } }, orderBy: { taskId: "asc" } }),
  ]);
  return {
    tasks: tasks.map((t) => ({ id: t.id, title: t.title, status: t.status })),
    edges: edges.map((e) => ({ from: e.dependsOnTaskId, to: e.taskId })),
  };
}

export interface ClaimData {
  readonly perTask: Array<{ readonly taskId: string; readonly title: string; readonly claims: Array<{ readonly resourceId: string; readonly access: string }> }>;
  readonly overlaps: Array<{ readonly taskA: string; readonly taskB: string; readonly details: string }>;
}

export async function loadClaims(db: PrismaClient, featureId: string): Promise<ClaimData> {
  const output = await runClaimsCommand({ runId: featureId }, db);
  const data = output.data as {
    claims: Array<{ taskId: string; claims: Array<{ resourceId: string; access: string }> }>;
    overlaps: Array<{ taskA: string; taskB: string; details: unknown }>;
  };
  const titles = new Map((await db.task.findMany({ where: { featureId }, select: { id: true, title: true } })).map((t) => [t.id, t.title] as const));
  return {
    perTask: data.claims.map((c) => ({ taskId: c.taskId, title: titles.get(c.taskId) ?? c.taskId, claims: c.claims })),
    overlaps: data.overlaps.map((o) => ({ taskA: o.taskA, taskB: o.taskB, details: JSON.stringify(o.details) })),
  };
}

export interface VerificationData {
  readonly findings: Array<{
    readonly taskId: string;
    readonly title: string;
    readonly status: string;
    readonly phase: string;
    readonly assessment: string;
    readonly verdict: string | null;
    readonly reasons: string[];
    readonly testRuns: Array<{ readonly status: string; readonly exitCode: number | null }>;
    readonly errorCode?: string;
  }>;
  readonly completed: number;
  readonly total: number;
}

export async function loadVerification(db: PrismaClient, featureId: string): Promise<VerificationData> {
  const output = await runDiagnoseCommand({ runId: featureId }, db);
  const data = output.data as {
    findings: Array<{
      taskId: string;
      title: string;
      status: string;
      phase: string;
      assessment: string;
      testRuns: Array<{ status: string; exitCode: number | null }>;
      errorCode?: string;
    }>;
    completed: number;
    total: number;
  };
  const verdicts = await db.event.findMany({ where: { featureId, type: "VERIFICATION_COMPLETED" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  const latest = new Map<string, { verdict: string | null; reasons: string[] }>();
  for (const event of verdicts) {
    if (event.taskId === null || latest.has(event.taskId)) {
      continue;
    }
    try {
      const payload = JSON.parse(event.payload ?? "") as { verdict?: unknown; reasons?: unknown };
      latest.set(event.taskId, {
        verdict: typeof payload.verdict === "string" ? payload.verdict : null,
        reasons: Array.isArray(payload.reasons) ? payload.reasons.filter((r): r is string => typeof r === "string") : [],
      });
    } catch {
      latest.set(event.taskId, { verdict: null, reasons: [] });
    }
  }
  return {
    findings: data.findings.map((f) => ({
      taskId: f.taskId,
      title: f.title,
      status: f.status,
      phase: f.phase,
      assessment: f.assessment,
      verdict: latest.get(f.taskId)?.verdict ?? null,
      reasons: latest.get(f.taskId)?.reasons ?? [],
      testRuns: f.testRuns,
      ...(f.errorCode === undefined ? {} : { errorCode: f.errorCode }),
    })),
    completed: data.completed,
    total: data.total,
  };
}

export interface TrainData {
  readonly branches: Array<{
    readonly branch: string;
    readonly status: string | null;
    readonly haltReason: string | null;
    readonly items: Array<{
      readonly taskId: string;
      readonly title: string;
      readonly sha: string;
      readonly subject: string;
      readonly verdict: string | null;
      readonly createdAt: string | null;
    }>;
  }>;
}

export async function loadTrain(db: PrismaClient, featureId: string): Promise<TrainData> {
  const tasks = await db.task.findMany({ where: { featureId }, select: { id: true, title: true } });
  const taskIds = tasks.map((t) => t.id);
  const titles = new Map(tasks.map((t) => [t.id, t.title] as const));
  if (taskIds.length === 0) {
    return { branches: [] };
  }
  const [commits, integrationEvents, verifyEvents] = await Promise.all([
    db.commit.findMany({ where: { taskId: { in: taskIds }, branch: { startsWith: "atlas/" } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
    db.event.findMany({ where: { featureId, type: { in: ["INTEGRATION_COMPLETED", "INTEGRATION_FAILED"] } } }),
    db.event.findMany({ where: { featureId, type: "VERIFICATION_COMPLETED" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] }),
  ]);
  const verdictByTask = new Map<string, string>();
  for (const event of verifyEvents) {
    if (event.taskId === null || verdictByTask.has(event.taskId)) {
      continue;
    }
    try {
      const verdict = (JSON.parse(event.payload ?? "") as { verdict?: unknown }).verdict;
      if (typeof verdict === "string") {
        verdictByTask.set(event.taskId, verdict);
      }
    } catch {
      // Skip unparseable payloads.
    }
  }
  const statusByBranch = new Map<string, { status: string | null; haltReason: string | null }>();
  for (const event of integrationEvents) {
    try {
      const payload = JSON.parse(event.payload ?? "") as { trainBranch?: unknown; status?: unknown; haltReason?: unknown };
      if (typeof payload.trainBranch === "string" && !statusByBranch.has(payload.trainBranch)) {
        statusByBranch.set(payload.trainBranch, {
          status: typeof payload.status === "string" ? payload.status : null,
          haltReason: typeof payload.haltReason === "string" ? payload.haltReason : null,
        });
      }
    } catch {
      // Skip unparseable payloads.
    }
  }
  const byBranch = new Map<string, TrainData["branches"][number]["items"]>();
  for (const commit of commits) {
    if (commit.branch === null || commit.taskId === null) {
      continue;
    }
    const items = byBranch.get(commit.branch) ?? [];
    items.push({
      taskId: commit.taskId,
      title: titles.get(commit.taskId) ?? commit.taskId,
      sha: commit.sha,
      subject: commit.subject ?? "",
      verdict: verdictByTask.get(commit.taskId) ?? null,
      createdAt: commit.createdAt instanceof Date ? commit.createdAt.toISOString() : null,
    });
    byBranch.set(commit.branch, items);
  }
  return {
    branches: [
      ...[...byBranch.entries()].map(([branch, items]) => ({
        branch,
        status: statusByBranch.get(branch)?.status ?? null,
        haltReason: statusByBranch.get(branch)?.haltReason ?? null,
        items,
      })),
      // Halt (or completion) records without merge commits yet: a first-item
      // halt leaves no commit row, but the INTEGRATION event is real state
      // and must stay visible. Zero-item entries, never invented commits.
      ...[...statusByBranch.entries()]
        .filter(([branch]) => !byBranch.has(branch))
        .map(([branch, info]) => ({ branch, status: info.status, haltReason: info.haltReason, items: [] as TrainData["branches"][number]["items"] })),
    ],
  };
}

export interface EventData {
  readonly events: Array<{
    readonly type: string;
    readonly taskId: string | null;
    readonly actor: string | null;
    readonly createdAt: string | null;
    readonly summary: string | null;
    readonly payload: string | null;
  }>;
  readonly total: number;
}

export async function loadEvents(db: PrismaClient, featureId: string): Promise<EventData> {
  const output = await runHistoryCommand({ runId: featureId }, db);
  const data = output.data as {
    events: Array<{ type: string; taskId: string | null; actor: string | null; createdAt: string | null; payload: string | null }>;
  };
  return {
    events: data.events.map((e) => ({
      type: e.type,
      taskId: e.taskId,
      actor: e.actor,
      createdAt: e.createdAt,
      summary: e.payload === null || e.payload.length <= 200 ? e.payload : `${e.payload.slice(0, 200)}…`,
      payload: e.payload,
    })),
    total: data.events.length,
  };
}

export interface TransitionOptions {
  readonly taskId: string;
  readonly title: string;
  readonly current: string;
  /** Valid next states read from the existing state machine (never invented). */
  readonly validNext: string[];
}

export async function loadTransitionOptions(db: PrismaClient, taskId: string): Promise<TransitionOptions> {
  const task = await db.task.findUnique({ where: { id: taskId } });
  if (task === null) {
    throw new Error(`unknown task: ${JSON.stringify(taskId)}`);
  }
  const next = (TASK_TRANSITIONS as Record<string, readonly string[]>)[task.status] ?? [];
  return { taskId: task.id, title: task.title, current: task.status, validNext: [...next] };
}

export interface WorkflowNode {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly workerId: string | null;
  readonly workerStatus: string | null;
  readonly workerLink: "live" | "historical" | "none";
  /** 1-based scheduler wave from the live planSchedule preview, if scheduled. */
  readonly wave: number | null;
  readonly verdict: string | null;
  readonly reasons: string[];
  readonly integrated: boolean;
  readonly dependsOn: string[];
}

export interface WorkflowPhase {
  readonly name: string;
  readonly active: boolean;
  readonly detail: string;
}

export interface WorkflowGraphData {
  readonly runId: string;
  readonly runTitle: string;
  readonly runStatus: string;
  readonly nodes: WorkflowNode[];
  readonly edges: Array<{ readonly from: string; readonly to: string }>;
  readonly phases: WorkflowPhase[];
  readonly trainHalted: boolean;
  readonly trainHaltReason: string | null;
  /** Integrated commits in merge order (task, short-context data only). */
  readonly trainCars: Array<{ readonly taskId: string; readonly title: string; readonly sha: string; readonly subject: string }>;
  /** Default branch name for the harbor display (Atlas stores no main SHA). */
  readonly defaultBranch: string;
}

/**
 * Workflow read model (M24.4): a VIEW MODEL only, composed from the same
 * loaders the other views use. Waves come from the real planSchedule
 * preview; integration from recorded train commits; workers honor M23.1
 * live/historical semantics. Never a source of truth.
 */
export async function loadWorkflow(db: PrismaClient, featureId: string): Promise<WorkflowGraphData> {
  const [tasks, edges, train, verification] = await Promise.all([
    db.task.findMany({ where: { featureId }, orderBy: { id: "asc" } }),
    db.taskDependency.findMany({ where: { task: { featureId } }, orderBy: { taskId: "asc" } }),
    loadTrain(db, featureId),
    loadVerification(db, featureId),
  ]);
  const feature = await db.feature.findUniqueOrThrow({ where: { id: featureId } });
  const titles = new Map(tasks.map((t) => [t.id, t.title] as const));
  const repository = await db.repository.findFirst({ where: { projectId: feature.projectId } });
  const orderedCommits =
    tasks.length === 0
      ? []
      : await db.commit.findMany({
          where: { taskId: { in: tasks.map((t) => t.id) }, branch: { startsWith: "atlas/" } },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        });
  const integrated = new Set<string>();
  for (const branch of train.branches) {
    for (const item of branch.items) {
      integrated.add(item.taskId);
    }
  }
  const verdictByTask = new Map(verification.findings.map((f) => [f.taskId, f.verdict] as const));
  const reasonsByTask = new Map(verification.findings.map((f) => [f.taskId, f.reasons] as const));
  const waveByTask = new Map<string, number>();
  const overview = await loadOverview(db, featureId);
  overview.waves.groups.forEach((group, index) => {
    for (const taskId of group.tasks) {
      if (!waveByTask.has(taskId)) {
        waveByTask.set(taskId, index + 1);
      }
    }
  });
  const nodes: WorkflowNode[] = [];
  for (const task of tasks) {
    const worker = await resolveTaskWorker(db, task.id);
    nodes.push({
      id: task.id,
      title: task.title,
      status: task.status,
      workerId: worker?.id ?? null,
      workerStatus: worker?.status ?? null,
      workerLink: worker?.link ?? "none",
      wave: waveByTask.get(task.id) ?? null,
      verdict: verdictByTask.get(task.id) ?? null,
      reasons: reasonsByTask.get(task.id) ?? [],
      integrated: integrated.has(task.id),
      dependsOn: edges.filter((e) => e.taskId === task.id).map((e) => e.dependsOnTaskId),
    });
  }
  const byStatus = (statuses: string[]): number => nodes.filter((n) => statuses.includes(n.status)).length;
  const activeCount = byStatus(["CLAIMED", "IN_PROGRESS"]);
  const pendingCount = byStatus(["PENDING", "READY", "BLOCKED"]);
  const verifyCount = byStatus(["VERIFICATION"]) + nodes.filter((n) => n.verdict !== null).length;
  const haltedBranch = train.branches.find((b) => b.status === "HALTED");
  const phases: WorkflowPhase[] = [
    {
      name: "PLAN",
      active: overview.pendingApprovals.length > 0 || nodes.length === 0,
      detail: overview.pendingApprovals.length === 0 ? "no pending approvals" : `${overview.pendingApprovals.length} pending approval(s)`,
    },
    {
      name: "SCHEDULE",
      active: pendingCount > 0,
      detail: pendingCount === 0 ? "nothing waiting" : `${pendingCount} waiting`,
    },
    {
      name: "EXECUTE",
      active: activeCount > 0,
      detail: activeCount === 0 ? "idle" : `${activeCount} active`,
    },
    {
      name: "VERIFY",
      active: verifyCount > 0,
      detail: verifyCount === 0 ? "nothing under verification" : `${verifyCount} evaluated/in verification`,
    },
    {
      name: "MERGE",
      active: train.branches.length > 0,
      detail:
        train.branches.length === 0
          ? "no train yet"
          : haltedBranch !== undefined
            ? `halted: ${haltedBranch.haltReason ?? "see train view"}`
            : `${integrated.size} integrated`,
    },
  ];
  return {
    runId: feature.id,
    runTitle: feature.title,
    runStatus: feature.status,
    nodes,
    edges: edges.map((e) => ({ from: e.dependsOnTaskId, to: e.taskId })),
    phases,
    trainHalted: haltedBranch !== undefined,
    trainHaltReason: haltedBranch?.haltReason ?? null,
    trainCars: orderedCommits
      .filter((c) => c.taskId !== null)
      .map((c) => ({
        taskId: c.taskId as string,
        title: titles.get(c.taskId as string) ?? (c.taskId as string),
        sha: c.sha,
        subject: c.subject ?? "",
      })),
    defaultBranch: repository?.defaultBranch ?? "main",
  };
}

export interface GlobalWorkerEntry {
  readonly id: string;
  readonly status: string;
  readonly taskId: string | null;
  readonly link: string;
  readonly taskTitle: string | null;
  readonly featureId: string | null;
  readonly featureTitle: string | null;
}

export async function loadAllWorkers(db: PrismaClient, limit = 50): Promise<GlobalWorkerEntry[]> {
  const workers = await db.worker.findMany({ orderBy: [{ createdAt: "desc" }], take: limit, include: { workspace: true } });
  return Promise.all(
    workers.map(async (worker) => {
      if (worker.taskId === null) {
        // Released (historical) workers resolve per-run via event payloads;
        // the global list reports the live link only, never invents history.
        return { id: worker.id, status: worker.status, taskId: null, link: "none", taskTitle: null, featureId: null, featureTitle: null };
      }
      const task = await db.task.findUnique({ where: { id: worker.taskId }, include: { feature: true } });
      return {
        id: worker.id,
        status: worker.status,
        taskId: worker.taskId,
        link: "live",
        taskTitle: task?.title ?? null,
        featureId: task?.featureId ?? null,
        featureTitle: task?.feature?.title ?? null,
      };
    }),
  );
}

export interface ActivityEntry {
  readonly type: string;
  readonly taskId: string | null;
  readonly taskTitle: string | null;
  readonly featureId: string | null;
  readonly featureTitle: string | null;
  readonly actor: string | null;
  readonly createdAt: string | null;
}

export async function loadRecentEvents(db: PrismaClient, limit = 60): Promise<ActivityEntry[]> {
  const events = await db.event.findMany({ orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit });
  return Promise.all(
    events.map(async (event) => {
      const task =
        event.taskId === null ? null : await db.task.findUnique({ where: { id: event.taskId }, include: { feature: true } });
      return {
        type: event.type,
        taskId: event.taskId,
        taskTitle: task?.title ?? null,
        featureId: task?.featureId ?? event.featureId,
        featureTitle: task?.feature?.title ?? null,
        actor: event.actor,
        createdAt: event.createdAt instanceof Date ? event.createdAt.toISOString() : null,
      };
    }),
  );
}

export interface HomeData {
  readonly metrics: { readonly projects: number; readonly runs: number; readonly tasks: number; readonly liveWorkers: number; readonly verified: number; readonly merges: number };
  readonly activeRuns: RunSummary[];
  readonly recentRuns: RunSummary[];
}

const NONTERMINAL_TASK = ["PENDING", "READY", "CLAIMED", "IN_PROGRESS", "BLOCKED", "VERIFICATION"] as const;

export async function loadHome(db: PrismaClient): Promise<HomeData> {
  const [projects, runs, tasks, liveWorkers, verified, merges] = await Promise.all([
    db.project.count(),
    loadRuns(db),
    db.task.count(),
    db.worker.count({ where: { status: { in: ["ASSIGNED", "RUNNING", "VERIFYING"] } } }),
    db.event.count({ where: { type: "VERIFICATION_COMPLETED" } }),
    db.event.count({ where: { type: { in: ["INTEGRATION_COMPLETED", "INTEGRATION_FAILED"] } } }),
  ]);
  const activeRuns = runs.filter((r) =>
    Object.entries(r.taskCounts).some(([status, count]) => (NONTERMINAL_TASK as readonly string[]).includes(status) && count > 0),
  ).slice(0, 8);
  return {
    metrics: { projects, runs: runs.length, tasks, liveWorkers, verified, merges },
    activeRuns,
    recentRuns: runs.slice(-8).reverse(),
  };
}

export interface RunHud {
  readonly featureId: string;
  readonly title: string;
  readonly status: string;
  readonly totalTasks: number;
  readonly activeTasks: number;
  readonly failedTasks: number;
  readonly activeWorkers: number;
  readonly verifiedCount: number;
  readonly integratedCount: number;
  readonly haltReason: string | null;
  readonly phases: Array<{ readonly name: string; readonly state: "done" | "active" | "idle" }>;
}

const HUD_ACTIVE_TASK = ["CLAIMED", "IN_PROGRESS"];
const HUD_FAILED_TASK = ["FAILED", "CANCELLED"];

/** Compact run header model (M25.3): counts and phase chips only, every
 * value traced to persisted rows. No percentages, no invented progress. */
export async function loadRunHud(db: PrismaClient, featureId: string): Promise<RunHud> {
  const feature = await db.feature.findUnique({ where: { id: featureId } });
  if (feature === null) {
    throw new Error(`unknown run scope: expected a feature ID, got ${JSON.stringify(featureId)}`);
  }
  const [tasks, workers, verifyEvents, merges, halted] = await Promise.all([
    db.task.findMany({ where: { featureId }, select: { id: true, status: true } }),
    db.worker.findMany({ where: { task: { featureId } }, select: { status: true } }),
    db.event.findMany({ where: { featureId, type: "VERIFICATION_COMPLETED" }, select: { taskId: true, payload: true } }),
    db.commit.findMany({ where: { taskId: { in: (await db.task.findMany({ where: { featureId }, select: { id: true } })).map((t) => t.id) }, branch: { startsWith: "atlas/" } }, select: { id: true } }),
    db.event.findMany({ where: { featureId, type: "INTEGRATION_FAILED" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1 }),
  ]);
  const activeTasks = tasks.filter((t) => HUD_ACTIVE_TASK.includes(t.status)).length;
  const failedTasks = tasks.filter((t) => HUD_FAILED_TASK.includes(t.status)).length;
  const activeWorkers = workers.filter((w) => ["ASSIGNED", "RUNNING", "VERIFYING"].includes(w.status)).length;
  const verifiedIds = new Set<string>();
  for (const event of verifyEvents) {
    if (event.taskId === null) {
      continue;
    }
    try {
      if ((JSON.parse(event.payload ?? "") as { verdict?: unknown }).verdict === "VERIFIED") {
        verifiedIds.add(event.taskId);
      }
    } catch {
      // Skip unparseable payloads.
    }
  }
  let haltReason: string | null = null;
  const haltEvent = halted[0];
  if (haltEvent !== undefined) {
    try {
      const reason = (JSON.parse(haltEvent.payload ?? "") as { haltReason?: unknown }).haltReason;
      haltReason = typeof reason === "string" ? reason : "see train view";
    } catch {
      haltReason = "see train view";
    }
  }
  const phases = [
    { name: "PLAN", state: (tasks.length > 0 ? "done" : "idle") as "done" | "active" | "idle" },
    { name: "EXECUTE", state: (activeTasks > 0 ? "active" : tasks.length > 0 ? "done" : "idle") as "done" | "active" | "idle" },
    { name: "VERIFY", state: (verifiedIds.size > 0 ? "done" : tasks.some((t) => t.status === "VERIFICATION") ? "active" : "idle") as "done" | "active" | "idle" },
    { name: "MERGE", state: (merges.length > 0 ? "done" : haltReason !== null ? "active" : "idle") as "done" | "active" | "idle" },
  ];
  return {
    featureId,
    title: feature.title,
    status: feature.status,
    totalTasks: tasks.length,
    activeTasks,
    failedTasks,
    activeWorkers,
    verifiedCount: verifiedIds.size,
    integratedCount: merges.length,
    haltReason,
    phases,
  };
}
