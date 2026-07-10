// createDashboardServer — wires every view/action module into the HTTP
// router. Mirrors @aart/server's own composition pattern (one server.ts
// wiring many domain modules — flags.ts, promotion.ts, environments.ts —
// together, observed in the S2 sibling worktree) rather than putting route
// logic inline here; this file is thin glue: parse request -> call a
// views/ function -> render or redirect.
import { createServer, type Server } from "node:http";
import type { AartStore } from "@aart/store";
import type { ApiClient } from "./api-client.js";
import type { DashboardConfig } from "./config.js";
import { DEFAULT_DASHBOARD_PORT } from "./config.js";
import type { Clock } from "./clock.js";
import { systemClock } from "./clock.js";
import type { DashboardDeps } from "./deps.js";
import { redirect, Router, sendHtml, sendJson } from "./http/router.js";
import { escapeHtml, page } from "./http/html.js";
import { decideApprovalAction, renderApprovalQueuePage } from "./views/approvals.js";
import { listBlockManifests } from "./capability-catalog.js";
import { renderBlocksPage, renderPacksPage } from "./views/blocks-packs.js";
import {
  blockPromotionAction,
  clearNeedsReviewAction,
  createEvalExampleFromCorrectionAction,
  createIssueForAgentAction,
  findCorrectionByKey,
  markNeedsReviewAction,
  recordCorrectionAction,
  renderCorrectionQueuePage,
  renderRecordCorrectionFormPage,
  triggerImprovementProposalAction,
  unblockPromotionAction,
  updateRunOutputAction,
} from "./views/corrections.js";
import { createEvalAction, renderCreateEvalFormPage, renderEvalDashboardPage, runEvalAction } from "./views/evals.js";
import { clearFlagAction, renderFlaggedRunsPage } from "./views/flags.js";
import { renderDeploymentsPage, renderEnvironmentsPage, renderSecretsStatusPage, renderTriggerConfigsPage, renderWorkerHealthPage, type WorkerHealthEntry } from "./views/production.js";
import { listRunsFilterFromQuery, renderArtifactsPage, renderRunDetailPage, renderRunsListPage, renderTriggerFormPage, renderWaitingRunsPage, triggerWorkflowAction } from "./views/runs.js";
import { approveOrDeprecateAction, promoteAction, renderRiskDiffPage, renderWorkflowDetailPage, renderWorkflowsListPage } from "./views/workflows.js";

function str(body: Record<string, unknown>, key: string, fallback = ""): string {
  const v = body[key];
  return typeof v === "string" ? v : fallback;
}

function parseJsonField(body: Record<string, unknown>, key: string): Record<string, unknown> {
  const raw = str(body, key, "{}");
  try {
    const parsed = JSON.parse(raw || "{}") as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function buildDashboardRouter(store: AartStore, api: ApiClient, deps: DashboardDeps, clock: Clock, workerUrls: readonly string[]): Router {
  const router = new Router();

  // -- v1 read-only pages (architecture §13.1) -------------------------------

  router.get("/", (ctx) => redirect(ctx.res, "/runs"));

  router.get("/runs/trigger", async (ctx) => {
    sendHtml(ctx.res, 200, renderTriggerFormPage(await api.listWorkflowIds()));
  });
  router.post("/runs/trigger", async (ctx, body) => {
    const inputs = parseJsonField(body, "inputs");
    const environment = str(body, "environment") || undefined;
    const run = await triggerWorkflowAction(deps, store, { workflowId: str(body, "workflowId"), workflowVersion: str(body, "workflowVersion"), inputs, environment });
    redirect(ctx.res, `/runs/${encodeURIComponent(run.runId)}`);
  });

  router.get("/runs", async (ctx) => {
    const runs = await api.listRuns(listRunsFilterFromQuery(ctx.query));
    sendHtml(ctx.res, 200, renderRunsListPage(runs));
  });

  router.get("/runs/:id", async (ctx) => {
    const run = await api.getRun(ctx.params["id"]!);
    if (!run) {
      sendHtml(ctx.res, 404, page("Not Found", "<p>No such run.</p>"));
      return;
    }
    const renderers = deps.createReportRenderers(deps.redact);
    sendHtml(ctx.res, 200, renderRunDetailPage(run, renderers.html(run)));
  });

  router.get("/workflows", async (ctx) => {
    sendHtml(ctx.res, 200, renderWorkflowsListPage(await api.listWorkflowIds()));
  });

  // Full Workflow detail isn't in S2's documented HTTP shape yet (GET
  // /workflows only returns bare ids) — read directly from the store. See
  // this package's SEAMS.md.
  router.get("/workflows/:id", async (ctx) => {
    const workflow = await store.workflows.getLatest(ctx.params["id"]!);
    if (!workflow) {
      sendHtml(ctx.res, 404, page("Not Found", "<p>No such workflow.</p>"));
      return;
    }
    sendHtml(ctx.res, 200, renderWorkflowDetailPage(workflow));
  });

  router.post("/workflows/:id/approve", async (ctx, body) => {
    const id = ctx.params["id"]!;
    const action = str(body, "action") === "deprecate" ? "deprecate" : "approve";
    const trustMode = (str(body, "trustMode", "governed") as Parameters<typeof approveOrDeprecateAction>[5]) ?? "governed";
    await approveOrDeprecateAction(deps, store, id, str(body, "version"), action, trustMode);
    redirect(ctx.res, `/workflows/${encodeURIComponent(id)}`);
  });

  router.post("/workflows/:id/promote", async (ctx, body) => {
    const id = ctx.params["id"]!;
    await promoteAction(deps, store, id, str(body, "version"), str(body, "environmentId"));
    redirect(ctx.res, `/workflows/${encodeURIComponent(id)}`);
  });

  router.post("/workflows/:id/risk-diff", async (ctx, body) => {
    const id = ctx.params["id"]!;
    const fromVersion = str(body, "fromVersion");
    const toVersion = str(body, "toVersion");
    const [a, b] = await Promise.all([store.workflows.get(id, fromVersion), store.workflows.get(id, toVersion)]);
    if (!a || !b) {
      sendHtml(ctx.res, 404, page("Not Found", "<p>One or both workflow versions not found.</p>"));
      return;
    }
    sendHtml(ctx.res, 200, renderRiskDiffPage(id, fromVersion, toVersion, deps.semanticRiskDiff(a, b)));
  });

  router.post("/workflows/:id/block-promotion", async (ctx, body) => {
    await blockPromotionAction(deps, store, ctx.params["id"]!, str(body, "version"));
    redirect(ctx.res, `/workflows/${encodeURIComponent(ctx.params["id"]!)}`);
  });
  router.post("/workflows/:id/unblock-promotion", async (ctx, body) => {
    await unblockPromotionAction(deps, store, ctx.params["id"]!, str(body, "version"));
    redirect(ctx.res, `/workflows/${encodeURIComponent(ctx.params["id"]!)}`);
  });
  router.post("/workflows/:id/mark-needs-review", async (ctx, body) => {
    await markNeedsReviewAction(deps, store, ctx.params["id"]!, str(body, "version"));
    redirect(ctx.res, `/workflows/${encodeURIComponent(ctx.params["id"]!)}`);
  });
  router.post("/workflows/:id/clear-needs-review", async (ctx, body) => {
    await clearNeedsReviewAction(deps, store, ctx.params["id"]!, str(body, "version"));
    redirect(ctx.res, `/workflows/${encodeURIComponent(ctx.params["id"]!)}`);
  });
  router.post("/workflows/:id/trigger-improvement", async (ctx, body) => {
    await triggerImprovementProposalAction(deps, store, ctx.params["id"]!, str(body, "version"));
    redirect(ctx.res, `/workflows/${encodeURIComponent(ctx.params["id"]!)}`);
  });

  router.get("/blocks", (ctx) => sendHtml(ctx.res, 200, renderBlocksPage(listBlockManifests(store))));
  router.get("/packs", (ctx) => sendHtml(ctx.res, 200, renderPacksPage()));

  router.get("/artifacts", async (ctx) => {
    sendHtml(ctx.res, 200, renderArtifactsPage(await api.listRuns()));
  });

  // -- v2 (architecture §13.2) -------------------------------------------

  router.get("/waiting-runs", async (ctx) => {
    sendHtml(ctx.res, 200, renderWaitingRunsPage(await api.listWaitingRuns(), clock.now()));
  });

  router.get("/approvals", async (ctx) => {
    sendHtml(ctx.res, 200, renderApprovalQueuePage(await store.approvals.list({ status: "pending" })));
  });
  router.post("/approvals/:id/decision", async (ctx, body) => {
    const status = str(body, "status") as "approved" | "rejected" | "needs_changes";
    const trustMode = (str(body, "trustMode", "governed") as Parameters<typeof decideApprovalAction>[6]) ?? "governed";
    await decideApprovalAction(deps, store, ctx.params["id"]!, status, str(body, "reviewer", "dashboard-operator"), undefined, trustMode);
    redirect(ctx.res, "/approvals");
  });

  router.get("/corrections/new", (ctx) => {
    sendHtml(ctx.res, 200, renderRecordCorrectionFormPage(ctx.query.get("runId") ?? "", ctx.query.get("stepId") ?? ""));
  });
  router.post("/corrections", async (ctx, body) => {
    await recordCorrectionAction(deps, store, {
      runId: str(body, "runId"),
      stepId: str(body, "stepId"),
      fieldPath: str(body, "fieldPath"),
      observed: parseJsonField(body, "observed"),
      corrected: parseJsonField(body, "corrected"),
      reason: str(body, "reason"),
      reviewer: str(body, "reviewer"),
    });
    redirect(ctx.res, "/corrections");
  });
  router.get("/corrections", async (ctx) => {
    sendHtml(ctx.res, 200, renderCorrectionQueuePage(await store.corrections.list()));
  });
  router.post("/corrections/:key/update-run-output", async (ctx) => {
    const correction = await findCorrectionByKey(store, ctx.params["key"]!);
    if (!correction) {
      sendHtml(ctx.res, 404, page("Not Found", "<p>No such correction.</p>"));
      return;
    }
    await updateRunOutputAction(deps, store, correction);
    redirect(ctx.res, "/corrections");
  });
  router.post("/corrections/:key/create-eval-example", async (ctx, body) => {
    const correction = await findCorrectionByKey(store, ctx.params["key"]!);
    if (!correction) {
      sendHtml(ctx.res, 404, page("Not Found", "<p>No such correction.</p>"));
      return;
    }
    await createEvalExampleFromCorrectionAction(deps, store, correction, str(body, "suiteId"));
    redirect(ctx.res, "/corrections");
  });
  router.post("/corrections/:key/create-issue", async (ctx) => {
    const correction = await findCorrectionByKey(store, ctx.params["key"]!);
    if (!correction) {
      sendHtml(ctx.res, 404, page("Not Found", "<p>No such correction.</p>"));
      return;
    }
    const brief = await createIssueForAgentAction(deps, store, correction);
    sendJson(ctx.res, 200, brief);
  });

  router.get("/evals/new", (ctx) => sendHtml(ctx.res, 200, renderCreateEvalFormPage()));
  router.post("/evals/suites", async (ctx, body) => {
    await createEvalAction(deps, store, { name: str(body, "name"), description: str(body, "description") || undefined, scorer: { id: `scorer-${Date.now()}`, kind: str(body, "scorerKind", "exact_match") } });
    redirect(ctx.res, "/evals");
  });
  router.post("/evals/runs", async (ctx, body) => {
    await runEvalAction(deps, store, str(body, "suiteId"), str(body, "workflowId"), str(body, "workflowVersion"));
    redirect(ctx.res, "/evals");
  });
  router.get("/evals", async (ctx) => {
    const [suites, runs] = await Promise.all([store.evals.listSuites(), store.evals.listRuns()]);
    sendHtml(ctx.res, 200, renderEvalDashboardPage(suites, runs));
  });

  // -- v3 production additions (architecture §13.3) -----------------------

  router.get("/environments", async (ctx) => sendHtml(ctx.res, 200, renderEnvironmentsPage(await api.listEnvironments())));
  router.get("/deployments", async (ctx) => sendHtml(ctx.res, 200, renderDeploymentsPage(await api.listDeployments())));
  router.get("/trigger-configs", async (ctx) => sendHtml(ctx.res, 200, renderTriggerConfigsPage(await api.listDeployments())));
  router.get("/secrets", async (ctx) => sendHtml(ctx.res, 200, renderSecretsStatusPage(await api.listEnvironments())));

  router.get("/worker-health", async (ctx) => {
    const workers: WorkerHealthEntry[] = await Promise.all(
      workerUrls.map(async (url): Promise<WorkerHealthEntry> => {
        try {
          return { url, health: await api.workerHealth(url) };
        } catch (err) {
          return { url, health: { error: err instanceof Error ? err.message : "unknown error" } };
        }
      }),
    );
    sendHtml(ctx.res, 200, renderWorkerHealthPage(workers));
  });

  // Flagged runs (v3, architecture §13.3 F3 fix) — dashboard/CLI only,
  // deliberately no MCP surface (see views/flags.ts's header comment).
  router.get("/flagged-runs", async (ctx) => {
    sendHtml(ctx.res, 200, renderFlaggedRunsPage(await api.listFlaggedRunsViaApi()));
  });
  router.post("/flagged-runs/:runId/clear", async (ctx, body) => {
    const result = await clearFlagAction(deps, store, ctx.params["runId"]!, str(body, "clearedBy", "dashboard-operator"));
    if (result.kind !== "cleared") {
      sendHtml(ctx.res, 409, page("Could Not Clear", `<p>${escapeHtml(result.kind)}</p>`));
      return;
    }
    redirect(ctx.res, "/flagged-runs");
  });

  router.get("/health", (ctx) => sendJson(ctx.res, 200, { status: "ok" }));

  return router;
}

export interface DashboardHandle {
  server: Server;
  port: number;
  close(): Promise<void>;
}

export async function startDashboard(config: DashboardConfig): Promise<DashboardHandle> {
  const clock = config.clock ?? systemClock;
  const router = buildDashboardRouter(config.store, config.api, config.deps, clock, config.workerUrls ?? []);
  const server = createServer((req, res) => void router.handle(req, res));
  const port = config.port ?? DEFAULT_DASHBOARD_PORT;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, resolve);
  });
  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : port;
  return {
    server,
    port: boundPort,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

// Re-exported for callers that just want the router (e.g. mounting inside
// another process's own HTTP server at a path prefix) without this
// package owning the listening socket.
export { Router };
