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
// Resolved ambiguity (documented here + AMENDMENTS.md, since it's
// load-bearing and neither source document spells it out): `ApprovalTask`
// (@aart/types) is keyed by `(runId, stepId)` only — no
// `workflowId`/`workflowVersion` fields exist on the frozen type (spec
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
// version" case.
//
// S9 integration (reconciliation ledger item 1): this package originally
// used its OWN documented-provisional sentinel encoding
// (`runId: "version-review:<id>@<version>"`, `stepId: "humanReview"`),
// built when @aart/governance was still a stub in this worktree. Now that
// governance is really merged, this handler uses ITS real sentinel
// convention instead (`ctx.governance.workflowVersionApprovalSubject`/
// `decodeWorkflowVersionApprovalSubject`) — governance owns the underlying
// ApprovalTask-writing business logic this sentinel decorates, so its
// convention won (root AMENDMENTS.md A23's "S9 resolution": two
// non-interoperable encodings of the same concept independently existed;
// this package's own was explicitly self-documented as "a fill for a
// genuine type-shape gap, not a frozen contract", i.e. always meant to be
// revisited once the real thing landed). Both handlers below also now
// route their ApprovalTask writes through `ctx.governance.writeApprovalDecision`
// instead of `ctx.store.approvals.put` directly — a real redaction-bypass
// finding from this same reconciliation pass (architecture §7.9's diagram
// names "approval decision" as a named redactRecord input path; a task's
// free-form `decision` field can echo back arbitrary data).
import type { Gates, GateStatus, Workflow } from "@aart/types";
import { recordEvent } from "@aart/store";
import type { AartContext } from "../context.js";
import type { HandlerResult } from "../response.js";
import type { GateName } from "../types.js";
import { newId } from "../stubs/engine.js";

/**
 * S14 "gate write paths" — the shared gate-update path every gate writer in
 * this codebase goes through: read the workflow, merge ONE gate's new
 * status into `gates`, recompute `approval` via governance's own
 * `computeApprovalState` (architecture §7.1's sole writer of that field —
 * unchanged by this session), persist both together, return the updated
 * snapshot. This is `applyVersionReviewDecision`'s (below) former
 * humanReview-only body, generalized so `authoring.ts` (validate),
 * `execution.ts` (readiness), and `evals.ts` (evals) reuse the identical
 * path rather than each hand-rolling their own read/merge/recompute/persist.
 */
export async function applyGateResult(
  ctx: AartContext,
  workflowId: string,
  workflowVersion: string,
  gate: GateName,
  status: GateStatus,
): Promise<HandlerResult> {
  const workflow = await ctx.store.workflows.get(workflowId, workflowVersion);
  if (!workflow) return { ok: false, error: `Workflow ${workflowId}@${workflowVersion} not found.` };
  const gates: Gates = { ...workflow.gates, [gate]: status };
  const requiredGates = ctx.governance.requiredGatesByMode[ctx.trustMode];
  const approval = ctx.governance.computeApprovalState(gates, requiredGates);
  const updated: Workflow = { ...workflow, gates, approval };
  await ctx.store.workflows.put(updated);

  // V1 event log (AMENDMENTS.md A61) — this is the shared gate-write path
  // every validate/readiness/evals writer (authoring.ts/execution.ts/
  // evals.ts) AND the mcp aart_approve path (applyVersionReviewDecision
  // below, for humanReview/riskReview) all route through, so one write site
  // here covers every one of those gates. humanReview/riskReview decided
  // via the SERVER's own HTTP decision route instead
  // (packages/server/src/approvals.ts's decideApprovalTask) needs its OWN,
  // independent copy of this same gate_passed/gate_failed write — required
  // by package layering: @aart/server cannot import @aart/mcp.
  if (gate === "validate") {
    await recordEvent(ctx.store, { type: "workflow.validated", workflowId, workflowVersion, summary: `${workflowId}@${workflowVersion} ${status} validate` }, ctx.now);
  }
  if (status === "passed" || status === "failed") {
    await recordEvent(
      ctx.store,
      { type: status === "passed" ? "workflow.gate_passed" : "workflow.gate_failed", workflowId, workflowVersion, summary: `${workflowId}@${workflowVersion} ${status} ${gate}` },
      ctx.now,
    );
  }
  // V1 event log (AMENDMENTS.md A61) — NOT in this session's own briefed
  // write-site list (which names only promoteWorkflowHandler and
  // approveOrDeprecateWorkflow for workflow.approved), but this function
  // ALSO recomputes and writes `approval` on every call, unconditionally —
  // whichever gate happens to be the LAST one a mode requires can flip a
  // workflow from "draft" to "approved" right here, as a side effect of a
  // human's decision (aart_approve/aart approve) or an evidence-based
  // writer (validate/readiness/evals), with no separate call to
  // promoteWorkflowHandler ever happening. Caught by this session's own
  // test suite (governance.test.ts) before it shipped: a workflow-version
  // review decision that satisfies the last required gate produced
  // approval.decided + workflow.gate_passed but silently NO
  // workflow.approved — exactly the missed-composition-root failure shape
  // this session's standing imperative exists to catch, just for an event
  // type rather than a config field.
  if (approval !== workflow.approval && approval === "approved") {
    await recordEvent(ctx.store, { type: "workflow.approved", workflowId, workflowVersion, summary: `${workflowId}@${workflowVersion} approved` }, ctx.now);
  }

  return { ok: true, kind: "workflow_version", workflowId, workflowVersion, gates, approval };
}

/**
 * Which gates a human DECISION (aart_approve, via a workflow-version-level
 * ApprovalTask) may advance — spec §17.1's "each gate is advanced ONLY by
 * its own mechanism": `validate`/`readiness`/`evals` each get their own
 * dedicated, evidence-based writer (authoring.ts/execution.ts/evals.ts) and
 * must never be settled by a bare human click. Enforced at TWO points:
 * requestApprovalHandler below (a friendly, request-time rejection) and
 * applyVersionReviewDecision (the load-bearing check — a defensive re-check
 * against whatever gate a task's OWN stored `stepId` actually decodes to,
 * closing the bypass a hand-crafted runId+stepId request could otherwise
 * open around the first check).
 */
const APPROVAL_TASK_GATES: readonly GateName[] = ["humanReview", "riskReview"];

export interface RequestApprovalInput {
  runId?: string;
  stepId?: string;
  workflowId?: string;
  workflowVersion?: string;
  /** S14: which gate this workflow-version-level request targets — `"humanReview"` (default, this parameter's pre-S14 sole behavior) or `"riskReview"`. Ignored for the runId+stepId (per-run wait) shape, which isn't a workflow-version gate at all. */
  gate?: GateName;
  title?: string;
  description?: string;
}

export async function requestApprovalHandler(ctx: AartContext, input: RequestApprovalInput): Promise<HandlerResult> {
  let runId: string;
  let stepId: string;
  if (input.workflowId && input.workflowVersion) {
    const gate = input.gate ?? "humanReview";
    if (!APPROVAL_TASK_GATES.includes(gate)) {
      return { ok: false, error: `--gate must be one of: ${APPROVAL_TASK_GATES.join(", ")} (got "${gate}").` };
    }
    ({ runId, stepId } = ctx.governance.workflowVersionApprovalSubject(input.workflowId, input.workflowVersion, gate));
  } else if (input.runId && input.stepId) {
    runId = input.runId;
    stepId = input.stepId;
  } else {
    return { ok: false, error: "Provide either (workflowId + workflowVersion) or (runId + stepId)." };
  }

  const task = await ctx.governance.writeApprovalDecision(ctx.store, {
    id: newId("task"),
    runId,
    stepId,
    title: input.title ?? "Approval requested",
    description: input.description ?? "An agent is requesting human approval before proceeding.",
    status: "pending",
    createdAt: ctx.now().toISOString(),
  });
  // V1 event log (AMENDMENTS.md A61) — workflowId/workflowVersion for the
  // version-review shape (known directly from `input`, no need to decode
  // task.runId/stepId back); runId for the genuine per-run wait shape.
  await recordEvent(
    ctx.store,
    {
      type: "approval.requested",
      approvalTaskId: task.id,
      ...(input.workflowId && input.workflowVersion ? { workflowId: input.workflowId, workflowVersion: input.workflowVersion } : { runId: task.runId }),
      summary: `approval requested: ${task.title}`,
    },
    ctx.now,
  );
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
  gate: GateName,
  decision: ApproveInput["decision"],
): Promise<HandlerResult> {
  if (!APPROVAL_TASK_GATES.includes(gate)) {
    return { ok: false, error: `A human decision cannot set gate "${gate}" — only ${APPROVAL_TASK_GATES.join(", ")} are decided via approval tasks.` };
  }
  const gateResult: GateStatus = decision === "approved" ? "passed" : decision === "rejected" ? "failed" : "pending";
  return applyGateResult(ctx, workflowId, workflowVersion, gate, gateResult);
}

export async function approveHandler(ctx: AartContext, input: ApproveInput): Promise<HandlerResult> {
  const task = await ctx.store.approvals.get(input.taskId);
  if (!task) return { ok: false, error: `Approval task "${input.taskId}" not found. Call aart_request_approval first.` };

  const decided = await ctx.governance.writeApprovalDecision(ctx.store, {
    ...task,
    status: input.decision,
    reviewer: input.reviewer,
    decision: input.decision,
    decidedAt: ctx.now().toISOString(),
  });

  // V1 event log (AMENDMENTS.md A61) — NOT in this session's own briefed
  // write-site list (which names only server/approvals.ts's
  // decideApprovalTask for approval.decided), but `approveHandler` is a
  // SECOND, independently-reachable real entry point for the identical
  // fact: CLI's `aart approve` (commands/governance.ts) and the MCP tool
  // `aart_approve` both dispatch here directly, never through
  // decideApprovalTask (that function backs the dashboard's separate `POST
  // /approvals/:id/decision` HTTP route) — verified directly, not assumed.
  // Omitting this would silently drop every CLI/MCP-decided approval from
  // the event log, exactly the missed-composition-root failure shape this
  // session's own standing imperative exists to catch.
  const versionReview = ctx.governance.decodeWorkflowVersionApprovalSubject(task.runId, task.stepId);
  await recordEvent(
    ctx.store,
    {
      type: "approval.decided",
      approvalTaskId: decided.id,
      ...(versionReview ? { workflowId: versionReview.workflowId, workflowVersion: versionReview.workflowVersion } : { runId: task.runId }),
      summary: `${decided.id} decided ${input.decision} by ${input.reviewer}`,
    },
    ctx.now,
  );

  if (versionReview) {
    return applyVersionReviewDecision(ctx, versionReview.workflowId, versionReview.workflowVersion, versionReview.gate, input.decision);
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
  await recordEvent(
    ctx.store,
    { type: "correction.recorded", runId: input.runId, summary: `correction recorded for run ${input.runId} step ${input.stepId} (${input.fieldPath})` },
    ctx.now,
  );
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
    // V1 event log (AMENDMENTS.md A61) — only on a genuine transition,
    // colocated with the write above; computeApprovalState's own contract
    // never returns "deprecated" (approveOrDeprecateWorkflow's own doc
    // comment, server/workflow-actions.ts), but this still guards on the
    // resulting value rather than assuming "changed" implies "approved".
    if (approval === "approved") {
      await recordEvent(ctx.store, { type: "workflow.approved", workflowId: input.workflowId, workflowVersion: input.workflowVersion, summary: `${input.workflowId}@${input.workflowVersion} approved` }, ctx.now);
    }
  }
  const unmetGates = requiredGates.filter((g) => workflow.gates[g] !== "passed" && workflow.gates[g] !== "waived");
  // gates (S14): the full current gate snapshot, already in scope — a
  // read-side addition (promoteWorkflowHandler writes no gate itself, only
  // reconciles `approval`), included so a caller can see every gate's
  // status alongside unmetGates rather than just the required subset.
  return { ok: approval === "approved", workflowId: input.workflowId, workflowVersion: input.workflowVersion, approval, gates: workflow.gates, requiredGates, unmetGates };
}
