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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function deployToRemoteHandler(ctx: AartContext, input: DeployToRemoteInput): Promise<HandlerResult> {
  const remoteEntry = await ctx.remotes.get(input.remote);
  if (!remoteEntry) {
    return { ok: false, error: `Remote "${input.remote}" not found. Add it first — "aart remote add ${input.remote} <url> --environment <envName>", then "aart remote list" to confirm.` };
  }

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

  let response: Response;
  try {
    response = await fetch(new URL(path, remoteEntry.url), {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ files: bundle.files }),
    });
  } catch (err) {
    return { ok: false, error: `Could not reach remote "${input.remote}" (${remoteEntry.url}): ${err instanceof Error ? err.message : String(err)}. Check the URL ("aart remote list") and your network connection, then retry.` };
  }

  let responseBody: unknown;
  try {
    responseBody = await response.json();
  } catch {
    responseBody = undefined;
  }

  if (!response.ok) {
    const message = isRecord(responseBody) && typeof responseBody["error"] === "string" ? responseBody["error"] : `HTTP ${response.status}`;
    return { ok: false, error: `Remote "${input.remote}" refused the ${input.plan ? "plan request" : "push"}: ${message}`, status: response.status };
  }

  return { ok: true, remote: input.remote, plan: input.plan === true, ...(isRecord(responseBody) ? responseBody : {}) };
}
