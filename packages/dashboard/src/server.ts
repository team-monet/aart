// createDashboardServer — wires every view/action module into the HTTP
// router. Mirrors @aart/server's own composition pattern (one server.ts
// wiring many domain modules — flags.ts, promotion.ts, environments.ts —
// together, observed in the S2 sibling worktree) rather than putting route
// logic inline here; this file is thin glue: parse request -> call `api`'s
// (or, for pure rendering, `deps`'s) function -> render or redirect.
//
// AMENDMENTS.md A47: every route below — read OR write — now goes through
// `api: ApiClient` alone. Before this session, only v1's read pages did;
// every writable action (trigger a run, approve/promote/block/mark a
// workflow, decide an approval task, record/act on a correction, create/run
// an eval suite, clear a run's flag) called `deps.X(store, ...)` directly
// against a SEPARATE, locally-constructed `AartStore` handle — exactly the
// class of bug root AMENDMENTS.md A43 found and fixed for workflow/block
// detail (a dashboard process whose own store handle points at a
// different, possibly-misconfigured root than the server process's own
// store silently shows wrong/empty data, or in a write's case, silently
// writes to the WRONG place, or a `riskReview` decision gets misattributed
// to `humanReview` because a second, divergent reimplementation drifted
// from the real one — root AMENDMENTS.md A46's flagged finding). Every one
// of those actions now has a real implementation server-side
// (`packages/server/src/http/server.ts`) and this file calls it through
// `api` — the dashboard's ONLY connection to data is the server it points
// at, full stop. `store`/`deps` remain in `DashboardConfig` (both OPTIONAL
// now, see config.ts) for the two things that are genuinely never
// store-path-dependent: the Blocks/Packs pages' pure in-memory capability
// catalog, and Run detail's pure report-rendering transform.
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFsStore, type AartStore } from "@aart/store";
import type { ApiClient } from "./api-client.js";
import type { DashboardConfig } from "./config.js";
import { DEFAULT_DASHBOARD_PORT } from "./config.js";
import type { Clock } from "./clock.js";
import { systemClock } from "./clock.js";
import type { DashboardDeps } from "./deps.js";
import { createStubDeps } from "./stub-deps.js";
import { redirect, Router, sendHtml, sendJson } from "./http/router.js";
import { escapeHtml, page } from "./http/html.js";
import { renderApprovalQueuePage } from "./views/approvals.js";
import { getBlockManifest, listBlockManifests } from "./capability-catalog.js";
import { renderBlockDetailPage, renderBlocksPage, renderPacksPage } from "./views/blocks-packs.js";
import { renderCorrectionQueuePage, renderRecordCorrectionFormPage } from "./views/corrections.js";
import { renderCreateEvalFormPage, renderEvalDashboardPage } from "./views/evals.js";
import { renderFlaggedRunsPage } from "./views/flags.js";
import { renderDeploymentsPage, renderEnvironmentsPage, renderSecretsStatusPage, renderTriggerConfigsPage, renderWorkerHealthPage, type WorkerHealthEntry } from "./views/production.js";
import { listRunsFilterFromQuery, renderArtifactsPage, renderRunDetailPage, renderRunsListPage, renderTriggerFormPage, renderWaitingRunsPage } from "./views/runs.js";
import { renderRiskDiffPage, renderWorkflowDetailPage, renderWorkflowsListPage } from "./views/workflows.js";

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
    const run = await api.triggerRun({ workflowId: str(body, "workflowId"), workflowVersion: str(body, "workflowVersion") || undefined, inputs, environment });
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

  // Reads through `api` (S2's now-enriched GET /workflows/:id), not a
  // second directly-constructed store handle — see views/workflows.ts's
  // header comment for why that used to be a real, reproduced bug (root
  // AMENDMENTS.md A43), not just a hypothetical one. `?version=` lets the
  // Versions section (rendered below) drill into any past version, not
  // just latest.
  router.get("/workflows/:id", async (ctx) => {
    const id = ctx.params["id"]!;
    const detail = await api.getWorkflow(id, ctx.query.get("version") ?? undefined);
    if (!detail) {
      sendHtml(ctx.res, 404, page("Not Found", "<p>No such workflow.</p>"));
      return;
    }
    const recentRuns = await api.listRuns({ workflowId: id });
    sendHtml(ctx.res, 200, renderWorkflowDetailPage(detail.workflow, detail.versions, recentRuns));
  });

  router.post("/workflows/:id/approve", async (ctx, body) => {
    const id = ctx.params["id"]!;
    const action = str(body, "action") === "deprecate" ? "deprecate" : "approve";
    const trustMode = (str(body, "trustMode", "governed") as Parameters<ApiClient["approveOrDeprecateWorkflow"]>[3]) || "governed";
    await api.approveOrDeprecateWorkflow(id, str(body, "version"), action, trustMode);
    redirect(ctx.res, `/workflows/${encodeURIComponent(id)}`);
  });

  router.post("/workflows/:id/promote", async (ctx, body) => {
    const id = ctx.params["id"]!;
    await api.promoteWorkflow(id, str(body, "version"), str(body, "environmentId"));
    redirect(ctx.res, `/workflows/${encodeURIComponent(id)}`);
  });

  router.post("/workflows/:id/risk-diff", async (ctx, body) => {
    const id = ctx.params["id"]!;
    const fromVersion = str(body, "fromVersion");
    const toVersion = str(body, "toVersion");
    const [from, to] = await Promise.all([api.getWorkflow(id, fromVersion), api.getWorkflow(id, toVersion)]);
    if (!from || !to) {
      sendHtml(ctx.res, 404, page("Not Found", "<p>One or both workflow versions not found.</p>"));
      return;
    }
    sendHtml(ctx.res, 200, renderRiskDiffPage(id, fromVersion, toVersion, deps.semanticRiskDiff(from.workflow, to.workflow)));
  });

  router.post("/workflows/:id/block-promotion", async (ctx, body) => {
    await api.blockPromotion(ctx.params["id"]!, str(body, "version"));
    redirect(ctx.res, `/workflows/${encodeURIComponent(ctx.params["id"]!)}`);
  });
  router.post("/workflows/:id/unblock-promotion", async (ctx, body) => {
    await api.unblockPromotion(ctx.params["id"]!, str(body, "version"));
    redirect(ctx.res, `/workflows/${encodeURIComponent(ctx.params["id"]!)}`);
  });
  router.post("/workflows/:id/mark-needs-review", async (ctx, body) => {
    await api.markNeedsReview(ctx.params["id"]!, str(body, "version"));
    redirect(ctx.res, `/workflows/${encodeURIComponent(ctx.params["id"]!)}`);
  });
  router.post("/workflows/:id/clear-needs-review", async (ctx, body) => {
    await api.clearNeedsReview(ctx.params["id"]!, str(body, "version"));
    redirect(ctx.res, `/workflows/${encodeURIComponent(ctx.params["id"]!)}`);
  });
  router.post("/workflows/:id/trigger-improvement", async (ctx, body) => {
    await api.triggerImprovementProposal(ctx.params["id"]!, str(body, "version"));
    redirect(ctx.res, `/workflows/${encodeURIComponent(ctx.params["id"]!)}`);
  });

  // Blocks/Packs — the one pair of pages that legitimately still takes
  // `store` (capability-catalog.ts's own doc comment: a pure, static,
  // in-memory construction from @aart/blocks-core/@aart/llm manifests,
  // never filesystem-path-dependent — confirmed by A43's own investigation
  // and unchanged by this session). `store` here is whatever
  // `startDashboard` resolved (the caller's real one, or the internal
  // always-valid placeholder — see startDashboard's own doc comment) —
  // either way this route never performs I/O through it.
  router.get("/blocks", (ctx) => sendHtml(ctx.res, 200, renderBlocksPage(listBlockManifests(store))));
  // Block detail — previously not a route at all (no view, no link from
  // the Blocks list above); a founder test drive confirmed there was no
  // way to reach it (root AMENDMENTS.md A43). Reads the same real, local,
  // in-memory catalog `/blocks` already does (@aart/blocks-core + @aart/llm
  // manifests) — never store-path-dependent the way workflow detail used
  // to be, so this one was purely a missing feature, not a wiring bug.
  router.get("/blocks/:id", (ctx) => {
    const manifest = getBlockManifest(store, ctx.params["id"]!);
    if (!manifest) {
      sendHtml(ctx.res, 404, page("Not Found", "<p>No such block.</p>"));
      return;
    }
    sendHtml(ctx.res, 200, renderBlockDetailPage(manifest));
  });
  router.get("/packs", (ctx) => sendHtml(ctx.res, 200, renderPacksPage()));

  router.get("/artifacts", async (ctx) => {
    sendHtml(ctx.res, 200, renderArtifactsPage(await api.listRuns()));
  });

  // -- v2 (architecture §13.2) -------------------------------------------

  router.get("/waiting-runs", async (ctx) => {
    sendHtml(ctx.res, 200, renderWaitingRunsPage(await api.listWaitingRuns(), clock.now()));
  });

  router.get("/approvals", async (ctx) => {
    sendHtml(ctx.res, 200, renderApprovalQueuePage(await api.listApprovals("pending")));
  });
  // AMENDMENTS.md A47: a thin proxy to the server's own `decideApprovalTask`
  // (`packages/server/src/approvals.ts`) — the dashboard no longer decodes
  // the gate or writes it locally (root AMENDMENTS.md A46's flagged bug:
  // the former local `decideApprovalAction` decoded `t.runId` alone,
  // dropping `t.stepId`, and hardcoded `gates.humanReview` regardless of
  // which gate actually decoded — fixed at the source now that this is the
  // ONE implementation).
  router.post("/approvals/:id/decision", async (ctx, body) => {
    const status = str(body, "status") as "approved" | "rejected" | "needs_changes";
    const trustMode = (str(body, "trustMode", "governed") as Parameters<ApiClient["decideApproval"]>[1]["trustMode"]) || "governed";
    await api.decideApproval(ctx.params["id"]!, { status, reviewer: str(body, "reviewer", "dashboard-operator"), trustMode });
    redirect(ctx.res, "/approvals");
  });

  router.get("/corrections/new", (ctx) => {
    sendHtml(ctx.res, 200, renderRecordCorrectionFormPage(ctx.query.get("runId") ?? "", ctx.query.get("stepId") ?? ""));
  });
  router.post("/corrections", async (ctx, body) => {
    await api.recordCorrection({
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
    sendHtml(ctx.res, 200, renderCorrectionQueuePage(await api.listCorrections()));
  });
  router.post("/corrections/:key/update-run-output", async (ctx) => {
    const run = await api.updateCorrectionRunOutput(ctx.params["key"]!);
    if (!run) {
      sendHtml(ctx.res, 404, page("Not Found", "<p>No such correction.</p>"));
      return;
    }
    redirect(ctx.res, "/corrections");
  });
  router.post("/corrections/:key/create-eval-example", async (ctx, body) => {
    const example = await api.createEvalExampleFromCorrection(ctx.params["key"]!, str(body, "suiteId"));
    if (!example) {
      sendHtml(ctx.res, 404, page("Not Found", "<p>No such correction.</p>"));
      return;
    }
    redirect(ctx.res, "/corrections");
  });
  router.post("/corrections/:key/create-issue", async (ctx) => {
    const brief = await api.createIssueForCorrection(ctx.params["key"]!);
    if (!brief) {
      sendHtml(ctx.res, 404, page("Not Found", "<p>No such correction.</p>"));
      return;
    }
    sendJson(ctx.res, 200, brief);
  });

  router.get("/evals/new", (ctx) => sendHtml(ctx.res, 200, renderCreateEvalFormPage()));
  router.post("/evals/suites", async (ctx, body) => {
    await api.createEvalSuite({ name: str(body, "name"), description: str(body, "description") || undefined, scorer: { id: `scorer-${Date.now()}`, kind: str(body, "scorerKind", "exact_match") } });
    redirect(ctx.res, "/evals");
  });
  router.post("/evals/runs", async (ctx, body) => {
    await api.runEvalSuite(str(body, "suiteId"), str(body, "workflowId"), str(body, "workflowVersion"));
    redirect(ctx.res, "/evals");
  });
  router.get("/evals", async (ctx) => {
    const { suites, runs } = await api.listEvals();
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
    const result = await api.clearRunFlag(ctx.params["runId"]!, str(body, "clearedBy", "dashboard-operator"));
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

/**
 * A never-persisted-to store, structurally satisfying the two remaining
 * `AartStore`-typed parameters this package's own router still takes
 * (Blocks/Packs' capability catalog, and `createStubDeps`'s own
 * construction requirement) when a caller omits `config.store`/`config.deps`
 * — AMENDMENTS.md A47's "the dashboard needs [a server URL] and NOTHING
 * else" end state. `os.tmpdir()` always exists on any real OS (so this
 * never trips the composition-time root check `@aart/cli`'s
 * `server`/`worker` commands now enforce for their OWN, load-bearing store
 * root — see `packages/cli/src/commands/process.ts`), and nothing in this
 * package's router ever calls a read/write method on it (confirmed:
 * capability-catalog.ts's functions only thread `store` through to
 * `@aart/llm`'s `createLlmPack`, which itself only reads it at BLOCK
 * EXECUTION time — never at manifest-listing time, the only thing this
 * package's Blocks/Packs pages ever do). `createFsStore` itself does zero
 * eager I/O (lazy on first read/write, `packages/store/src/adapters/fs`),
 * so constructing this is free even when nothing ever touches it.
 */
function placeholderStore(): AartStore {
  return createFsStore(path.join(tmpdir(), "aart-dashboard-unused-store"));
}

export async function startDashboard(config: DashboardConfig): Promise<DashboardHandle> {
  const clock = config.clock ?? systemClock;
  const store = config.store ?? placeholderStore();
  const deps = config.deps ?? createStubDeps(store, clock);
  const router = buildDashboardRouter(store, config.api, deps, clock, config.workerUrls ?? []);
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
