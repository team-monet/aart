// Deployment/runtime handlers — aart_deploy_workflow, aart_trigger_workflow,
// aart_list_waiting_runs, aart_resume_run.
//
// Resolved gap (documented here + final report/AMENDMENTS): nothing in this
// session's scope (or any sibling's documented seam) provides an
// environment-CRUD surface, yet `aart_deploy_workflow`/`aart deploy
// --target <target>` need a real `Environment` record to deploy INTO, and
// architecture §10.1's progressive-disclosure note ("register only once at
// least one Environment record exists") presumes something creates one.
// `ensureEnvironment` below auto-vivifies a minimal `Environment` (empty
// config) by name on first deploy, rather than leaving deploy unusable in a
// fresh project until some other session's environment-authoring surface
// exists. Per-environment required gates reuse `requiredGatesByMode` (this
// session's own mirror of governance's mode->gates table) — ADR-07 leaves a
// genuinely per-environment (as opposed to per-mode) policy unspecified
// anywhere in either source document, so this is the simplest defensible
// reading available, not a guess at a richer policy neither doc describes.
import type { Deployment, Environment } from "@aart/types";
import type { AartContext } from "../context.js";
import { describeUnreachableRemote, fetchFromRemote, isRecord, remoteErrorMessage, remoteNotFoundError } from "../remote-client.js";
import type { HandlerResult } from "../response.js";
import { newId } from "../stubs/engine.js";
import { runWorkflowHandler } from "./execution.js";

async function ensureEnvironment(ctx: AartContext, name: string): Promise<Environment> {
  const existing = await ctx.store.environments.getByName(name);
  if (existing) return existing;
  const env: Environment = { id: newId("env"), name, config: {} };
  await ctx.store.environments.put(env);
  return env;
}

export interface DeployWorkflowInput {
  workflowId: string;
  workflowVersion: string;
  target: string;
}

export async function deployWorkflowHandler(ctx: AartContext, input: DeployWorkflowInput): Promise<HandlerResult> {
  const workflow = await ctx.store.workflows.get(input.workflowId, input.workflowVersion);
  if (!workflow) return { ok: false, error: `Workflow ${input.workflowId}@${input.workflowVersion} not found.` };

  const environment = await ensureEnvironment(ctx, input.target);
  const requiredGatesForEnvironment = ctx.governance.requiredGatesByMode[ctx.trustMode];
  const evaluation = ctx.governance.evaluatePromotionForEnvironment({
    workflow: { promotionBlocked: workflow.promotionBlocked },
    globalApproval: workflow.approval,
    gates: workflow.gates,
    requiredGatesForEnvironment,
    environment: environment.name,
  });

  if (evaluation.blocked) {
    return { ok: false, error: `Deployment refused: ${evaluation.reason} for ${input.workflowId}@${input.workflowVersion}.`, reason: evaluation.reason };
  }
  if (!evaluation.record.promoted) {
    return {
      ok: false,
      error: `Deployment refused: required gates unmet for environment "${environment.name}".`,
      unmetGates: evaluation.record.unmetGates,
    };
  }

  const deployment: Deployment = {
    id: newId("deploy"),
    workflowId: input.workflowId,
    workflowVersion: input.workflowVersion,
    environmentId: environment.id,
    triggerConfig: {},
    createdAt: ctx.now().toISOString(),
  };
  await ctx.store.deployments.put(deployment);
  return { ok: true, deployment, environment };
}

export interface TriggerWorkflowInput {
  workflowId: string;
  input?: Record<string, unknown>;
  signal?: { name: string; correlationId: string; payload?: unknown };
}

export async function triggerWorkflowHandler(ctx: AartContext, input: TriggerWorkflowInput): Promise<HandlerResult> {
  if (input.signal) {
    const outcome = await ctx.engine.resumeBySignal(input.signal);
    return { ok: outcome.kind === "resumed", kind: "signal", outcome };
  }

  const deployments = await ctx.store.deployments.list({ workflowId: input.workflowId });
  if (deployments.length === 0) {
    return { ok: false, error: `Workflow "${input.workflowId}" is not deployed anywhere. Call aart_deploy_workflow first.` };
  }
  // D1 fix pass (AMENDMENTS.md A57) — a promoted:false Deployment (D1,
  // AMENDMENTS.md A56: evidence recorded via `aart push`/`POST
  // /bundles/ingest` into a non-"dev"-trust environment, awaiting a real
  // promotion) does NOT make a workflow runnable. `deploymentToBinding`
  // (`@aart/server`'s `triggers/registry.ts`) already skips these for
  // every REAL trigger path (webhook/github/slack HTTP, the poll ticker) —
  // this handler's own "is this workflow deployed" precondition must apply
  // the identical rule, or a pushed-but-unpromoted workflow would report as
  // triggerable here while every other real trigger path treats it as
  // dormant.
  const runnableDeployments = deployments.filter((d) => d.promoted !== false);
  if (runnableDeployments.length === 0) {
    return { ok: false, error: `Workflow "${input.workflowId}" has been pushed/deployed but not yet promoted (promoted:false — evidence recorded via ingest/deploy, awaiting a real promotion) in any environment. Nothing is live to trigger yet. Promote it first: "aart promote ${input.workflowId}" (CLI), POST /workflows/${input.workflowId}/promote (HTTP), or via the dashboard.` };
  }
  const runResult = await runWorkflowHandler(ctx, { workflowId: input.workflowId, input: input.input });
  return { ...runResult, kind: "run" };
}

export interface ListWaitingRunsInput {
  workflowId?: string;
}

export async function listWaitingRunsHandler(ctx: AartContext, input: ListWaitingRunsInput): Promise<HandlerResult> {
  const runs = await ctx.store.runs.list({ status: "waiting", workflowId: input.workflowId });
  const waits = await ctx.store.waits.list();
  const byRun = new Map<string, typeof waits>();
  for (const w of waits) {
    const list = byRun.get(w.runId) ?? [];
    list.push(w);
    byRun.set(w.runId, list);
  }
  return {
    ok: true,
    runs: runs.map((r) => ({ runId: r.runId, workflowId: r.workflowId, workflowVersion: r.workflowVersion, waits: byRun.get(r.runId) ?? [] })),
  };
}

export interface ResumeRunInput {
  runId: string;
  stepId?: string;
  payload?: unknown;
  signal?: { name: string; correlationId: string; payload?: unknown };
}

export async function resumeRunHandler(ctx: AartContext, input: ResumeRunInput): Promise<HandlerResult> {
  if (input.signal) {
    const outcome = await ctx.engine.resumeBySignal(input.signal);
    return { ok: outcome.kind === "resumed", outcome };
  }
  let stepId = input.stepId;
  if (!stepId) {
    const waits = await ctx.store.waits.list();
    stepId = waits.find((w) => w.runId === input.runId)?.stepId;
    if (!stepId) return { ok: false, error: `No pending wait found for run "${input.runId}".` };
  }
  const outcome = await ctx.engine.resumeManual(input.runId, stepId, input.payload);
  return { ok: outcome.kind === "resumed", outcome };
}

// ---------------------------------------------------------------------------
// deployToRemoteHandler — D1 "remotes + push" (AMENDMENTS.md A56). The ONE
// shared handler `aart push` (CLI, commands/deployment.ts) and the MCP
// `aart_deploy` tool BOTH route through directly (three-clients precedent:
// deployCommand -> deployWorkflowHandler above already works exactly this
// way) — bundles the named workflow@version via `ctx.bundler` (resolving
// the remote's OWN configured environment, never a caller-supplied one —
// D-4's remotes.json shape makes `environment` a required field per remote,
// so which environment a push targets is a property of the REMOTE, not a
// per-call input), then POSTs it to the remote's `/bundles/ingest` (or
// `/bundles/plan` for a dry-run preview) using the remote's resolved
// deploy token.
//
// Deliberately named DIFFERENTLY from `deployWorkflowHandler` above and its
// `aart_deploy_workflow` tool — ADR-1's ruling (ratified): the verb for
// THIS operation is "push"/"deploy" as a NEW, distinct concept (shipping a
// bundle to a remote HTTP server), not a rename or replacement of the
// existing LOCAL environment-promotion `aart deploy --target`/
// `aart_deploy_workflow`, which stays completely untouched. The MCP tool
// name is `aart_deploy` (not `aart_push`) per that same ratified naming —
// a deliberate asymmetry with the CLI's `aart push` verb, not an
// inconsistency to silently "fix" here.
//
// This function performs its own HTTP POST via Node 22's GLOBAL `fetch` —
// no import, so no @aart/cli dependency needed. `@aart/cli`'s own
// `pushCommand` (commands/deployment.ts) calls THIS function directly, the
// same same-function-reference three-clients precedent as
// `deployWorkflowHandler` above — @aart/cli already depends on @aart/mcp
// (architecture's three-clients principle), so there was never a real
// reason for a second, CLI-local mirror of this POST shape. D1 fix pass
// (AMENDMENTS.md A57) deleted `@aart/cli`'s `deploy-client.ts` +
// `deploy-client.test.ts` for exactly this reason — that module's own
// header comment claimed "this package cannot depend on that one" as the
// reason for its existence, which was false (the dependency direction is
// @aart/cli -> @aart/mcp, always has been), making the "mirror" dead code
// from the day it was written. This function is now the ONE implementation;
// its coverage lives in this file's own `deployToRemoteHandler` tests.
export interface DeployToRemoteInput {
  remote: string;
  workflowId: string;
  workflowVersion: string;
  /** Dry-run preview via `POST /bundles/plan` instead of `POST /bundles/ingest` — zero writes on the remote server (plan.ts's own documented contract). */
  plan?: boolean;
}

/**
 * D1 fix pass (AMENDMENTS.md A57) — `deployToRemoteHandler` below sends the
 * resolved deploy token as a plain `Authorization: Bearer <token>` header
 * (this file's own module doc comment); over `http://` — anything OTHER
 * than localhost/loopback, the legitimate local-dev/TEST-DRIVE case — that
 * token, and every bundle byte, crosses the network UNENCRYPTED. Returns a
 * warning string, never a refusal: an operator running a private-network
 * or VPN-only http deployment is a real, legitimate topology (this
 * codebase's own `DEPLOY.md` "Ops limits" section already puts the onus
 * for that exposure decision on the operator, not on this function to
 * unilaterally forbid). `undefined` for `https://` or an unparseable URL
 * (a malformed remote URL is a different problem, not this function's to
 * diagnose — `fetch` itself will fail loudly downstream).
 *
 * Exported and shared by BOTH `aart remote add` (CLI-only,
 * `commands/remote.ts` — checked at registration time, before any network
 * call) and this handler's own push path below (checked against the SAME
 * `remoteEntry.url` a real push/plan request is about to use, covering
 * both `aart push` and `aart_deploy` in one place, three-clients
 * precedent) — one implementation, so the two surfaces can never
 * independently drift on what counts as "safe."
 */
export function cleartextTokenWarning(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:") return undefined;
  if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]") return undefined;
  return `Warning: "${url}" is plain http:// — the deploy token and every bundle byte will cross the network UNENCRYPTED. Prefer https:// for anything beyond localhost or a private network you trust.`;
}

export async function deployToRemoteHandler(ctx: AartContext, input: DeployToRemoteInput): Promise<HandlerResult> {
  const remoteEntry = await ctx.remotes.get(input.remote);
  if (!remoteEntry) {
    return { ok: false, error: remoteNotFoundError(input.remote) };
  }
  // D1 fix pass (AMENDMENTS.md A57) — surfaced on the SUCCESS return only
  // (below); a failed push/plan already carries its own distinct, more
  // actionable error (network failure, remote refusal, ...) that this
  // warning would only clutter, and the success path is the common,
  // actively-watched outcome an operator iterating on `aart push` sees
  // most often.
  const cleartextWarning = cleartextTokenWarning(remoteEntry.url);

  let bundle: Awaited<ReturnType<typeof ctx.bundler.produceBundle>>;
  try {
    bundle = await ctx.bundler.produceBundle({ workflowId: input.workflowId, workflowVersion: input.workflowVersion, environment: remoteEntry.environment });
  } catch (err) {
    return { ok: false, error: `Could not produce a bundle for "${input.workflowId}@${input.workflowVersion}": ${err instanceof Error ? err.message : String(err)}` };
  }

  // Resolved but NEVER included in this function's own return value below —
  // used only to construct the outbound Authorization header (see this
  // file's own redaction-lint suppression entries for stubs/deploy.ts's
  // resolveTokenRef, which this ultimately calls).
  const token = await ctx.remotes.resolveToken(input.remote);
  const path = input.plan ? "/bundles/plan" : "/bundles/ingest";

  // D2b "remote reads" (AMENDMENTS.md, this session) — migrated onto the
  // shared `fetchFromRemote` (remote-client.ts), generalized from this
  // function's own pre-existing inline fetch so the four new `aart_remote_*`
  // read tools (remote-observability.ts) reuse the identical "attach a
  // resolved token, parse JSON, never throw on a network failure" shape
  // rather than a second, independently-drifting copy of it. Byte-for-byte
  // behavior preserved: same headers (content-type + conditional bearer
  // token), same tolerance for a malformed/absent response body.
  const response = await fetchFromRemote(remoteEntry, path, { method: "POST", body: { files: bundle.files }, token });
  if (response.networkError !== undefined) {
    return { ok: false, error: describeUnreachableRemote(input.remote, remoteEntry, response.networkError) };
  }

  if (!response.ok) {
    return { ok: false, error: `Remote "${input.remote}" refused the ${input.plan ? "plan request" : "push"}: ${remoteErrorMessage(response.body, response.status)}`, status: response.status };
  }

  // D1 fix pass (AMENDMENTS.md A57) — response.body spread FIRST, our own
  // ok/remote/plan (and cleartextWarning's own `warning`, when present) set
  // AFTER: an untrusted remote's response body (e.g. a compromised or
  // malicious remote replying `{"ok":false,"remote":"evil"}`) must never be
  // able to override this handler's OWN canonical verdict — spreading it
  // last (the pre-fix order) let it silently win in an object literal,
  // since a later key always overrides an earlier one. This function
  // already reached this line only after checking `response.ok` (the real
  // HTTP status) above; `ok: true` here is genuinely earned, not a value
  // the remote gets any say over.
  return { ...(isRecord(response.body) ? response.body : {}), ok: true, remote: input.remote, plan: input.plan === true, ...(cleartextWarning ? { warning: cleartextWarning } : {}) };
}
