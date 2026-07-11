// startServer() — the control-plane process (architecture §0.1-0.3):
// "HTTP API server (aart server) with webhook ingress, approval endpoints,
// dashboard-hosting mount point... plus... the scheduler ticker." This
// session's DoD note: "dashboard content itself is S8's scope — S2 just
// needs to expose the mount point/API surface S8 will consume."
import { createServer, type Server } from "node:http";
import type { ApprovalTask, Signal } from "@aart/types";
import { systemClock, type Clock } from "../clock.js";
import { DEFAULT_HTTP_PORT, type ServerConfig } from "../config.js";
import { clearRunFlag, listFlaggedRuns } from "../flags.js";
import { generateId } from "../ids.js";
import { createServerLogger, type Logger } from "../logger.js";
import { createTicker, type TickerHandle } from "../ticker/ticker.js";
import { adaptGithubTrigger, adaptSlackTrigger, adaptWebhookTrigger, ingestGithubPrMergeApproval, isGithubPrMergeEvent, type AdapterResult } from "../triggers/adapters.js";
import { processTriggerIntake, recordRejectedTrigger } from "../triggers/intake.js";
import { loadTriggerBindingsFromDeployments } from "../triggers/registry.js";
import type { InboundDelivery, IntakeOutcome, TriggerBinding } from "../triggers/types.js";
import { sendJson, Router } from "./router.js";

export interface ServerHandle {
  server: Server;
  port: number;
  ticker?: TickerHandle;
  close(): Promise<void>;
}

function flattenHeaders(headers: NodeJS.Dict<string | string[]>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

function outcomeStatus(outcome: IntakeOutcome | { kind: "pr_merge_approval"; approvalTask: ApprovalTask | undefined }): number {
  switch (outcome.kind) {
    case "started":
    case "queued":
    case "resumed":
    case "duplicate_resume":
    case "pr_merge_approval":
      return 200;
    case "no_match":
      return 202; // accepted, nothing to do yet — not an error
    case "ambiguous":
      return 409;
    case "rejected":
      return outcome.reason === "bad_hmac" ? 401 : 429;
    default:
      return 200;
  }
}

async function findBinding(config: ServerConfig, bindingId: string): Promise<TriggerBinding | undefined> {
  const bindings = await loadTriggerBindingsFromDeployments(config.store, { environmentId: config.environmentId });
  return bindings.find((b) => b.id === bindingId);
}

export async function startServer(config: ServerConfig): Promise<ServerHandle> {
  const clock: Clock = config.clock ?? systemClock;
  const logger: Logger = createServerLogger(config.logSink).child({ component: "http-server" });
  const router = new Router();

  const intakeDeps = () => ({ store: config.store, engine: config.engine, clock, logger, backpressure: config, poisonGuard: config });

  router.post("/webhooks/:bindingId", async (ctx, body, rawBody) => {
    const binding = await findBinding(config, ctx.params["bindingId"]!);
    if (!binding) return sendJson(ctx.res, 404, { error: "unknown trigger binding" });
    const secret = binding.webhookHmacSecretRef ? await config.secretResolver?.(binding.webhookHmacSecretRef) : undefined;
    const delivery: InboundDelivery = { payload: body, headers: flattenHeaders(ctx.req.headers), rawBody, receivedAt: clock.nowIso() };
    const adapted: AdapterResult = adaptWebhookTrigger(binding, delivery, secret, clock);
    if ("rejected" in adapted) {
      await recordRejectedTrigger({ store: config.store, clock, logger }, "webhook", adapted.rejected, body);
      return sendJson(ctx.res, 401, { error: adapted.rejected });
    }
    const outcome = await processTriggerIntake(intakeDeps(), binding, adapted);
    return sendJson(ctx.res, outcomeStatus(outcome), outcome);
  });

  router.post("/webhooks/github/:bindingId", async (ctx, body, rawBody) => {
    const binding = await findBinding(config, ctx.params["bindingId"]!);
    if (!binding) return sendJson(ctx.res, 404, { error: "unknown trigger binding" });
    const secret = binding.webhookHmacSecretRef ? await config.secretResolver?.(binding.webhookHmacSecretRef) : undefined;
    const delivery: InboundDelivery = { payload: body, headers: flattenHeaders(ctx.req.headers), rawBody, receivedAt: clock.nowIso() };
    const adapted = adaptGithubTrigger(binding, delivery, secret, clock);
    if ("rejected" in adapted) {
      await recordRejectedTrigger({ store: config.store, clock, logger }, "github", adapted.rejected, body);
      return sendJson(ctx.res, 401, { error: adapted.rejected });
    }
    if (isGithubPrMergeEvent(body)) {
      const approvalTask = await ingestGithubPrMergeApproval(config.store, body, clock, config.resolveGithubApprovalTarget ?? (() => undefined));
      return sendJson(ctx.res, 200, { kind: "pr_merge_approval", approvalTask });
    }
    const outcome = await processTriggerIntake(intakeDeps(), binding, adapted);
    return sendJson(ctx.res, outcomeStatus(outcome), outcome);
  });

  router.post("/webhooks/slack/:bindingId", async (ctx, body, rawBody) => {
    const binding = await findBinding(config, ctx.params["bindingId"]!);
    if (!binding) return sendJson(ctx.res, 404, { error: "unknown trigger binding" });
    const secret = binding.webhookHmacSecretRef ? await config.secretResolver?.(binding.webhookHmacSecretRef) : undefined;
    const delivery: InboundDelivery = { payload: body, headers: flattenHeaders(ctx.req.headers), rawBody, receivedAt: clock.nowIso() };
    const adapted = adaptSlackTrigger(binding, delivery, secret, clock);
    if ("rejected" in adapted) {
      await recordRejectedTrigger({ store: config.store, clock, logger }, "slack", adapted.rejected, body);
      return sendJson(ctx.res, 401, { error: adapted.rejected });
    }
    const outcome = await processTriggerIntake(intakeDeps(), binding, adapted);
    return sendJson(ctx.res, outcomeStatus(outcome), outcome);
  });

  // Approval endpoints (spec §17.5's CLI/dashboard authority surfaces —
  // this HTTP API is what @aart/cli and @aart/dashboard, S5/S8, call; the
  // MCP `aart_approve` tool, mode-gated per §17.5, is a separate S5
  // concern that should route through this same write path, not a second
  // implementation).
  router.post("/approvals/:id/decision", async (ctx, body) => {
    const task = await config.store.approvals.get(ctx.params["id"]!);
    if (!task) return sendJson(ctx.res, 404, { error: "approval task not found" });
    const decision = body as { status: ApprovalTask["status"]; reviewer: string; decision?: unknown };
    if (!decision.reviewer) return sendJson(ctx.res, 400, { error: "reviewer is required" });
    const updated: ApprovalTask = { ...task, status: decision.status, reviewer: decision.reviewer, decision: decision.decision, decidedAt: clock.nowIso() };
    await config.store.approvals.put(updated);
    if (decision.status === "approved" || decision.status === "rejected" || decision.status === "needs_changes") {
      const result = await config.engine.resumeDirect(task.runId, task.stepId, { approval: updated });
      return sendJson(ctx.res, 200, { task: updated, resume: result });
    }
    return sendJson(ctx.res, 200, { task: updated });
  });

  router.post("/runs/:runId/resume", async (ctx, body) => {
    const { stepId, payload } = body as { stepId: string; payload?: unknown };
    if (!stepId) return sendJson(ctx.res, 400, { error: "stepId is required" });
    const result = await config.engine.resumeDirect(ctx.params["runId"]!, stepId, payload);
    return sendJson(ctx.res, 200, result);
  });

  router.post("/runs/:runId/signal", async (ctx, body) => {
    const { name, correlationId, payload } = body as { name: string; correlationId: string; payload?: unknown };
    if (!name || !correlationId) return sendJson(ctx.res, 400, { error: "name and correlationId are required" });
    const signal: Signal = { id: generateId("sig"), name, correlationId, payload, receivedAt: clock.nowIso() };
    await config.store.signals.append(signal);
    const result = await config.engine.resumeWithSignal(signal);
    return sendJson(ctx.res, 200, result);
  });

  // The flagged-run clear action (architecture §4.1/§4.7/§6.2/§13.3) — this
  // HTTP route IS the "dashboard/CLI only, not MCP" surface: no MCP tool
  // anywhere in this codebase calls it, and none should.
  router.post("/runs/:runId/flag/clear", async (ctx, body) => {
    const { clearedBy } = body as { clearedBy?: string };
    if (!clearedBy) return sendJson(ctx.res, 400, { error: "clearedBy is required" });
    const result = await clearRunFlag(config.store, ctx.params["runId"]!, clearedBy, clock);
    const status = result.kind === "cleared" ? 200 : result.kind === "not_found" ? 404 : 409;
    return sendJson(ctx.res, status, result);
  });

  // Read surface — the "API surface S8 will consume" (this session's DoD note).
  router.get("/health", (ctx) => sendJson(ctx.res, 200, { status: "ok" }));
  router.get("/runs", async (ctx) => {
    const status = ctx.query.get("status");
    const workflowId = ctx.query.get("workflowId");
    const runs = await config.store.runs.list({
      status: (status as never) ?? undefined,
      workflowId: workflowId ?? undefined,
    });
    sendJson(ctx.res, 200, { runs });
  });
  router.get("/runs/:id", async (ctx) => {
    const run = await config.store.runs.get(ctx.params["id"]!);
    if (!run) return sendJson(ctx.res, 404, { error: "not found" });
    sendJson(ctx.res, 200, { run });
  });
  router.get("/waiting-runs", async (ctx) => sendJson(ctx.res, 200, { waits: await config.store.waits.list() }));
  router.get("/flagged-runs", async (ctx) => sendJson(ctx.res, 200, { runs: await listFlaggedRuns(config.store) }));
  router.get("/workflows", async (ctx) => sendJson(ctx.res, 200, { workflowIds: await config.store.workflows.listWorkflowIds() }));
  // Enriches the bare-ids list above with a per-workflow read (SEAMS.md
  // "@aart/server's HTTP API surface" — previously flagged, then
  // re-verified at S9 integration, as "not a gap needing S9 to close"
  // since no consumer forced the question. A real founder test drive did:
  // @aart/dashboard's workflow-detail page fell back to reading its own
  // directly-constructed `AartStore` handle instead of this API precisely
  // because this route didn't exist, and that second store handle silently
  // drifted out of sync with the one this process itself uses (root
  // AMENDMENTS.md A43). Closes the gap for real: latest version by
  // default, or a specific one via `?version=`, plus every known version
  // so a caller can render version history without a second round trip.
  router.get("/workflows/:id", async (ctx) => {
    const id = ctx.params["id"]!;
    const requestedVersion = ctx.query.get("version") ?? undefined;
    const [workflow, versions] = await Promise.all([
      requestedVersion ? config.store.workflows.get(id, requestedVersion) : config.store.workflows.getLatest(id),
      config.store.workflows.listVersions(id),
    ]);
    if (!workflow) return sendJson(ctx.res, 404, { error: "not found" });
    sendJson(ctx.res, 200, { workflow, versions });
  });
  router.get("/environments", async (ctx) => sendJson(ctx.res, 200, { environments: await config.store.environments.list() }));
  router.get("/deployments", async (ctx) => sendJson(ctx.res, 200, { deployments: await config.store.deployments.list() }));
  router.get("/rejected-triggers", async (ctx) => sendJson(ctx.res, 200, { rejected: await config.store.rejectedTriggers.list() }));

  // Dashboard-hosting mount point (architecture §13, this session's DoD:
  // "S2 just needs to expose the mount point... dashboard content itself is
  // S8's scope"). Reserved, not implemented here.
  router.get("/dashboard/*", (ctx) => sendJson(ctx.res, 200, { mount: "dashboard", note: "content served by @aart/dashboard (S8) — this route is the reserved mount point only" }));

  const server = createServer((req, res) => {
    void router.handle(req, res);
  });
  const port = config.port ?? DEFAULT_HTTP_PORT;
  const boundPort = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : port);
    });
  });

  let ticker: TickerHandle | undefined;
  if (config.runTicker !== false) {
    ticker = createTicker(
      { store: config.store, engine: config.engine, clock, logger: logger.child({ component: "ticker" }) },
      { tickIntervalMs: config.tickIntervalMs, backpressure: config, poisonGuard: config, environmentId: config.environmentId },
    );
    ticker.start();
  }

  return {
    server,
    port: boundPort,
    ticker,
    close: async () => {
      ticker?.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
