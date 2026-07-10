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
