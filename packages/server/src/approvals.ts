// Approval-task decision — the ONE real write path `POST
// /approvals/:id/decision` (dashboard/CLI's shared HTTP authority surface,
// spec §17.5) needs, generalized to handle BOTH shapes `ApprovalTask.runId`/
// `stepId` can encode (`@aart/governance`'s `decodeWorkflowVersionApprovalSubject`
// — approval-tasks.ts's own doc comment):
//
//  - a genuine per-run `human.approval` wait -> resume the run via the
//    injected `EngineBoundary.resumeDirect`.
//  - a workflow-VERSION-level review (`aart request-approval` / MCP
//    `aart_request_approval`'s workflowId+workflowVersion shape) -> write
//    the DECODED gate (never a hardcoded one) and recompute
//    `Workflow.approval` via governance's own `computeApprovalState`.
//
// AMENDMENTS.md A46 flagged, and A47 fixes, a real bug in the SECOND branch:
// a pre-existing dashboard-local reimplementation of it
// (`packages/dashboard/src/views/approvals.ts`'s `decideApprovalAction`, now
// deleted in favor of calling this endpoint) called
// `decodeWorkflowVersionApprovalSubject(task.runId)` with ONLY the runId —
// dropping `task.stepId`, the gate-parameterized half of that sentinel (S14
// "gate write paths", `@aart/governance`'s `approval-tasks.ts`) — and then
// hardcoded `gates.humanReview` in the write itself regardless of what
// actually decoded. A `riskReview` task decided through the dashboard UI
// silently misattributed its decision to `humanReview`. This function
// decodes BOTH `runId` AND `stepId` and writes to the gate that ACTUALLY
// decoded, closing the bug at its root — the one real implementation both
// the dashboard and any future caller of this endpoint now share — rather
// than patching the symptom in a second, divergent reimplementation.
//
// This package (@aart/server) cannot import `packages/mcp/src/handlers/
// governance.ts`'s `applyVersionReviewDecision`/`APPROVAL_TASK_GATES`
// directly (@aart/mcp depends on @aart/server, not the other way around —
// confirmed via package.json before writing this) — the small
// `APPROVAL_TASK_GATES` policy constant below is therefore a deliberate,
// narrow duplication of that module's identically-scoped constant, not a
// divergent reimplementation of the underlying mechanism (both read the
// same `GateName`s off the same governance-owned decode function).
import type { AartStore } from "@aart/store";
import type { ApprovalState, ApprovalTask, Gates, GateStatus, TrustMode } from "@aart/types";
import { computeApprovalState, decodeWorkflowVersionApprovalSubject, REQUIRED_GATES_BY_MODE, type GateName } from "@aart/governance";
import { systemClock, type Clock } from "./clock.js";
import type { EngineBoundary, ResumeResult } from "./engine/boundary.js";

/**
 * Which gates a human DECISION (via a workflow-version-level ApprovalTask)
 * may advance directly — spec §17.1's "each gate is advanced ONLY by its own
 * mechanism": `validate`/`readiness`/`evals` each have their own dedicated,
 * evidence-based writer (authoring/execution/evals handlers, @aart/mcp) and
 * must never be settled by a bare approval-task decision. Mirrors
 * `packages/mcp/src/handlers/governance.ts`'s identically-named,
 * identically-scoped constant exactly.
 */
const APPROVAL_TASK_GATES: readonly GateName[] = ["humanReview", "riskReview"];

export interface DecideApprovalTaskInput {
  status: ApprovalTask["status"];
  reviewer: string;
  decision?: unknown;
  /** Required-gate set `computeApprovalState` recomputes `Workflow.approval` against, for a workflow-version-level decision only — ignored for a genuine per-run decision. Defaults to `"governed"`, matching this codebase's other established defaults (the now-deleted dashboard-local `decideApprovalAction`, `cli-context.ts`'s `resolveTrustModeFromEnv`). */
  trustMode?: TrustMode;
  /** D2a security hardening, token-derived attribution (AMENDMENTS.md A59) — mirrors `ApprovalTask.authenticatedAs` (`@aart/types`' own doc comment has the full story); persisted verbatim onto the decided task below. The HTTP route (`http/server.ts`'s `POST /approvals/:id/decision`) is this field's one real caller — it derives the value from `ctx.authenticated?.label`, NEVER from the request body, so a caller cannot self-attribute a decision by simply including this field in its JSON. */
  authenticatedAs?: string;
}

export type DecideApprovalTaskResult =
  | { kind: "not_found" }
  | { kind: "missing_reviewer" }
  | { kind: "invalid_gate"; gate: GateName }
  | { kind: "workflow_not_found"; workflowId: string; workflowVersion: string }
  | { kind: "workflow_version"; task: ApprovalTask; workflowId: string; workflowVersion: string; gates: Gates; approval: ApprovalState }
  | { kind: "run_step"; task: ApprovalTask; resume?: ResumeResult };

/**
 * Decides `taskId`. Persists the ApprovalTask's own decision unconditionally
 * first (status/reviewer/decision/decidedAt) — matching `@aart/mcp`'s
 * `approveHandler`'s own ordering (the task record itself always reflects
 * what was decided, even in the `invalid_gate` refusal case below; only the
 * WORKFLOW gate write is refused, mirrored by
 * `governance.test.ts`'s "hand-crafted bypass" precedent) — then branches on
 * what `task.runId`/`task.stepId` decode to.
 */
export async function decideApprovalTask(store: AartStore, engine: EngineBoundary, taskId: string, input: DecideApprovalTaskInput, clock: Clock = systemClock): Promise<DecideApprovalTaskResult> {
  const task = await store.approvals.get(taskId);
  if (!task) return { kind: "not_found" };
  if (!input.reviewer) return { kind: "missing_reviewer" };

  const updated: ApprovalTask = { ...task, status: input.status, reviewer: input.reviewer, decision: input.decision, decidedAt: clock.nowIso(), authenticatedAs: input.authenticatedAs };
  await store.approvals.put(updated);

  const versionSubject = decodeWorkflowVersionApprovalSubject(task.runId, task.stepId);
  if (versionSubject) {
    if (!APPROVAL_TASK_GATES.includes(versionSubject.gate)) {
      return { kind: "invalid_gate", gate: versionSubject.gate };
    }
    const workflow = await store.workflows.get(versionSubject.workflowId, versionSubject.workflowVersion);
    if (!workflow) return { kind: "workflow_not_found", workflowId: versionSubject.workflowId, workflowVersion: versionSubject.workflowVersion };
    const gateResult: GateStatus = input.status === "approved" ? "passed" : input.status === "rejected" ? "failed" : "pending";
    const gates: Gates = { ...workflow.gates, [versionSubject.gate]: gateResult };
    const requiredGates = REQUIRED_GATES_BY_MODE[input.trustMode ?? "governed"];
    const approval = computeApprovalState(gates, requiredGates);
    await store.workflows.put({ ...workflow, gates, approval });
    return { kind: "workflow_version", task: updated, workflowId: versionSubject.workflowId, workflowVersion: versionSubject.workflowVersion, gates, approval };
  }

  if (input.status === "approved" || input.status === "rejected" || input.status === "needs_changes") {
    const resume = await engine.resumeDirect(task.runId, task.stepId, { approval: updated });
    return { kind: "run_step", task: updated, resume };
  }
  return { kind: "run_step", task: updated };
}
