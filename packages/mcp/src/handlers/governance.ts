// Governance handlers — aart_approve, aart_request_approval,
// aart_record_correction, aart_diff_workflow, aart_promote_workflow.
//
// Mode-gating note (load-bearing, architecture §7.2's `[DECISION]`):
// `aart_approve`'s absence in strict/production is enforced ONLY at tool
// LIST construction (tools/server.ts) — "not a runtime check inside the
// tool handler that returns 'forbidden'." approveHandler itself is
// therefore intentionally mode-agnostic: it always does the write when
// called (the CLI's `aart approve` calls this exact same handler in every
// mode, since CLI is a valid approval surface in ALL trust modes per spec
// §17.5's table — only the MCP tool's registration is mode-gated, not the
// underlying action).
//
// Resolved ambiguity (documented here + this session's final report/
// AMENDMENTS, since it's load-bearing and neither source document spells
// it out): `ApprovalTask` (@aart/types) is keyed by `(runId, stepId)` only —
// no `workflowId`/`workflowVersion` fields exist on the frozen type (spec
// §23.4's own vocabulary note confirms `ApprovalTask.status` is "a decision
// on ONE RUN's approval step", distinct from a workflow-version-level
// concept). But `aart_request_approval`/`aart_approve` (§34) and the
// `humanReview` gate (§17.1, one of the five gates `computeApprovalState`
// checks) are clearly ALSO meant to cover approving a WORKFLOW VERSION
// toward promotion — spec §17.5's whole authority-matrix section is framed
// around approving a *workflow*, not a running step. Since `human.approval`
// mid-run wait steps already get their `ApprovalTask` written by the ENGINE
// itself (S1 SEAMS.md Seam 2: "human.approval additionally causes the
// engine to write an ApprovalTask row... using with.title/with.description"),
// `aart_request_approval` here supports a SECOND input shape — workflowId +
// workflowVersion, no live run — for exactly this "please review this draft
// version" case, using a documented sentinel encoding
// (`runId: "version-review:<id>@<version>"`, `stepId: "humanReview"`) so it
// still fits the frozen ApprovalTask shape without widening it. `aart_approve`
// branches on this sentinel: a "version-review:" task updates the workflow's
// `gates.humanReview` (and recomputes `approval`); any other task resumes
// the matching run via the engine port.
import type { Gates, Workflow } from "@aart/types";
import type { AartContext } from "../context.js";
import type { HandlerResult } from "../response.js";
import { newId } from "../stubs/engine.js";

const VERSION_REVIEW_PREFIX = "version-review:";

function encodeVersionReviewRunId(workflowId: string, workflowVersion: string): string {
  return `${VERSION_REVIEW_PREFIX}${workflowId}@${workflowVersion}`;
}

function decodeVersionReviewRunId(runId: string): { workflowId: string; workflowVersion: string } | undefined {
  if (!runId.startsWith(VERSION_REVIEW_PREFIX)) return undefined;
  const rest = runId.slice(VERSION_REVIEW_PREFIX.length);
  const at = rest.lastIndexOf("@");
  if (at === -1) return undefined;
  return { workflowId: rest.slice(0, at), workflowVersion: rest.slice(at + 1) };
}

export interface RequestApprovalInput {
  runId?: string;
  stepId?: string;
  workflowId?: string;
  workflowVersion?: string;
  title?: string;
  description?: string;
}

export async function requestApprovalHandler(ctx: AartContext, input: RequestApprovalInput): Promise<HandlerResult> {
  let runId: string;
  let stepId: string;
  if (input.workflowId && input.workflowVersion) {
    runId = encodeVersionReviewRunId(input.workflowId, input.workflowVersion);
    stepId = "humanReview";
  } else if (input.runId && input.stepId) {
    runId = input.runId;
    stepId = input.stepId;
  } else {
    return { ok: false, error: "Provide either (workflowId + workflowVersion) or (runId + stepId)." };
  }

  const task = {
    id: newId("task"),
    runId,
    stepId,
    title: input.title ?? "Approval requested",
    description: input.description ?? "An agent is requesting human approval before proceeding.",
    status: "pending" as const,
    createdAt: ctx.now().toISOString(),
  };
  await ctx.store.approvals.put(task);
  return { ok: true, taskId: task.id, runId: task.runId, stepId: task.stepId };
}

export interface ApproveInput {
  taskId: string;
  decision: "approved" | "rejected" | "needs_changes";
  reviewer: string;
}

async function applyVersionReviewDecision(
  ctx: AartContext,
  workflowId: string,
  workflowVersion: string,
  decision: ApproveInput["decision"],
): Promise<HandlerResult> {
  const workflow = await ctx.store.workflows.get(workflowId, workflowVersion);
  if (!workflow) return { ok: false, error: `Workflow ${workflowId}@${workflowVersion} not found.` };
  const gateResult = decision === "approved" ? "passed" : decision === "rejected" ? "failed" : "pending";
  const gates: Gates = { ...workflow.gates, humanReview: gateResult };
  const requiredGates = ctx.governance.requiredGatesByMode[ctx.trustMode];
  const approval = ctx.governance.computeApprovalState(gates, requiredGates);
  const updated: Workflow = { ...workflow, gates, approval };
  await ctx.store.workflows.put(updated);
  return { ok: true, kind: "workflow_version", workflowId, workflowVersion, gates, approval };
}

export async function approveHandler(ctx: AartContext, input: ApproveInput): Promise<HandlerResult> {
  const task = await ctx.store.approvals.get(input.taskId);
  if (!task) return { ok: false, error: `Approval task "${input.taskId}" not found. Call aart_request_approval first.` };

  const decided = { ...task, status: input.decision, reviewer: input.reviewer, decision: input.decision, decidedAt: ctx.now().toISOString() };
  await ctx.store.approvals.put(decided);

  const versionReview = decodeVersionReviewRunId(task.runId);
  if (versionReview) {
    return applyVersionReviewDecision(ctx, versionReview.workflowId, versionReview.workflowVersion, input.decision);
  }

  const outcome = await ctx.engine.resumeApproval(task.runId, task.stepId, {
    id: decided.id,
    status: decided.status,
    decision: decided.decision,
    reviewer: decided.reviewer,
  });
  return { ok: outcome.kind === "resumed", kind: "run_step", runId: task.runId, stepId: task.stepId, outcome };
}

export interface RecordCorrectionInput {
  runId: string;
  stepId: string;
  fieldPath: string;
  observed: unknown;
  corrected: unknown;
  reason: string;
  reviewer: string;
}

export async function recordCorrectionHandler(ctx: AartContext, input: RecordCorrectionInput): Promise<HandlerResult> {
  const correction = await ctx.evidence.recordCorrection(input);
  return { ok: true, correction };
}

export interface DiffWorkflowInput {
  workflowId: string;
  fromVersion: string;
  toVersion: string;
}

export async function diffWorkflowHandler(ctx: AartContext, input: DiffWorkflowInput): Promise<HandlerResult> {
  const [from, to] = await Promise.all([
    ctx.store.workflows.get(input.workflowId, input.fromVersion),
    ctx.store.workflows.get(input.workflowId, input.toVersion),
  ]);
  if (!from) return { ok: false, error: `Workflow ${input.workflowId}@${input.fromVersion} not found.` };
  if (!to) return { ok: false, error: `Workflow ${input.workflowId}@${input.toVersion} not found.` };
  const diff = ctx.governance.semanticRiskDiff(from, to);
  return { ok: true, workflowId: input.workflowId, fromVersion: input.fromVersion, toVersion: input.toVersion, diff };
}

export interface PromoteWorkflowInput {
  workflowId: string;
  workflowVersion: string;
}

export async function promoteWorkflowHandler(ctx: AartContext, input: PromoteWorkflowInput): Promise<HandlerResult> {
  const workflow = await ctx.store.workflows.get(input.workflowId, input.workflowVersion);
  if (!workflow) return { ok: false, error: `Workflow ${input.workflowId}@${input.workflowVersion} not found.` };
  const requiredGates = ctx.governance.requiredGatesByMode[ctx.trustMode];
  const approval = ctx.governance.computeApprovalState(workflow.gates, requiredGates);
  if (approval !== workflow.approval) {
    await ctx.store.workflows.put({ ...workflow, approval });
  }
  const unmetGates = requiredGates.filter((g) => workflow.gates[g] !== "passed" && workflow.gates[g] !== "waived");
  return { ok: approval === "approved", workflowId: input.workflowId, workflowVersion: input.workflowVersion, approval, requiredGates, unmetGates };
}
