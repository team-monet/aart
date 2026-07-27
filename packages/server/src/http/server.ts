// startServer() — the control-plane process (architecture §0.1-0.3):
// "HTTP API server (aart server) with webhook ingress, approval endpoints,
// dashboard-hosting mount point... plus... the scheduler ticker." This
// session's DoD note: "dashboard content itself is S8's scope — S2 just
// needs to expose the mount point/API surface S8 will consume."
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AartStore } from "@aart/store";
import type { ApprovalTask, Scorer, Signal, Trigger, TrustMode, Workflow } from "@aart/types";
import { TrustModeSchema } from "@aart/types";
import { blockPromotion, clearNeedsReview, createEvalExampleFromCorrection, createIssueForAgent, markNeedsReview, recordCorrection, triggerImprovementProposal, unblockPromotion, updateRunOutput, type RecordCorrectionInput } from "@aart/evidence";
import { decideApprovalTask } from "../approvals.js";
import { type Bundle } from "../bundle/bundle.js";
import { hydrateBundle, readBundleFromEnvelope } from "../bundle/load.js";
import { planBundleIngest } from "../bundle/plan.js";
import { systemClock, type Clock } from "../clock.js";
import { DEFAULT_EVENTS_LIMIT, DEFAULT_HTTP_HOST, DEFAULT_HTTP_PORT, MAX_BUNDLE_INGEST_BYTES, MAX_EVENTS_LIMIT, MAX_WEBHOOK_INGEST_BYTES, type ServerConfig } from "../config.js";
import { findCorrectionByKey } from "../corrections.js";
import { checkAnyDeployToken, extractBearerToken } from "../deploy-token.js";
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
import { sendJson, Router, type RegisteredRoute, type RouteContext } from "./router.js";

export interface ServerHandle {
  server: Server;
  port: number;
  ticker?: TickerHandle;
  /**
   * D2a security hardening (AMENDMENTS.md A59) — read-only route-table
   * introspection (`Router.getRoutes()`), exposed here so a completeness
   * test can enumerate every route this server actually registered and
   * assert each POST route explicitly declares its auth stance, without
   * needing a second, parallel way to construct a populated `Router`
   * outside `startServer` itself. Not meant for runtime/production use
   * beyond this — nothing in this codebase calls it outside tests.
   */
  getRoutes(): readonly RegisteredRoute[];
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
 *
 * D2a security hardening, token rotation (AMENDMENTS.md A59) — checks
 * BOTH `config.deployToken` and `config.deployTokenNext` (via
 * `checkAnyDeployToken`, deploy-token.ts), accepting a match against
 * either. `deployTokenNext` unset (the common case) behaves byte-
 * identically to the pre-rotation single-token check. The "unconfigured"
 * remedy below still only names `AART_DEPLOY_TOKEN` — `deployToken` unset
 * means fail-closed regardless of `deployTokenNext` (rotation only ever
 * ADDS a second valid value; it cannot substitute for the primary token
 * being configured at all).
 *
 * D2a fix pass (AMENDMENTS.md A60, FIX 2) — the paragraph above was
 * aspirational, not actually true, until this fix: this function used to
 * fall straight into `checkAnyDeployToken([config.deployToken,
 * config.deployTokenNext], provided)` with no guard, so a caller who
 * supplied EXACTLY `config.deployTokenNext`'s value would authenticate
 * even with `config.deployToken` unset — `deployTokenNext` substituting
 * for the primary after all, contradicting both this comment and the 401
 * remedy below. Now enforced by an explicit early guard: `deployToken`
 * unset refuses unconditionally, matching `requireDeployTokenIfConfigured`'s
 * own `if (!config.deployToken) ...` guard (below), and never even
 * constructs the `[deployToken, deployTokenNext]` candidate list in that
 * case.
 */
function requireDeployToken(config: ServerConfig, ctx: RouteContext): boolean {
  if (!config.deployToken) {
    sendJson(ctx.res, 401, { error: 'Unauthorized. This server has no AART_DEPLOY_TOKEN configured — set it (env var, or the "AART_DEPLOY_TOKEN" key in <root>/secrets.json) before this route will accept any request.' });
    return false;
  }
  const provided = extractBearerToken(ctx.req.headers.authorization);
  if (checkAnyDeployToken([config.deployToken, config.deployTokenNext], provided)) return true;
  sendJson(ctx.res, 401, { error: 'Unauthorized. Provide a valid "Authorization: Bearer <token>" header.' });
  return false;
}

/**
 * D1 fix pass (AMENDMENTS.md A57, trust-boundary ruling); scope widened to
 * (almost) every mutation route by D2a security hardening (AMENDMENTS.md
 * A59, uniform coverage) — the CONDITIONAL sibling of `requireDeployToken`
 * above. Originally built for `POST /workflows/:id/promote` alone:
 * promote is the switch that flips `Deployment.promoted` `false` -> `true`
 * (A56's own push-without-activation story); D1 both tells operators it's
 * reasonable to network-expose `aart server` and created that exact
 * dormancy property, so an UNAUTHENTICATED promote would defeat D1's own
 * guarantee that a pushed bundle stays inert until someone deliberately
 * activates it. A D2a security review found the SAME reasoning applies to
 * every OTHER mutation route this server exposes (trigger a run, decide an
 * approval, record a correction, ...) — all equally network-reachable and
 * equally unauthenticated by design, once `deployToken` existed, the moment
 * an operator follows this codebase's own documented advice to expose
 * `aart server` beyond localhost. This function is now that route's
 * conditional gate too, applied at registration via `RouteOptions.auth` —
 * see `startServer` below for the full route list.
 *
 * Unlike the three routes `requireDeployToken` guards (which have NEVER
 * worked without a token, by design — "not configured yet" is the correct
 * universal refusal for a brand-new surface), every route THIS function
 * guards existed and was open before `deployToken` did — tokenless local/
 * dev/TEST-DRIVE deployments must keep working unmodified. So this does
 * NOT fail closed when unconfigured:
 *   - `config.deployToken` unset -> proceeds exactly as before this route
 *     was gated (`true`), never refuses — see `startServer`'s own one-time
 *     startup warning below for the operator-facing signal instead of a
 *     per-request one.
 *   - configured -> the SAME bearer check `requireDeployToken` uses
 *     (`checkDeployToken`/`extractBearerToken`), reused rather than
 *     reimplemented, just with a route-specific 401 remedy — "set
 *     AART_DEPLOY_TOKEN" would be the WRONG instruction here, since a
 *     token already IS configured and simply wasn't supplied or matched.
 *
 * `actionLabel` (D2a) — the 401 remedy's own trailing clause ("...requires
 * it to <actionLabel>"), so a route's refusal can still name what it
 * specifically gates (e.g. promote's own call site passes "promote a
 * workflow version", preserving A57's exact original wording byte-for-
 * byte) rather than every one of the ~17 call sites sharing a single
 * hardcoded phrase that was only ever true for promote. Defaults to a
 * route-neutral phrase for call sites that don't need anything more
 * specific.
 *
 * A distinct helper (not a parameter/flag on `requireDeployToken` itself)
 * so the fail-closed (deploy-surface routes) vs conditional (everything
 * else) semantics stay explicit in the code, not hidden behind a boolean.
 *
 * D2b "remote reads" (AMENDMENTS.md, this session, John-ratified
 * 2026-07-12) — this function now ALSO gates two GET routes (`GET /runs`,
 * `GET /runs/:id`, below), not only POST/mutation routes as every doc
 * comment above this point still frames it. Same conditional semantics,
 * same reused mechanism — a run's full trace/inputs/outputs is exactly the
 * kind of content D2b makes newly reachable to a REMOTE authoring agent
 * (the new `aart_remote_run` MCP tool, `@aart/mcp`), so it gets the same
 * "gated once a token is configured, open otherwise" treatment every other
 * conditionally-sensitive route already has — see those two routes' own
 * registration comment (below, "Read surface") for the full rationale.
 *
 * D2b/V1 fix pass (AMENDMENTS.md A63, FIX 1, John-ratified 2026-07-12) —
 * widened again, from two gated GET routes to three: `GET /flagged-runs`
 * (below) returns the SAME full `RunRecord[]` shape (trace/inputs/outputs)
 * `GET /runs` does, just pre-filtered to failed+unresolved-flag runs —
 * leaving it open after `GET /runs`/`GET /runs/:id` were gated defeated the
 * gate's own purpose (an unauthenticated caller could still read every
 * reclaim-exhausted/poison run's full trace through this one route alone).
 * `GET /waiting-runs` was evaluated too and deliberately left OPEN:
 * `WaitStore.list()` (`@aart/store`) returns only wait-condition metadata
 * (`{runId, stepId, wait, createdAt}`) — `WaitCondition`'s own 7-member
 * union (`@aart/types`' `wait.ts`) never carries trace/inputs/outputs, so
 * there is no secret-adjacent content on that route for this gate to
 * protect.

 * Token-derived attribution (D2a, AMENDMENTS.md A59, "mechanical half" —
 * named per-token labels are deferred) — on success via a PROVIDED,
 * MATCHING token (never the "unconfigured, proceed" branch, which has no
 * caller identity to attribute anything to), stamps `ctx.authenticated =
 * { label: "deploy-token" }` before returning `true`. Hardcoded rather than
 * a configurable `ServerConfig.deployTokenLabel` — flagged explicitly as a
 * deliberate scope decision, not an oversight: with exactly one shared
 * token (plus, since D2a, one rotation successor — see `checkAnyDeployToken`
 * — neither individually NAMED), a single fixed label is all "attribution"
 * can honestly mean today; a per-token label would need per-token
 * identities to attach it to, which is what "named tokens" (out of scope
 * here) would actually add. `requireDeployToken` (the fail-closed sibling)
 * deliberately does NOT set this — none of its three routes consume
 * `ctx.authenticated` today, and stamping it there with no reader would be
 * unused surface, not a real capability.
 */
function requireDeployTokenIfConfigured(config: ServerConfig, ctx: RouteContext, actionLabel = "perform this action"): boolean {
  if (!config.deployToken) return true;
  const provided = extractBearerToken(ctx.req.headers.authorization);
  // D2a security hardening, token rotation (AMENDMENTS.md A59) — accepts
  // EITHER the primary or the rotation-successor token (checkAnyDeployToken,
  // deploy-token.ts); deployTokenNext unset is byte-identical to the
  // pre-rotation single-token check.
  if (checkAnyDeployToken([config.deployToken, config.deployTokenNext], provided)) {
    ctx.authenticated = { label: "deploy-token" };
    return true;
  }
  sendJson(ctx.res, 401, { error: `Unauthorized. Provide a valid "Authorization: Bearer <token>" header — this server has AART_DEPLOY_TOKEN configured and requires it to ${actionLabel}.` });
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
 * D1 fix pass (AMENDMENTS.md A57) — `POST /environments`'s `trustMode` was
 * cast (`body as Partial<RegisterEnvironmentParams>`) and passed straight
 * into `registerEnvironment` with no runtime check at all. A malformed/
 * typo'd value (e.g. `"prod"` instead of `"production"`) would silently
 * persist as-is into `Environment.config.trustMode`, and every REAL reader
 * of that field (`requiredGatesForEnvironment`, promotion.ts;
 * `normalizeEnvironmentTrustMode`, `@aart/governance`'s `capability.ts`)
 * maps an unrecognized string to `"governed"` — a SILENT governance
 * downgrade an operator would have no way to notice from this route's own
 * `200` response, which echoes back exactly the bad string it was given
 * (`server.test.ts`'s own upsert test already proves `config["trustMode"]`
 * round-trips VERBATIM, typo and all). Mirrors the CLI sibling's own check
 * (`commands/environment.ts`'s `isValidTrustMode`/`VALID_TRUST_MODES`)
 * rather than inventing a new validation layer — this route's own siblings
 * in this file (`requireBundleEnvelope` above) validate with a plain
 * runtime check + a 400, not a Zod schema, so this does too; only the
 * VALID-VALUES VOCABULARY is sourced from `@aart/types`' `TrustModeSchema`
 * (the single canonical definition already used to derive `TrustMode`
 * itself) rather than a third hand-typed copy of the same four strings —
 * `normalizeEnvironmentTrustMode`'s own doc comment already flags
 * hand-rolling this vocabulary twice as the exact cause of a past bug
 * (root AMENDMENTS.md A42). Writes the 400 response itself; returns `false`
 * when the caller must stop. `trustMode` omitted entirely is untouched —
 * `registerEnvironment`'s own optional-field contract is unchanged.
 */
const VALID_TRUST_MODES = TrustModeSchema.options;

function requireValidTrustMode(ctx: RouteContext, trustMode: unknown): boolean {
  if (trustMode === undefined) return true;
  if (typeof trustMode === "string" && (VALID_TRUST_MODES as readonly string[]).includes(trustMode)) return true;
  sendJson(ctx.res, 400, { error: `trustMode must be one of: ${VALID_TRUST_MODES.join(", ")} (got ${JSON.stringify(trustMode)}).` });
  return false;
}

/**
 * D2b/V1 fix pass (AMENDMENTS.md A63, FIX 3) — `GET /events`'s own
 * `?limit=` parsing, extracted so its edge cases are independently testable
 * rather than inlined into the route closure. Pre-this-fix this route used
 * `Number.isFinite(Number(limitParam))`, which admits NEGATIVE and
 * FRACTIONAL values through untouched (`Number("-5")` and `Number("1.5")`
 * are both finite) — and had no default/max at all, so an absent `limit`
 * meant "serialize the entire append-only log," unauthenticated (this route
 * is deliberately open — see its own registration comment above). Every
 * malformed case below (missing, non-integer, negative) is treated
 * identically: fall back to `DEFAULT_EVENTS_LIMIT`, the same "ignore, don't
 * 400" looseness this route family's other query params already have
 * (`status`/`workflowId`'s own `?? undefined` idiom) — a 400 on a stray
 * query value felt too strict for a metadata read endpoint the dashboard
 * polls. A valid non-negative integer is honored up to `MAX_EVENTS_LIMIT`
 * (including `0`, an explicit "give me zero events" — distinct from
 * "absent," which means "give me the default page"). Adapters get their
 * OWN independent negative-limit guard too (fs's `events.ts`/sqlite's
 * `stores/events.ts`) — belt-and-braces for any caller of
 * `EventLogStore.list` other than this route (this codebase's own store
 * layer is never assumed to be reachable only through one HTTP route).
 */
function parseEventsLimit(raw: string | null): number {
  if (raw === null) return DEFAULT_EVENTS_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return DEFAULT_EVENTS_LIMIT;
  return Math.min(n, MAX_EVENTS_LIMIT);
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

  // D1 fix pass (AMENDMENTS.md A57); reworded for D2a's uniform-coverage
  // scope widening (AMENDMENTS.md A59) — requireDeployTokenIfConfigured's
  // own conditional (not fail-closed) semantics mean an unconfigured
  // deployToken has no per-request refusal to make the exposure visible the
  // way requireDeployToken's 401 does for the three fail-closed routes. One
  // loud warning at startup instead of a per-request log line (which would
  // spam this at up to one entry per gated call, every process lifetime) —
  // surfaced once, here, so an operator scanning startup logs sees it
  // regardless of whether they ever trip the condition in a request. Scope
  // note: this used to name `POST /workflows/:id/promote` alone (the only
  // route this conditional gate covered pre-D2a) — D2a widened
  // requireDeployTokenIfConfigured to nearly every mutation route this
  // server exposes, so the warning now describes that scope generically
  // rather than re-listing ~17 routes inline; DEPLOY.md's gating matrix is
  // the canonical full list.
  if (!config.deployToken) {
    logger.warn(
      "Every mutation route on this server EXCEPT POST /bundles/ingest, POST /bundles/plan, POST /environments (fail-closed regardless) and the three /webhooks/* endpoints (separate per-binding HMAC verification) is UNAUTHENTICATED — no AART_DEPLOY_TOKEN configured. Any caller that can reach this server's HTTP API can trigger runs, decide approvals, promote or otherwise modify workflow/governance state, and more. Set AART_DEPLOY_TOKEN to require a bearer token on these routes (D2a security hardening, AMENDMENTS.md A59) — see DEPLOY.md's gating matrix for the full route list.",
    );
  }

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
  }, { maxBodyBytes: MAX_WEBHOOK_INGEST_BYTES });

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
  }, { maxBodyBytes: MAX_WEBHOOK_INGEST_BYTES });

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
  }, { maxBodyBytes: MAX_WEBHOOK_INGEST_BYTES });

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
  // D2a security hardening (AMENDMENTS.md A59) — conditionally gated
  // (requireDeployTokenIfConfigured): see that function's own doc comment
  // for the full trust-boundary rationale, now applied uniformly across
  // this file's mutation routes rather than to promote alone.
  router.post(
    "/approvals/:id/decision",
    async (ctx, body) => {
      const decision = body as { status: ApprovalTask["status"]; reviewer: string; decision?: unknown; trustMode?: TrustMode };
      // D2a token-derived attribution (AMENDMENTS.md A59) — built as an
      // explicit allowlist, NOT `{ ...decision, authenticatedAs: ... }`:
      // spreading the client-supplied body first would let a caller inject
      // its own `authenticatedAs` value that this line's own assignment
      // then only wins over by KEY-ORDERING luck (the exact object-literal
      // spread-ordering vulnerability class A57's own FIX 6 closed
      // elsewhere in this codebase, `deployment.ts`) — authenticatedAs must
      // ALWAYS come from the server's own auth check, never from the body.
      const input: typeof decision & { authenticatedAs?: string } = {
        status: decision.status,
        reviewer: decision.reviewer,
        decision: decision.decision,
        trustMode: decision.trustMode,
        authenticatedAs: ctx.authenticated?.label,
      };
      const result = await decideApprovalTask(config.store, config.engine, ctx.params["id"]!, input, clock);
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
    },
    { auth: (ctx) => requireDeployTokenIfConfigured(config, ctx, "decide an approval task") },
  );

  router.post(
    "/runs/:runId/resume",
    async (ctx, body) => {
      const { stepId, payload } = body as { stepId: string; payload?: unknown };
      if (!stepId) return sendJson(ctx.res, 400, { error: "stepId is required" });
      const result = await config.engine.resumeDirect(ctx.params["runId"]!, stepId, payload);
      return sendJson(ctx.res, 200, result);
    },
    { auth: (ctx) => requireDeployTokenIfConfigured(config, ctx, "resume a run") },
  );

  router.post(
    "/runs/:runId/signal",
    async (ctx, body) => {
      const { name, correlationId, payload } = body as { name: string; correlationId: string; payload?: unknown };
      if (!name || !correlationId) return sendJson(ctx.res, 400, { error: "name and correlationId are required" });
      const signal: Signal = { id: generateId("sig"), name, correlationId, payload, receivedAt: clock.nowIso() };
      await config.store.signals.append(signal);
      const result = await config.engine.resumeWithSignal(signal);
      return sendJson(ctx.res, 200, result);
    },
    { auth: (ctx) => requireDeployTokenIfConfigured(config, ctx, "send a signal") },
  );

  // The flagged-run clear action (architecture §4.1/§4.7/§6.2/§13.3) — this
  // HTTP route IS the "dashboard/CLI only, not MCP" surface: no MCP tool
  // anywhere in this codebase calls it, and none should.
  router.post(
    "/runs/:runId/flag/clear",
    async (ctx, body) => {
      const { clearedBy } = body as { clearedBy?: string };
      if (!clearedBy) return sendJson(ctx.res, 400, { error: "clearedBy is required" });
      const result = await clearRunFlag(config.store, ctx.params["runId"]!, clearedBy, clock);
      const status = result.kind === "cleared" ? 200 : result.kind === "not_found" ? 404 : 409;
      return sendJson(ctx.res, status, result);
    },
    { auth: (ctx) => requireDeployTokenIfConfigured(config, ctx, "clear a run's flag") },
  );

  // AMENDMENTS.md A47 — every dashboard write action below now has a real
  // server-side implementation, closing the store-divergence bug class
  // (root AMENDMENTS.md A43) for writes the same way A43/this session
  // closed it for reads: the dashboard's ONLY connection to data is this
  // HTTP API, so a misconfigured/absent local store can no longer produce
  // silently-wrong behavior for ANY dashboard action, not just page reads.

  // "Trigger workflow" (§35.2) — via the REAL EngineBoundary.startRun
  // (`engine/boundary.ts`), the SAME real `Engine.triggerRun` a webhook/CLI
  // trigger uses; not a dashboard-local RunRecord-construction stub.
  router.post(
    "/runs/trigger",
    async (ctx, body) => {
      const { workflowId, workflowVersion, inputs, environment } = body as { workflowId?: string; workflowVersion?: string; inputs?: Record<string, unknown>; environment?: string };
      if (!workflowId) return sendJson(ctx.res, 400, { error: "workflowId is required" });
      const trigger: Trigger = { type: "manual", id: generateId("trig"), source: "dashboard", payload: {}, receivedAt: clock.nowIso() };
      const result = await config.engine.startRun({ workflowId, workflowVersion, trigger, mappedInputs: inputs ?? {}, environment });
      if (result.kind === "rejected") return sendJson(ctx.res, 409, { error: result.reason });
      const run = await config.store.runs.get(result.runId);
      return sendJson(ctx.res, 200, { kind: result.kind, run });
    },
    { auth: (ctx) => requireDeployTokenIfConfigured(config, ctx, "trigger a run") },
  );

  router.post(
    "/workflows/:id/approve",
    async (ctx, body) => {
      const { version, action, trustMode } = body as { version?: string; action?: "approve" | "deprecate"; trustMode?: TrustMode };
      if (!version) return sendJson(ctx.res, 400, { error: "version is required" });
      // D2a fix (AMENDMENTS.md A59) — this route cast `trustMode` with no
      // runtime check, the SAME bug shape D1's fix pass (AMENDMENTS.md A57,
      // FIX 2) closed for POST /environments: a typo'd value (e.g. "prod")
      // would silently persist into computeApprovalState's REQUIRED_GATES_BY_MODE
      // lookup, which maps an unrecognized string to "governed" with no
      // signal anywhere. requireValidTrustMode (this file, above) is the
      // same helper /environments already uses.
      if (!requireValidTrustMode(ctx, trustMode)) return;
      const resolvedAction = action === "deprecate" ? "deprecate" : "approve";
      const result = await approveOrDeprecateWorkflow(config.store, ctx.params["id"]!, version, resolvedAction, trustMode ?? "governed");
      if (result.kind === "not_found") return sendJson(ctx.res, 404, { error: "not found" });
      // D2a token-derived attribution, log-only half (AMENDMENTS.md A59) —
      // approveOrDeprecateWorkflow has no actor param today and its
      // persisted shape isn't extended by this change (see this route's own
      // PART 5(b) scope note); logging who authenticated this decision is
      // the mechanism available without changing that function's signature.
      logger.info("workflow version approve/deprecate decided", { workflowId: ctx.params["id"]!, version, action: resolvedAction, authenticatedAs: ctx.authenticated?.label });
      return sendJson(ctx.res, 200, { workflow: result.workflow });
    },
    { auth: (ctx) => requireDeployTokenIfConfigured(config, ctx, "approve or deprecate a workflow version") },
  );

  // D1 fix pass (AMENDMENTS.md A57) — conditionally gated: see
  // requireDeployTokenIfConfigured's own doc comment for the full
  // trust-boundary rationale (promote is the switch that activates a
  // pushed-but-dormant Deployment). D2a (AMENDMENTS.md A59): migrated from
  // an inline `if (!requireDeployTokenIfConfigured(...)) return;` first line
  // to the `auth` route option — same check, now runs before body-read too
  // (this route's own body is trivial, so the ordering fix is mostly
  // symbolic here, but it keeps every gated route on the one mechanism).
  router.post(
    "/workflows/:id/promote",
    async (ctx, body) => {
      const { version, environmentId, triggerConfig } = body as { version?: string; environmentId?: string; triggerConfig?: Record<string, unknown> };
      if (!version || !environmentId) return sendJson(ctx.res, 400, { error: "version and environmentId are required" });
      const result = await promoteWorkflowVersionToEnvironment(config.store, { workflowId: ctx.params["id"]!, workflowVersion: version, environmentId, triggerConfig }, clock);
      return sendJson(ctx.res, 200, result);
    },
    { auth: (ctx) => requireDeployTokenIfConfigured(config, ctx, "promote a workflow version") },
  );

  router.post(
    "/workflows/:id/block-promotion",
    async (ctx, body) => {
      const { version } = body as { version?: string };
      if (!version) return sendJson(ctx.res, 400, { error: "version is required" });
      await respondWorkflowFlagAction(ctx.res, blockPromotion, config.store, ctx.params["id"]!, version);
    },
    { auth: (ctx) => requireDeployTokenIfConfigured(config, ctx, "block a workflow version's promotion") },
  );
  router.post(
    "/workflows/:id/unblock-promotion",
    async (ctx, body) => {
      const { version } = body as { version?: string };
      if (!version) return sendJson(ctx.res, 400, { error: "version is required" });
      await respondWorkflowFlagAction(ctx.res, unblockPromotion, config.store, ctx.params["id"]!, version);
    },
    { auth: (ctx) => requireDeployTokenIfConfigured(config, ctx, "unblock a workflow version's promotion") },
  );
  router.post(
    "/workflows/:id/mark-needs-review",
    async (ctx, body) => {
      const { version } = body as { version?: string };
      if (!version) return sendJson(ctx.res, 400, { error: "version is required" });
      await respondWorkflowFlagAction(ctx.res, markNeedsReview, config.store, ctx.params["id"]!, version);
    },
    { auth: (ctx) => requireDeployTokenIfConfigured(config, ctx, "mark a workflow version as needing review") },
  );
  router.post(
    "/workflows/:id/clear-needs-review",
    async (ctx, body) => {
      const { version } = body as { version?: string };
      if (!version) return sendJson(ctx.res, 400, { error: "version is required" });
      await respondWorkflowFlagAction(ctx.res, clearNeedsReview, config.store, ctx.params["id"]!, version);
    },
    { auth: (ctx) => requireDeployTokenIfConfigured(config, ctx, "clear a workflow version's needs-review flag") },
  );
  router.post(
    "/workflows/:id/trigger-improvement",
    async (ctx, body) => {
      const { version } = body as { version?: string };
      if (!version) return sendJson(ctx.res, 400, { error: "version is required" });
      const brief = await triggerImprovementProposal(config.store, ctx.params["id"]!, version);
      return sendJson(ctx.res, 200, brief);
    },
    { auth: (ctx) => requireDeployTokenIfConfigured(config, ctx, "trigger an improvement proposal") },
  );

  router.post(
    "/corrections",
    async (ctx, body) => {
      const input = body as Partial<RecordCorrectionInput>;
      if (!input.runId || !input.stepId || !input.fieldPath || !input.reason || !input.reviewer) {
        return sendJson(ctx.res, 400, { error: "runId, stepId, fieldPath, reason, and reviewer are required" });
      }
      const correction = await recordCorrection(config.store, input as RecordCorrectionInput);
      return sendJson(ctx.res, 200, { correction });
    },
    { auth: (ctx) => requireDeployTokenIfConfigured(config, ctx, "record a correction") },
  );
  router.post(
    "/corrections/:key/update-run-output",
    async (ctx) => {
      const correction = await findCorrectionByKey(config.store, ctx.params["key"]!);
      if (!correction) return sendJson(ctx.res, 404, { error: "not found" });
      try {
        const run = await updateRunOutput(config.store, correction);
        return sendJson(ctx.res, 200, { run });
      } catch (err) {
        return sendJson(ctx.res, 404, { error: err instanceof Error ? err.message : "not found" });
      }
    },
    { auth: (ctx) => requireDeployTokenIfConfigured(config, ctx, "apply a correction to a run's output") },
  );
  router.post(
    "/corrections/:key/create-eval-example",
    async (ctx, body) => {
      const correction = await findCorrectionByKey(config.store, ctx.params["key"]!);
      if (!correction) return sendJson(ctx.res, 404, { error: "not found" });
      const { suiteId } = body as { suiteId?: string };
      if (!suiteId) return sendJson(ctx.res, 400, { error: "suiteId is required" });
      const example = await createEvalExampleFromCorrection(config.store, correction, suiteId);
      return sendJson(ctx.res, 200, { example });
    },
    { auth: (ctx) => requireDeployTokenIfConfigured(config, ctx, "create an eval example from a correction") },
  );
  router.post(
    "/corrections/:key/create-issue",
    async (ctx) => {
      const correction = await findCorrectionByKey(config.store, ctx.params["key"]!);
      if (!correction) return sendJson(ctx.res, 404, { error: "not found" });
      try {
        const brief = await createIssueForAgent(config.store, correction);
        return sendJson(ctx.res, 200, brief);
      } catch (err) {
        return sendJson(ctx.res, 404, { error: err instanceof Error ? err.message : "not found" });
      }
    },
    { auth: (ctx) => requireDeployTokenIfConfigured(config, ctx, "create an issue from a correction") },
  );

  router.post(
    "/evals/suites",
    async (ctx, body) => {
      const { name, description, scorer } = body as { name?: string; description?: string; scorer?: Scorer };
      if (!name || !scorer) return sendJson(ctx.res, 400, { error: "name and scorer are required" });
      const suite = await createEvalSuite(config.store, { name, description, scorer });
      return sendJson(ctx.res, 200, { suite });
    },
    { auth: (ctx) => requireDeployTokenIfConfigured(config, ctx, "create an eval suite") },
  );
  router.post(
    "/evals/runs",
    async (ctx, body) => {
      const { suiteId, workflowId, workflowVersion } = body as { suiteId?: string; workflowId?: string; workflowVersion?: string };
      if (!suiteId || !workflowId) return sendJson(ctx.res, 400, { error: "suiteId and workflowId are required" });
      const result = await runEvalSuiteForWorkflow(config.store, suiteId, workflowId, workflowVersion);
      if (result.kind === "suite_not_found") return sendJson(ctx.res, 404, { error: `eval suite not found: ${suiteId}` });
      if (result.kind === "workflow_not_found") return sendJson(ctx.res, 404, { error: `workflow not found: ${workflowId}${workflowVersion ? `@${workflowVersion}` : ""}` });
      return sendJson(ctx.res, 200, { evalRun: result.evalRun, results: result.results });
    },
    { auth: (ctx) => requireDeployTokenIfConfigured(config, ctx, "run an eval suite") },
  );

  // Deploy surface — D1 "remotes + push" (AMENDMENTS.md A56). `aart push`
  // (and the MCP `aart_deploy` tool) POST a bundle envelope here instead of
  // `scp`+bare-process re-hydrate; `POST /bundles/plan` is the same envelope
  // run through a zero-write dry-run preview first. Both, plus `POST
  // /environments` below (ADR-2), are gated by `requireDeployToken` — the
  // three `/webhooks/*` routes above are NOT (separate, per-binding HMAC
  // mechanism, untouched). D2a (AMENDMENTS.md A59): migrated from an inline
  // `if (!requireDeployToken(...)) return;` first line to the `auth` route
  // option — same fail-closed check, now genuinely runs BEFORE readBody
  // (previously these three routes' own inline check ran AFTER the router
  // had already buffered the full request body — an unauthenticated caller
  // could force up to MAX_BUNDLE_INGEST_BYTES of buffering before ever
  // being refused; `auth` closes that gap for these routes too, not just
  // the newly-gated ones).
  router.post(
    "/bundles/ingest",
    async (ctx, body) => {
      const files = requireBundleEnvelope(ctx, body);
      if (!files) return;
      let bundle: Bundle;
      try {
        bundle = await readBundleFromEnvelope(files);
      } catch (err) {
        return sendJson(ctx.res, 400, { error: err instanceof Error ? err.message : "invalid bundle envelope" });
      }
      try {
        const result = await hydrateBundle(config.store, bundle, clock, config.packRoot);
        return sendJson(ctx.res, 200, result);
      } catch (err) {
        const message = err instanceof Error ? err.message : "hydration failed";
        return sendJson(ctx.res, bundleErrorStatus(message), { error: message });
      }
    },
    { auth: (ctx) => requireDeployToken(config, ctx), maxBodyBytes: MAX_BUNDLE_INGEST_BYTES },
  );

  router.post(
    "/bundles/plan",
    async (ctx, body) => {
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
    { auth: (ctx) => requireDeployToken(config, ctx), maxBodyBytes: MAX_BUNDLE_INGEST_BYTES },
  );

  // ADR-2: wires the previously-dead registerEnvironment (environments.ts)
  // to a real mutation route — without this there was no legal way to
  // create a production-trust Environment on a server at all (the only
  // caller was aart_deploy_workflow's own auto-vivified, always-empty-config
  // ensureEnvironment, packages/mcp/src/handlers/deployment.ts). D2a
  // (AMENDMENTS.md A59): migrated to the `auth` route option, same reasoning
  // as the two bundle routes above.
  router.post(
    "/environments",
    async (ctx, body) => {
      const { name, trustMode, config: envConfig, secretSource } = body as Partial<RegisterEnvironmentParams>;
      if (!name) return sendJson(ctx.res, 400, { error: "name is required" });
      if (!requireValidTrustMode(ctx, trustMode)) return;
      const environment = await registerEnvironment(config.store, { name, trustMode, config: envConfig, secretSource });
      return sendJson(ctx.res, 200, { environment });
    },
    { auth: (ctx) => requireDeployToken(config, ctx) },
  );

  // Read surface — the "API surface S8 will consume" (this session's DoD note).
  router.get("/health", (ctx) => sendJson(ctx.res, 200, { status: "ok" }));
  // D2b "remote reads" (AMENDMENTS.md, this session, John-ratified
  // 2026-07-12's "gate the run-read routes" fork; widened by the D2b/V1 fix
  // pass, AMENDMENTS.md A63 FIX 1) — GET /runs, GET /runs/:id, and GET
  // /flagged-runs are now the ONLY three GET routes on this server that
  // carry an `auth` option; every other GET route (workflows, deployments,
  // environments, approvals, waiting-runs, ...) stays deliberately open,
  // per this session's own narrow mandate. Reusing `requireDeployTokenIfConfigured`
  // (this file, above) rather than a new mechanism — the SAME conditional
  // semantics every other gated route already has: unconfigured
  // `AART_DEPLOY_TOKEN` -> stays open (unchanged pre-D2b behavior, a
  // tokenless local/dev/TEST-DRIVE deployment needs zero config change);
  // configured -> requires the same valid Bearer the rest of the
  // conditionally-gated tier does. Why THESE specifically, now that D2b
  // makes a run's full trace/inputs/outputs agent-discoverable from a
  // REMOTE caller too (the new aart_remote_run tool, @aart/mcp) — a run's
  // trace can carry residual secret-adjacent content (tool call arguments,
  // external-call metadata, ...) that was previously only reachable by
  // someone who could already read this server's local disk or was
  // deliberately handed a report; D2b's whole point is making that content
  // reachable to an AUTHORING AGENT over the network, which raises the bar
  // on "who can read it" the same way D2a's own uniform write-gating raised
  // it for mutation. `Router.handle`'s own `auth` closure runs before
  // `readBody` regardless of HTTP method (router.ts) — a GET carrying an
  // `Authorization` header works the identical way a gated POST already
  // does; `fetchFromRemote` (@aart/mcp's remote-client.ts) already attaches
  // a resolved token on EVERY call it makes, GET included, so
  // aart_remote_runs/aart_remote_run keep working against a gated server
  // with zero changes on their own side. GET /flagged-runs joined this tier
  // one fix pass later than the other two (AMENDMENTS.md A63 FIX 1) — see
  // that route's own registration comment below for why it was missed the
  // first time and why GET /waiting-runs, right next to it, was NOT gated.
  router.get(
    "/runs",
    async (ctx) => {
      const status = ctx.query.get("status");
      const workflowId = ctx.query.get("workflowId");
      const runs = await config.store.runs.list({
        status: (status as never) ?? undefined,
        workflowId: workflowId ?? undefined,
      });
      sendJson(ctx.res, 200, { runs });
    },
    { auth: (ctx) => requireDeployTokenIfConfigured(config, ctx, "read run data") },
  );
  router.get(
    "/runs/:id",
    async (ctx) => {
      const run = await config.store.runs.get(ctx.params["id"]!);
      if (!run) return sendJson(ctx.res, 404, { error: "not found" });
      sendJson(ctx.res, 200, { run });
    },
    { auth: (ctx) => requireDeployTokenIfConfigured(config, ctx, "read run data") },
  );
  // AMENDMENTS.md A63 FIX 1 — evaluated for the SAME gating GET /runs, GET
  // /runs/:id, and GET /flagged-runs (below) carry, and deliberately LEFT
  // OPEN: WaitStore.list()'s own return shape (types.ts) is
  // `{runId, stepId, wait, createdAt}[]` — WaitCondition's 7-member union
  // (@aart/types' wait.ts) never carries trace/inputs/outputs, so there is
  // no secret-adjacent content here for this gate to protect.
  router.get("/waiting-runs", async (ctx) => sendJson(ctx.res, 200, { waits: await config.store.waits.list() }));
  // AMENDMENTS.md A63 FIX 1 — gated, joining GET /runs/GET /runs/:id above
  // (this session's own MAJOR verification finding): listFlaggedRuns
  // (flags.ts) returns the SAME full RunRecord[] shape (trace/inputs/
  // outputs) GET /runs does, just pre-filtered server-side to
  // failed+unresolved-flag runs. Left open (as it originally shipped), this
  // one route let an unauthenticated caller read the full trace of every
  // reclaim-exhausted/poison run regardless of the other two routes being
  // gated — defeating the gate's own purpose. Same conditional mechanism,
  // same "read run data" remedy wording, as its two siblings above.
  router.get(
    "/flagged-runs",
    async (ctx) => sendJson(ctx.res, 200, { runs: await listFlaggedRuns(config.store) }),
    { auth: (ctx) => requireDeployTokenIfConfigured(config, ctx, "read run data") },
  );
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
  // V1 event log foundation (AMENDMENTS.md A61) — the activity-feed +
  // live-updates spine. Open, unauthenticated read (the default open-GET
  // posture every OTHER GET route on this surface already follows — no
  // `auth` option here, matching /deployments/ /approvals/ etc. above;
  // D2b/A63's own auth gating targets /runs, /runs/:id, and /flagged-runs —
  // different routes). Deliberately NOT gated (D2b/V1 fix pass,
  // AMENDMENTS.md A63 FIX 2 — evaluated explicitly, not just left off by
  // omission): an EventLogEntry (@aart/types' event-log.ts) carries only
  // run-lifecycle METADATA — id/type/occurredAt/summary plus correlation
  // ids (workflowId/runId/deploymentId/...) — never a step's trace/inputs/
  // outputs, so it sits in the same open-always sensitivity tier as
  // /deployments, not the gated tier /runs/GET /runs/:id/GET /flagged-runs
  // occupy. Stateless, decoupled from the ticker — a plain store read.
  router.get("/events", async (ctx) => {
    const since = ctx.query.get("since") ?? undefined;
    const limit = parseEventsLimit(ctx.query.get("limit"));
    const events = await config.store.events.list({ since, limit });
    sendJson(ctx.res, 200, { events });
  });

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
  // D2a security hardening, breaking-change bind default (AMENDMENTS.md
  // A59, John-ratified 2026-07-12) — was `server.listen(port, cb)` (no host
  // -> Node's own default, every interface). See DEFAULT_HTTP_HOST's own
  // doc comment (config.ts) for the full rationale and DEPLOY.md's
  // "Network binding" section for the operator-facing migration note.
  const host = config.host ?? DEFAULT_HTTP_HOST;
  const boundPort = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : port);
    });
  });
  // D2a fix pass (AMENDMENTS.md A60, FIX 3) — the bind itself was
  // mechanically silent until this fix: nothing logged whether this process
  // bound loopback-only or every interface, so an operator could only
  // discover a host mismatch via a later failed remote connection, not at
  // the moment it actually mattered — a real gap given A59's own
  // breaking-change loopback-default bind. One line, AFTER server.listen's
  // callback has genuinely fired (boundPort only resolves once it has), via
  // the same wired logger every other line in this function already uses.
  logger.info("aart server listening", { host, port: boundPort });

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
    getRoutes: () => router.getRoutes(),
    close: async () => {
      ticker?.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
