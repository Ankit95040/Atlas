#!/usr/bin/env node
import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { getPrismaClient } from "../db/client.js";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadAllWorkers,
  loadClaims,
  loadDependencies,
  loadEvents,
  loadHome,
  loadOverview,
  loadProjects,
  loadRecentEvents,
  loadRunHud,
  loadRuns,
  loadRunState,
  loadTasks,
  loadTransitionOptions,
  loadTrain,
  loadVerification,
  loadWorkers,
  loadWorkflow,
} from "./data.js";
import { buildIslandScene } from "./island3d/scene.js";
import { renderIsland3d } from "./island3d/view.js";
import { approvePlanAction, loadApprovablePlan } from "./actions.js";
import { runRecoverTaskCommand } from "../cli/recover.js";
import { runTaskTransitionCommand } from "../cli/transition.js";
import { runShowTaskCommand } from "../cli/show.js";
import {
  renderClaims,
  renderConfirmApprove,
  renderConfirmRecover,
  renderConfirmTransition,
  renderDeps,
  renderError,
  renderEvents,
  renderGlobalActivity,
  renderGlobalWorkers,
  renderHome,
  renderHud,
  renderNotFound,
  renderOverview,
  renderRunActivity,
  renderRunsPage,
  renderTasks,
  renderTrain,
  renderVerification,
  renderWorkers,
  renderWorkflow,
  type ViewName,
} from "./views.js";
import { renderIsland } from "./island.js";
import { renderIslandProto } from "./island25.js";

// Atlas web dashboard server (M24.1 observability, M24.3 operator actions).
//
// Reads use GET routes that only load. Mutations use POST /actions/* routes
// that reuse the exact CLI service boundaries (plan approval, recovery,
// task transition) — the services re-read authoritative state and
// re-validate, so stale pages can only produce truthful refusals. There are
// deliberately no PUT/DELETE routes and no GET routes that mutate: merely
// visiting a URL never changes state. Merge has no button (no standalone
// merge-approval boundary exists in V0.1).
// Single-operator local dashboard: binds loopback by default (see parseHost).

const VIEW_NAMES: readonly string[] = ["overview", "tasks", "workers", "deps", "workflow", "claims", "verification", "train", "island", "events", "activity"];

function send(response: ServerResponse, status: number, html: string): void {
  // Live dashboard pages and error pages are never cached: stale HTML
  // carries stale import maps and module URLs, and a cached 404 would keep
  // failing after the route exists (M25.3 blank-canvas incident).
  response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(html);
}

function redirect(response: ServerResponse, location: string): void {
  response.writeHead(303, { location });
  response.end();
}

function noticeFrom(url: URL): { kind: "ok" | "err"; text: string } | undefined {
  const kind = url.searchParams.get("kind");
  const text = url.searchParams.get("notice");
  if ((kind === "ok" || kind === "err") && text !== null && text.length > 0 && text.length <= 500) {
    return { kind, text };
  }
  return undefined;
}

function finishOk(response: ServerResponse, featureId: string, view: string, message: string): void {
  redirect(response, `/run?feature=${encodeURIComponent(featureId)}&view=${view}&kind=ok&notice=${encodeURIComponent(message)}`);
}

function finishErr(response: ServerResponse, featureId: string, view: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  redirect(response, `/run?feature=${encodeURIComponent(featureId)}&view=${view}&kind=err&notice=${encodeURIComponent(message.slice(0, 500))}`);
}

const MAX_FORM_BYTES = 8192;

async function readForm(request: IncomingMessage): Promise<URLSearchParams> {
  const contentType = request.headers["content-type"] ?? "";
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > MAX_FORM_BYTES) {
      throw new Error("form body too large");
    }
    chunks.push(buffer);
  }
  if (!contentType.includes("application/x-www-form-urlencoded")) {
    return new URLSearchParams();
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function nonEmpty(value: string | null): string | undefined {
  const trimmed = (value ?? "").trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

// Static vendor/client scripts for the 3D island (M25.1/M25.3). Strict
// allowlist — exact paths only, never user input, so directory traversal is
// impossible. The three.js build directory is exposed file-by-file (single
// path segment, .js only) because three.module.js re-exports versioned
// chunks (three.core.js, ...). three.js stays a local file served by Atlas
// itself: no CDN, no hotlinking.
const STATIC_FILES: Record<string, string> = {
  "/ui-static/OrbitControls.js": "node_modules/three/examples/jsm/controls/OrbitControls.js",
  "/ui-static/island3d-client.js": "dist/ui/island3d/client.js",
  "/ui-static/transitions.js": "dist/ui/island3d/transitions.js",
};
const THREE_BUILD_PREFIX = "/ui-static/three-build/";

async function serveThreeBuild(response: ServerResponse, pathname: string): Promise<boolean> {
  if (!pathname.startsWith(THREE_BUILD_PREFIX)) {
    return false;
  }
  const file = pathname.slice(THREE_BUILD_PREFIX.length);
  if (!/^[A-Za-z0-9._-]+\.js$/.test(file) || file.includes("..")) {
    return false;
  }
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const body = await readFile(join(root, "node_modules", "three", "build", file));
  response.writeHead(200, {
    "content-type": "application/javascript; charset=utf-8",
    // Pinned vendor bytes: immutable. (Our own client files below stay
    // uncached so deploys can never serve stale code.)
    "cache-control": "public, max-age=31536000, immutable",
    "content-length": body.length,
  });
  response.end(body);
  return true;
}

async function serveStatic(response: ServerResponse, pathname: string): Promise<boolean> {
  const relative = STATIC_FILES[pathname];
  if (relative === undefined) {
    return false;
  }
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const body = await readFile(join(root, relative));
  response.writeHead(200, {
    "content-type": "application/javascript; charset=utf-8",
    // Our own code ships uncached: a cached stale client after a deploy
    // fails exactly like the M25.3 blank canvas (old import map + new
    // routes, or vice versa). Bytes are small; correctness wins.
    "cache-control": "no-store",
    "content-length": body.length,
  });
  response.end(body);
  return true;
}

function titlesOf(tasks: Array<{ id: string; title: string }>): Map<string, string> {
  return new Map(tasks.map((t) => [t.id, t.title] as const));
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const method: string = request.method ?? "";
  const url = new URL(request.url ?? "/", "http://localhost");
  const isAction = url.pathname === "/actions/recover" || url.pathname === "/actions/transition" || url.pathname === "/actions/plan/approve";
  if (!isAction && method !== "GET") {
    send(response, 405, renderError(`Method ${method} is not allowed: observational routes are read-only.`));
    return;
  }
  if (isAction && method !== "GET" && method !== "POST") {
    send(response, 405, renderError(`Method ${method} is not allowed: actions require GET (confirm) or POST (execute).`));
    return;
  }
  const db = getPrismaClient();
  try {
    if (url.pathname.startsWith("/ui-static/")) {
      if (method !== "GET") {
        send(response, 405, renderError(`Method ${method} is not allowed.`));
        return;
      }
      try {
        if (await serveThreeBuild(response, url.pathname)) {
          return;
        }
      } catch {
        // Fall through to 404 below (missing chunk, unreadable file).
      }
      if (await serveStatic(response, url.pathname)) {
        return;
      }
      send(response, 404, renderNotFound(`No static file for ${url.pathname}.`));
      return;
    }
    if (url.pathname === "/") {
      const [home, projects] = await Promise.all([loadHome(db), loadProjects(db)]);
      send(response, 200, renderHome(home, projects));
      return;
    }
    if (url.pathname === "/runs") {
      send(response, 200, renderRunsPage(await loadRuns(db)));
      return;
    }
    if (url.pathname === "/workers") {
      send(response, 200, renderGlobalWorkers(await loadAllWorkers(db)));
      return;
    }
    if (url.pathname === "/activity") {
      send(response, 200, renderGlobalActivity(await loadRecentEvents(db)));
      return;
    }
    if (url.pathname === "/run") {
      const featureId = url.searchParams.get("feature");
      if (featureId === null || featureId.length === 0) {
        send(response, 404, renderNotFound("Missing ?feature=<run-id>. Pick a run from the overview page."));
        return;
      }
      const viewParam = url.searchParams.get("view") ?? "overview";
      if (!VIEW_NAMES.includes(viewParam)) {
        send(response, 404, renderNotFound(`Unknown view ${JSON.stringify(viewParam)}.`));
        return;
      }
      const view = viewParam as ViewName;
      // Terminality drives the polling loop (M24.2): active runs poll,
      // terminal runs render once with polling disabled.
      const runState = await loadRunState(db, featureId);
      const live = { runState };
      const notice = noticeFrom(url);
      const hud = renderHud(await loadRunHud(db, featureId));
      switch (view) {
        case "overview": {
          send(response, 200, renderOverview(await loadOverview(db, featureId), live, notice, hud));
          return;
        }
        case "tasks": {
          const tasks = await loadTasks(db, featureId);
          send(response, 200, renderTasks(featureId, tasks, titlesOf(tasks), live, notice, hud));
          return;
        }
        case "workers": {
          send(response, 200, renderWorkers(featureId, await loadWorkers(db, featureId), live, notice, hud));
          return;
        }
        case "deps": {
          send(response, 200, renderDeps(featureId, await loadDependencies(db, featureId), live, notice, hud));
          return;
        }
        case "workflow": {
          send(response, 200, renderWorkflow(featureId, await loadWorkflow(db, featureId), live, notice, hud));
          return;
        }
        case "claims": {
          send(response, 200, renderClaims(featureId, await loadClaims(db, featureId), live, notice, hud));
          return;
        }
        case "verification": {
          send(response, 200, renderVerification(featureId, await loadVerification(db, featureId), live, notice, hud));
          return;
        }
        case "train": {
          send(response, 200, renderTrain(featureId, await loadTrain(db, featureId), live, notice, hud));
          return;
        }
        case "events": {
          send(response, 200, renderEvents(featureId, await loadEvents(db, featureId), live, notice, hud));
          return;
        }
        case "activity": {
          send(response, 200, renderRunActivity(featureId, await loadEvents(db, featureId), live, notice, hud));
          return;
        }
        case "island": {
          const graph = await loadWorkflow(db, featureId);
          if (url.searchParams.get("mode") === "3d") {
            send(response, 200, renderIsland3d(featureId, buildIslandScene(graph), live, notice, hud));
          } else if (url.searchParams.get("mode") === "proto") {
            send(response, 200, renderIslandProto(featureId, graph, live, notice, hud));
          } else {
            send(response, 200, renderIsland(featureId, graph, live, notice, hud));
          }
          return;
        }
      }
    }
    // M24.3 operator actions. Reads use GET confirm pages (no mutation);
    // mutations require POST and reuse the exact CLI service boundaries.
    // Every service re-reads authoritative state and re-validates, so stale
    // dashboard state can only produce truthful refusals, never bad writes.
    if (url.pathname === "/actions/recover" && request.method === "GET") {
      const taskId = url.searchParams.get("task") ?? "";
      const output = await runShowTaskCommand({ taskId }, db);
      const data = output.data as {
        task: { id: string; title: string; status: string };
        worker: { id: string; status: string } | null;
        recovery: { class: string; reason: string };
      };
      const featureId = (await db.task.findUnique({ where: { id: taskId }, select: { featureId: true } }))?.featureId ?? "";
      send(
        response,
        200,
        renderConfirmRecover(featureId, {
          taskId: data.task.id,
          title: data.task.title,
          status: data.task.status,
          workerId: data.worker?.id ?? null,
          workerStatus: data.worker?.status ?? null,
          recoveryClass: data.recovery.class,
          reason: data.recovery.reason,
        }),
      );
      return;
    }
    if (url.pathname === "/actions/recover" && request.method === "POST") {
      const form = await readForm(request);
      const taskId = nonEmpty(form.get("task"));
      const actor = nonEmpty(form.get("actor"));
      if (taskId === undefined) {
        send(response, 400, renderError("Recovery needs a task id."));
        return;
      }
      const featureId =
        nonEmpty(form.get("feature")) ??
        (await db.task.findUnique({ where: { id: taskId }, select: { featureId: true } }))?.featureId ??
        "";
      try {
        const result = await runRecoverTaskCommand({ taskId, ...(actor === undefined ? {} : { actor }) }, db);
        const done = result.data as {
          previousTaskStatus: string;
          resultingTaskStatus: string;
          previousWorkerStatus: string;
          resultingWorkerStatus: string;
        };
        finishOk(
          response,
          featureId,
          "tasks",
          `Recovery completed: task ${taskId} ${done.previousTaskStatus} → ${done.resultingTaskStatus}, worker ${done.previousWorkerStatus} → ${done.resultingWorkerStatus}.`,
        );
      } catch (error) {
        finishErr(response, featureId, "tasks", error);
      }
      return;
    }
    if (url.pathname === "/actions/transition" && request.method === "GET") {
      const taskId = url.searchParams.get("task") ?? "";
      const options = await loadTransitionOptions(db, taskId);
      const featureId = (await db.task.findUnique({ where: { id: taskId }, select: { featureId: true } }))?.featureId ?? "";
      send(
        response,
        200,
        renderConfirmTransition(featureId, {
          taskId: options.taskId,
          title: options.title,
          current: options.current,
          validNext: options.validNext,
        }),
      );
      return;
    }
    if (url.pathname === "/actions/transition" && request.method === "POST") {
      const form = await readForm(request);
      const taskId = nonEmpty(form.get("task"));
      const to = nonEmpty(form.get("to"));
      const actor = nonEmpty(form.get("actor"));
      const reason = nonEmpty(form.get("reason"));
      if (taskId === undefined) {
        send(response, 400, renderError("Transition needs a task id."));
        return;
      }
      const featureId =
        nonEmpty(form.get("feature")) ??
        (await db.task.findUnique({ where: { id: taskId }, select: { featureId: true } }))?.featureId ??
        "";
      try {
        const result = await runTaskTransitionCommand(
          {
            taskId,
            ...(to === undefined ? { to: "" } : { to }),
            ...(actor === undefined ? {} : { actor }),
            ...(reason === undefined ? {} : { reason }),
          },
          db,
        );
        const done = result.data as { previousStatus: string; resultingStatus: string };
        finishOk(response, featureId, "tasks", `Transition completed: task ${taskId} ${done.previousStatus} → ${done.resultingStatus}.`);
      } catch (error) {
        finishErr(response, featureId, "tasks", error);
      }
      return;
    }
    if (url.pathname === "/actions/plan/approve" && request.method === "GET") {
      const featureId = url.searchParams.get("feature") ?? "";
      const approvalId = url.searchParams.get("approval") ?? "";
      const approval = await loadApprovablePlan(db, featureId, approvalId);
      const taskCount = await db.task.count({ where: { featureId } });
      send(
        response,
        200,
        renderConfirmApprove(featureId, {
          id: approval.id,
          status: approval.status,
          context: approval.context,
          note: approval.note,
          taskCount,
        }),
      );
      return;
    }
    if (url.pathname === "/actions/plan/approve" && request.method === "POST") {
      const form = await readForm(request);
      const featureId = nonEmpty(form.get("feature")) ?? "";
      const approvalId = nonEmpty(form.get("approval")) ?? "";
      const actor = nonEmpty(form.get("actor"));
      try {
        const result = await approvePlanAction({ featureId, approvalId, ...(actor === undefined ? {} : { actor }) }, db);
        finishOk(
          response,
          featureId,
          "overview",
          `Plan approved: ${result.approvalId} ${result.previousStatus} → ${result.resultingStatus} by ${result.actor}.`,
        );
      } catch (error) {
        finishErr(response, featureId, "overview", error);
      }
      return;
    }
    send(response, 404, renderNotFound(`No route for ${url.pathname}.`));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/unknown run scope/i.test(message)) {
      send(response, 404, renderNotFound(message));
      return;
    }
    send(response, 500, renderError(message));
  }
}

export function createUiServer() {
  return createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      try {
        send(response, 500, renderError(error instanceof Error ? error.message : String(error)));
      } catch {
        // Response already moving; nothing left to do.
      }
    });
  });
}

function parsePort(argv: string[]): number {
  const flag = argv.indexOf("--port");
  if (flag >= 0) {
    const value = Number(argv[flag + 1]);
    if (Number.isInteger(value) && value > 0 && value < 65536) {
      return value;
    }
    throw new Error(`--port must be an integer 1-65535, got ${JSON.stringify(argv[flag + 1])}`);
  }
  const env = process.env["ATLAS_UI_PORT"];
  if (env !== undefined && env.length > 0) {
    const value = Number(env);
    if (Number.isInteger(value) && value > 0 && value < 65536) {
      return value;
    }
    throw new Error(`ATLAS_UI_PORT must be an integer 1-65535, got ${JSON.stringify(env)}`);
  }
  return 3179;
}

function parseHost(argv: string[]): string {
  const flag = argv.indexOf("--host");
  if (flag >= 0 && argv[flag + 1] !== undefined && argv[flag + 1] !== "") {
    return argv[flag + 1] as string;
  }
  const env = process.env["ATLAS_UI_HOST"];
  if (env !== undefined && env.length > 0) {
    return env;
  }
  // Single-operator local dashboard: loopback only, so only processes on
  // this machine can reach the mutation routes. No auth framework; the
  // confirmation pages + POST-only routes + service re-validation are the
  // request safety for this threat model. Override explicitly to expose.
  return "127.0.0.1";
}

// Only serve when executed directly (`node ./dist/ui/serve.js`); importing
// this module (tests do) must not bind a port.
const invokedDirectly = process.argv[1] !== undefined && process.argv[1].endsWith("/ui/serve.js");
if (invokedDirectly) {
  const server = createUiServer();
  const host = parseHost(process.argv.slice(2));
  server.listen(parsePort(process.argv.slice(2)), host, () => {
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 3179;
    console.log(`atlas ui: dashboard at http://${host}:${port} (reads DATABASE_URL like the CLI; POST actions confirmed + service-validated)`);
  });
}
