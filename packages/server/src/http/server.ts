// startServer() — the control-plane process (architecture §0.1-0.3):
// "HTTP API server (aart server) with webhook ingress, approval endpoints,
// dashboard-hosting mount point... plus... the scheduler ticker." This
// session's DoD note: "dashboard content itself is S8's scope — S2 just
// needs to expose the mount point/API surface S8 will consume."
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AartStore } from "@aart/store";
import type { ApprovalTask, Scorer, Signal, Trigger, TrustMode, Workflow } from "@aart/types";
import { blockPromotion, clearNeedsReview, createEvalExampleFromCorrection, createIssueForAgent, markNeedsReview, recordCorrection, triggerImprovementProposal, unblockPromotion, updateRunOutput, type RecordCorrectionInput } from "@aart/evidence";
import { decideApprovalTask } from "../approvals.js";
import { type Bundle } from "../bundle/bundle.js";
import { hydrateBundle, readBundleFromEnvelope } from "../bundle/load.js";
import { planBundleIngest } from "../bundle/plan.js";
import { systemClock, type Clock } from "../clock.js";
import { DEFAULT_HTTP_PORT, MAX_BUNDLE_INGEST_BYTES, type ServerConfig } from "../config.js";
import { findCorrectionByKey } from "../corrections.js";
import { checkDeployToken, extractBearerToken } from "../deploy-token.js";
import { registerEnvironment, type RegisterEnvironmentParams } from "../environments.js";
import { createEvalSuite, runEvalSuiteForWorkflow } from "../evals.js";
import { clearRunFlag, listFlaggedRuns } from "../flags.js";
import { generateId } from "../ids.js";
import { createServerLogger, type Logger } from "../logger.js";
import { promoteWorkflowVersionToEnvironment } from "../promotion.js";
import { createTicker, type TickerHandle } from "../ticker/ticker.js";
import { adaptGithubTrigger, adaptSlackTrigger, adaptWebhookTrigger, ingestGithubPrMergeApproval, isGithubPrMergeEvent, type AdapterResult } from "../triggers/adapters.js";
import { processTriggerIntake, recordRejectedTrigger } from "../triggers/intake.js";
import { loadTriggerBindingsFromDeployments } from "../triggers/registry.js";
import type { InboundDelivery, IntakeOutcome, TriggerBinding } from "../triggers/types.js";
import { approveOrDeprecateWorkflow } from "../workflow-actions.js";
import { sendJson, Router, type RouteContext } from "./router.js";

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

/**
 * Shared response glue for the four "workflow flag" write actions
 * (block/unblock-promotion, mark/clear-needs-review — `@aart/evidence`'s
 * `corrections/outcomes.ts`) — every one throws a plain `Error` on an
 * unknown workflow version (evidence's own convention, matching this
 * codebase's other store-glue outcome functions), converted here to this
 * file's own established 404-with-`{error}` shape rather than falling
 * through to the router's generic 500 handler.
 */
async function respondWorkflowFlagAction(
  res: ServerResponse,
  fn: (store: AartStore, workflowId: string, workflowVersion: string) => Promise<Workflow>,
  store: AartStore,
  workflowId: string,
  workflowVersion: string,
): Promise<void> {
  try {
    const workflow = await fn(store, workflowId, workflowVersion);
    sendJson(res, 200, { workflow });
  } catch (err) {
    sendJson(res, 404, { error: err instanceof Error ? err.message : "not found" });
  }
}

/**
 * D1 "remotes + push" (AMENDMENTS.md A56) — gates `POST /bundles/ingest`,
 * `POST /bundles/plan`, `POST /environments` (the deploy-surface mutation
 * routes this session adds). Deliberately NOT applied to the three
 * `/webhooks/*` routes above — those keep their own, separate per-binding
 * HMAC verification (`config.secretResolver`) completely untouched; this
 * token plays no role there. Writes the 401 response itself and returns
 * `false` when the caller must stop; `true` when the request may proceed.
 * `config.deployToken` unset -> every request refused unconditionally
 * (fail-closed, matching `checkDeployToken`'s own contract) — there is no
 * "auth disabled" state for this specific surface, only "not configured
 * yet," always surfaced with the exact remedy (set `AART_DEPLOY_TOKEN`).
 */
function requireDeployToken(config: ServerConfig, ctx: RouteContext): boolean {
  const provided = extractBearerToken(ctx.req.headers.authorization);
  if (checkDeployToken(config.deployToken, provided)) return true;
  const remedy = config.deployToken
    ? 'Provide a valid "Authorization: Bearer <token>" header.'
    : 'This server has no AART_DEPLOY_TOKEN configured — set it (env var, or the "AART_DEPLOY_TOKEN" key in <root>/secrets.json) before this route will accept any request.';
  sendJson(ctx.res, 401, { error: `Unauthorized. ${remedy}` });
  return false;
}

/** Reads `body.files` and validates it's the `{ files: Record<relPath, string> }` envelope shape `POST /bundles/ingest`/`POST /bundles/plan` both require — same shape `bundleToBundleLike` (`@aart/cli`'s `real-server-port.ts`) already builds client-side. Writes the 400 response itself on a malformed body; returns `undefined` when the caller must stop. */
function requireBundleEnvelope(ctx: RouteContext, body: unknown): Record<string, string> | undefined {
  const files = (body as { files?: unknown } | undefined)?.files;
  if (!files || typeof files !== "object" || Array.isArray(files)) {
    sendJson(ctx.res, 400, { error: 'Request body must be { "files": { "<relPath>": "<content>", ... } } — the same envelope produceBundle/bundleToBundleLike builds client-side (aart push).' });
    return undefined;
  }
  return files as Record<string, string>;
}

/**
 * Both `hydrateBundle` and `planBundleIngest` throw plain `Error`s for
 * every failure mode (no typed error hierarchy anywhere in this bundle
 * subsystem — bundle.ts/load.ts's own established convention). Classified
 * here by matching the SAME fixed message substrings those two functions
 * throw verbatim (`resolveHydrationTarget`'s "is not registered on this
 * store", `hydrateBundle`'s own "already hydrated... DIFFERENT bundle"),
 * mirroring how `outcomeStatus` above already switches on a fixed `reason`
 * string elsewhere in this same file — not a new pattern for this codebase.
 */
function bundleErrorStatus(message: string): number {
  if (message.includes("is not registered on this store")) return 404;
  if (message.includes("already hydrated into this store from a DIFFERENT bundle")) return 409;
  return 400; // malformed/tampered bundle content (readBundleFromEnvelope's own failure modes) — a client error either way
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
  //
  // AMENDMENTS.md A47: now handles BOTH ApprovalTask shapes
  // (`../approvals.js`'s `decideApprovalTask` — a genuine per-run wait via
  // `engine.resumeDirect`, or a workflow-version-level gate decision,
  // decoding the ACTUAL gate a task's `stepId` encodes rather than
  // assuming `humanReview` — root AMENDMENTS.md A46's flagged dashboard
  // bug, fixed at its source here since this is now the ONE real
  // implementation the dashboard itself calls instead of reimplementing).
  router.post("/approvals/:id/decision", async (ctx, body) => {
    const decision = body as { status: ApprovalTask["status"]; reviewer: string; decision?: unknown; trustMode?: TrustMode };
    const result = await decideApprovalTask(config.store, config.engine, ctx.params["id"]!, decision, clock);
    switch (result.kind) {
      case "not_found":
        return sendJson(ctx.res, 404, { error: "approval task not found" });
      case "missing_reviewer":
        return sendJson(ctx.res, 400, { error: "reviewer is required" });
      case "invalid_gate":
        return sendJson(ctx.res, 400, { error: `A human decision cannot set gate "${result.gate}" — only humanReview, riskReview are decided via approval tasks.` });
      case "workflow_not_found":
        return sendJson(ctx.res, 404, { error: `Workflow ${result.workflowId}@${result.workflowVersion} not found.` });
      case "workflow_version":
        return sendJson(ctx.res, 200, { kind: result.kind, task: result.task, workflowId: result.workflowId, workflowVersion: result.workflowVersion, gates: result.gates, approval: result.approval });
      case "run_step":
        return sendJson(ctx.res, 200, result.resume ? { kind: result.kind, task: result.task, resume: result.resume } : { kind: result.kind, task: result.task });
    }
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

  // AMENDMENTS.md A47 — every dashboard write action below now has a real
  // server-side implementation, closing the store-divergence bug class
  // (root AMENDMENTS.md A43) for writes the same way A43/this session
  // closed it for reads: the dashboard's ONLY connection to data is this
  // HTTP API, so a misconfigured/absent local store can no longer produce
  // silently-wrong behavior for ANY dashboard action, not just page reads.

  // "Trigger workflow" (§35.2) — via the REAL EngineBoundary.startRun
  // (`engine/boundary.ts`), the SAME real `Engine.triggerRun` a webhook/CLI
  // trigger uses; not a dashboard-local RunRecord-construction stub.
  router.post("/runs/trigger", async (ctx, body) => {
    const { workflowId, workflowVersion, inputs, environment } = body as { workflowId?: string; workflowVersion?: string; inputs?: Record<string, unknown>; environment?: string };
    if (!workflowId) return sendJson(ctx.res, 400, { error: "workflowId is required" });
    const trigger: Trigger = { type: "manual", id: generateId("trig"), source: "dashboard", payload: {}, receivedAt: clock.nowIso() };
    const result = await config.engine.startRun({ workflowId, workflowVersion, trigger, mappedInputs: inputs ?? {}, environment });
    if (result.kind === "rejected") return sendJson(ctx.res, 409, { error: result.reason });
    const run = await config.store.runs.get(result.runId);
    return sendJson(ctx.res, 200, { kind: result.kind, run });
  });

  router.post("/workflows/:id/approve", async (ctx, body) => {
    const { version, action, trustMode } = body as { version?: string; action?: "approve" | "deprecate"; trustMode?: TrustMode };
    if (!version) return sendJson(ctx.res, 400, { error: "version is required" });
    const result = await approveOrDeprecateWorkflow(config.store, ctx.params["id"]!, version, action === "deprecate" ? "deprecate" : "approve", trustMode ?? "governed");
    if (result.kind === "not_found") return sendJson(ctx.res, 404, { error: "not found" });
    return sendJson(ctx.res, 200, { workflow: result.workflow });
  });

  router.post("/workflows/:id/promote", async (ctx, body) => {
    const { version, environmentId, triggerConfig } = body as { version?: string; environmentId?: string; triggerConfig?: Record<string, unknown> };
    if (!version || !environmentId) return sendJson(ctx.res, 400, { error: "version and environmentId are required" });
    const result = await promoteWorkflowVersionToEnvironment(config.store, { workflowId: ctx.params["id"]!, workflowVersion: version, environmentId, triggerConfig }, clock);
    return sendJson(ctx.res, 200, result);
  });

  router.post("/workflows/:id/block-promotion", async (ctx, body) => {
    const { version } = body as { version?: string };
    if (!version) return sendJson(ctx.res, 400, { error: "version is required" });
    await respondWorkflowFlagAction(ctx.res, blockPromotion, config.store, ctx.params["id"]!, version);
  });
  router.post("/workflows/:id/unblock-promotion", async (ctx, body) => {
    const { version } = body as { version?: string };
    if (!version) return sendJson(ctx.res, 400, { error: "version is required" });
    await respondWorkflowFlagAction(ctx.res, unblockPromotion, config.store, ctx.params["id"]!, version);
  });
  router.post("/workflows/:id/mark-needs-review", async (ctx, body) => {
    const { version } = body as { version?: string };
    if (!version) return sendJson(ctx.res, 400, { error: "version is required" });
    await respondWorkflowFlagAction(ctx.res, markNeedsReview, config.store, ctx.params["id"]!, version);
  });
  router.post("/workflows/:id/clear-needs-review", async (ctx, body) => {
    const { version } = body as { version?: string };
    if (!version) return sendJson(ctx.res, 400, { error: "version is required" });
    await respondWorkflowFlagAction(ctx.res, clearNeedsReview, config.store, ctx.params["id"]!, version);
  });
  router.post("/workflows/:id/trigger-improvement", async (ctx, body) => {
    const { version } = body as { version?: string };
    if (!version) return sendJson(ctx.res, 400, { error: "version is required" });
    const brief = await triggerImprovementProposal(config.store, ctx.params["id"]!, version);
    return sendJson(ctx.res, 200, brief);
  });

  router.post("/corrections", async (ctx, body) => {
    const input = body as Partial<RecordCorrectionInput>;
    if (!input.runId || !input.stepId || !input.fieldPath || !input.reason || !input.reviewer) {
      return sendJson(ctx.res, 400, { error: "runId, stepId, fieldPath, reason, and reviewer are required" });
    }
    const correction = await recordCorrection(config.store, input as RecordCorrectionInput);
    return sendJson(ctx.res, 200, { correction });
  });
  router.post("/corrections/:key/update-run-output", async (ctx) => {
    const correction = await findCorrectionByKey(config.store, ctx.params["key"]!);
    if (!correction) return sendJson(ctx.res, 404, { error: "not found" });
    try {
      const run = await updateRunOutput(config.store, correction);
      return sendJson(ctx.res, 200, { run });
    } catch (err) {
      return sendJson(ctx.res, 404, { error: err instanceof Error ? err.message : "not found" });
    }
  });
  router.post("/corrections/:key/create-eval-example", async (ctx, body) => {
    const correction = await findCorrectionByKey(config.store, ctx.params["key"]!);
    if (!correction) return sendJson(ctx.res, 404, { error: "not found" });
    const { suiteId } = body as { suiteId?: string };
    if (!suiteId) return sendJson(ctx.res, 400, { error: "suiteId is required" });
    const example = await createEvalExampleFromCorrection(config.store, correction, suiteId);
    return sendJson(ctx.res, 200, { example });
  });
  router.post("/corrections/:key/create-issue", async (ctx) => {
    const correction = await findCorrectionByKey(config.store, ctx.params["key"]!);
    if (!correction) return sendJson(ctx.res, 404, { error: "not found" });
    try {
      const brief = await createIssueForAgent(config.store, correction);
      return sendJson(ctx.res, 200, brief);
    } catch (err) {
      return sendJson(ctx.res, 404, { error: err instanceof Error ? err.message : "not found" });
    }
  });

  router.post("/evals/suites", async (ctx, body) => {
    const { name, description, scorer } = body as { name?: string; description?: string; scorer?: Scorer };
    if (!name || !scorer) return sendJson(ctx.res, 400, { error: "name and scorer are required" });
    const suite = await createEvalSuite(config.store, { name, description, scorer });
    return sendJson(ctx.res, 200, { suite });
  });
  router.post("/evals/runs", async (ctx, body) => {
    const { suiteId, workflowId, workflowVersion } = body as { suiteId?: string; workflowId?: string; workflowVersion?: string };
    if (!suiteId || !workflowId) return sendJson(ctx.res, 400, { error: "suiteId and workflowId are required" });
    const result = await runEvalSuiteForWorkflow(config.store, suiteId, workflowId, workflowVersion);
    if (result.kind === "suite_not_found") return sendJson(ctx.res, 404, { error: `eval suite not found: ${suiteId}` });
    if (result.kind === "workflow_not_found") return sendJson(ctx.res, 404, { error: `workflow not found: ${workflowId}${workflowVersion ? `@${workflowVersion}` : ""}` });
    return sendJson(ctx.res, 200, { evalRun: result.evalRun, results: result.results });
  });

  // Deploy surface — D1 "remotes + push" (AMENDMENTS.md A56). `aart push`
  // (and the MCP `aart_deploy` tool) POST a bundle envelope here instead of
  // `scp`+bare-process re-hydrate; `POST /bundles/plan` is the same envelope
  // run through a zero-write dry-run preview first. Both, plus `POST
  // /environments` below (ADR-2), are gated by `requireDeployToken` — the
  // three `/webhooks/*` routes above are NOT (separate, per-binding HMAC
  // mechanism, untouched).
  router.post(
    "/bundles/ingest",
    async (ctx, body) => {
      if (!requireDeployToken(config, ctx)) return;
      const files = requireBundleEnvelope(ctx, body);
      if (!files) return;
      let bundle: Bundle;
      try {
        bundle = await readBundleFromEnvelope(files);
      } catch (err) {
        return sendJson(ctx.res, 400, { error: err instanceof Error ? err.message : "invalid bundle envelope" });
      }
      try {
        const result = await hydrateBundle(config.store, bundle, clock);
        return sendJson(ctx.res, 200, result);
      } catch (err) {
        const message = err instanceof Error ? err.message : "hydration failed";
        return sendJson(ctx.res, bundleErrorStatus(message), { error: message });
      }
    },
    { maxBodyBytes: MAX_BUNDLE_INGEST_BYTES },
  );

  router.post(
    "/bundles/plan",
    async (ctx, body) => {
      if (!requireDeployToken(config, ctx)) return;
      const files = requireBundleEnvelope(ctx, body);
      if (!files) return;
      let bundle: Bundle;
      try {
        bundle = await readBundleFromEnvelope(files);
      } catch (err) {
        return sendJson(ctx.res, 400, { error: err instanceof Error ? err.message : "invalid bundle envelope" });
      }
      try {
        const plan = await planBundleIngest(config.store, bundle);
        return sendJson(ctx.res, 200, plan);
      } catch (err) {
        const message = err instanceof Error ? err.message : "plan failed";
        return sendJson(ctx.res, bundleErrorStatus(message), { error: message });
      }
    },
    { maxBodyBytes: MAX_BUNDLE_INGEST_BYTES },
  );

  // ADR-2: wires the previously-dead registerEnvironment (environments.ts)
  // to a real mutation route — without this there was no legal way to
  // create a production-trust Environment on a server at all (the only
  // caller was aart_deploy_workflow's own auto-vivified, always-empty-config
  // ensureEnvironment, packages/mcp/src/handlers/deployment.ts).
  router.post("/environments", async (ctx, body) => {
    if (!requireDeployToken(config, ctx)) return;
    const { name, trustMode, config: envConfig, secretSource } = body as Partial<RegisterEnvironmentParams>;
    if (!name) return sendJson(ctx.res, 400, { error: "name is required" });
    const environment = await registerEnvironment(config.store, { name, trustMode, config: envConfig, secretSource });
    return sendJson(ctx.res, 200, { environment });
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

  // AMENDMENTS.md A47 — the three remaining dashboard list pages that used
  // to read `store.approvals`/`store.corrections`/`store.evals` directly
  // (the same store-divergence bug class root AMENDMENTS.md A43 fixed for
  // workflow/block detail — SEAMS.md never published a route for these
  // three, "flagged" rather than built, until now).
  router.get("/approvals", async (ctx) => {
    const status = ctx.query.get("status");
    const tasks = await config.store.approvals.list(status ? { status: status as never } : undefined);
    sendJson(ctx.res, 200, { tasks });
  });
  router.get("/corrections", async (ctx) => {
    const runId = ctx.query.get("runId") ?? undefined;
    const stepId = ctx.query.get("stepId") ?? undefined;
    const corrections = await config.store.corrections.list(runId !== undefined || stepId !== undefined ? { runId, stepId } : undefined);
    sendJson(ctx.res, 200, { corrections });
  });
  router.get("/evals", async (ctx) => {
    const [suites, runs] = await Promise.all([config.store.evals.listSuites(), config.store.evals.listRuns()]);
    sendJson(ctx.res, 200, { suites, runs });
  });

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
