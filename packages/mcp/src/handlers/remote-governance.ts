// aart_remote_approve — the WRITE-against-remote half of "see and act on a
// deployed server" that D2b's own module doc comment (remote-observability.ts)
// explicitly deferred: "The WRITE-against-remote half (aart_remote_approve)
// is explicitly DEFERRED to Wave 2, not built here." Wave 2C (AMENDMENTS.md
// A64, John-ratified 2026-07-12, "Wave 2 please" 2026-07-13) builds it: lets
// an agent approve a PAUSED run's human.approval wait, or decide a pending
// workflow-version gate (humanReview/riskReview), on a REMOTE aart server —
// the exact decision aart_approve (governance.ts) already records LOCALLY,
// sent instead to a named remote's own POST /approvals/:id/decision.
//
// Deliberately a SEPARATE tool from aart_approve, not a --remote flag on it
// (ratified design memo, mirroring ADR-1's push/deploy split precedent —
// aart_deploy is its own tool distinct from aart_deploy_workflow, never a
// flag on it) — kept in its OWN file too, isolated from the four READ tools
// (remote-observability.ts, untouched by this session) and from
// governance.ts's own already-dense local-decision logic.
//
// ONE remote route targeted, verified directly against the real source
// before writing this file: POST /approvals/:id/decision
// (packages/server/src/approvals.ts's decideApprovalTask, via
// packages/server/src/http/server.ts's own route registration). That one
// route already handles BOTH ApprovalTask shapes via the same sentinel
// decode (decodeWorkflowVersionApprovalSubject) LOCAL aart_approve's own
// approveHandler (governance.ts) branches on: a genuine per-run
// human.approval wait (resumes the run via EngineBoundary.resumeDirect), or
// a workflow-version-level humanReview/riskReview gate decision. POST
// /workflows/:id/approve is a DIFFERENT, dashboard-only mechanism
// (approve-or-deprecate a version directly, no ApprovalTask involved at
// all) that LOCAL aart_approve has never targeted either — not this tool's
// concern.
//
// reviewer stays free-text (unchanged semantics — the exact same field
// ApproveInput.reviewer already is), sent in the POST body exactly like
// every other real caller of this route. authenticatedAs is derived
// SERVER-SIDE from the bearer token (http/server.ts's own explicit
// allowlist construction off ctx.authenticated?.label — NEVER read from the
// request body, a D2a security property this tool inherits for free simply
// by calling the same route everyone else does) — this handler never sets
// it and has no field for it anywhere in its own input schema.
//
// Registration gate (tools/server.ts's isToolRegistered): the first tool in
// this codebase needing TWO independent preconditions, not one — combines
// aart_approve's own trust-mode gate (isAartApproveRegisteredForMode) with
// REMOTE_GATED_TOOLS' own "≥1 remote configured" precondition. A caller
// denied LOCAL approval in strict/production must not gain a remote escape
// hatch around that restriction (architecture §7.2) — so this tool is
// absent whenever EITHER precondition fails, present only once BOTH hold.
import type { ApprovalState, Gates } from "@aart/types";
import type { AartContext } from "../context.js";
import { describeUnreachableRemote, fetchFromRemote, remoteErrorMessage, remoteNotFoundError, type FetchFromRemoteResult } from "../remote-client.js";
import type { HandlerResult } from "../response.js";

export interface RemoteApproveInput {
  remote: string;
  taskId: string;
  decision: "approved" | "rejected" | "needs_changes";
  reviewer: string;
}

/**
 * The exact shape POST /approvals/:id/decision's own 200 response carries
 * (http/server.ts's route registration, both of decideApprovalTask's
 * success result kinds — "not_found"/"missing_reviewer"/"invalid_gate"/
 * "workflow_not_found" never reach here, all four are non-2xx and handled
 * below via describeApprovalDecisionFailure instead), narrowed to the
 * fields this handler actually surfaces. task.decision (arbitrary human/
 * agent-authored payload) is deliberately NOT part of this interface at
 * all — see remoteApproveHandler's own final return statement for why.
 */
interface RemoteDecisionResponseBody {
  kind: "workflow_version" | "run_step";
  task: { runId: string; stepId: string; status: string; reviewer?: string; authenticatedAs?: string; decidedAt?: string };
  workflowId?: string;
  workflowVersion?: string;
  gates?: Gates;
  approval?: ApprovalState;
  /**
   * EngineBoundary.ResumeResult (@aart/server) — left opaque here (this
   * package need not import that type just to pass it through). Whatever
   * RunRecord it embeds was already redacted by the REMOTE's own engine
   * before ever being persisted there — the identical "every RunRecord is
   * redacted at write time" invariant remote-observability.ts's own module
   * doc comment already establishes for a remote-fetched RunRecord read
   * back generally — so returning it unchanged reintroduces nothing the
   * LOCAL approveHandler's own run_step return (governance.ts, `outcome`)
   * doesn't already accept.
   */
  resume?: unknown;
}

/**
 * Mirrors remote-observability.ts's own describeRunReadFailure(remoteName,
 * response) shape exactly — that file's own 401-specific remedy for its two
 * conditionally-gated GET routes, reproduced here (not imported —
 * module-private there, and this file is deliberately isolated from that
 * one per this session's own file-ownership boundary) for the ONE route
 * this file's own handler calls. This route's own actionLabel ("decide an
 * approval task", http/server.ts's requireDeployTokenIfConfigured call
 * site) is quoted verbatim so this remedy names the SAME action the
 * server's own 401 body already describes.
 *
 * Every OTHER non-2xx status (400 missing-reviewer/invalid-gate, 404
 * task-not-found/workflow-not-found, ...) is deliberately left to the
 * remote's own already-precise message via remoteErrorMessage, NOT
 * hardcoded here the way aart_remote_run's own 404 handling is — unlike GET
 * /runs/:id (exactly one possible 404 cause), this ONE route's 404 has TWO
 * distinct causes decideApprovalTask can return ("approval task not found"
 * vs "Workflow ${id}@${version} not found."), and the remote's own message
 * already names which one, correctly, every time — a hardcoded guess here
 * could only ever be wrong for one of the two.
 */
function describeApprovalDecisionFailure(remoteName: string, response: FetchFromRemoteResult): string {
  if (response.status === 401) {
    return `Remote "${remoteName}" requires a deploy token to decide an approval task and either none is configured for this remote, or it's wrong (D2a's own conditional mutation-route gating — requireDeployTokenIfConfigured). Set one: "aart remote add ${remoteName} <url> --environment <envName> --token-ref secrets.<NAME>" (or edit remotes.json directly) to match the value the remote's own AART_DEPLOY_TOKEN expects.`;
  }
  return `Remote "${remoteName}" refused the approval decision: ${remoteErrorMessage(response.body, response.status)}`;
}

export async function remoteApproveHandler(ctx: AartContext, input: RemoteApproveInput): Promise<HandlerResult> {
  const remoteEntry = await ctx.remotes.get(input.remote);
  if (!remoteEntry) return { ok: false, error: remoteNotFoundError(input.remote) };
  const token = await ctx.remotes.resolveToken(input.remote);

  // POST body mirrors the LOCAL approveHandler's own writeApprovalDecision
  // call exactly (governance.ts: `status: input.decision, decision:
  // input.decision`) — status IS the human's decision (ApprovalTask.
  // status's own 5-value enum, @aart/types' approval.ts, covers all three
  // of this tool's own decision values), decision is the identical value
  // again for ApprovalTask.decision's separate free-form field. No
  // trustMode sent — this tool's own ratified input schema carries none
  // (mirrors aart_approve's schema PLUS `remote` only, never a trustMode
  // field), so the remote's own decideApprovalTask default ("governed")
  // applies — exactly as it would for any other caller of this route that
  // doesn't pass one, the dashboard's own caller included. Passing THIS
  // process's own ctx.trustMode instead would be semantically wrong: it
  // would apply the CALLER's local trust mode to the REMOTE's own gate
  // computation, two unrelated things this route's own contract never
  // conflates.
  const response = await fetchFromRemote(remoteEntry, `/approvals/${encodeURIComponent(input.taskId)}/decision`, {
    method: "POST",
    body: { status: input.decision, reviewer: input.reviewer, decision: input.decision },
    token,
  });
  if (response.networkError !== undefined) {
    return { ok: false, error: describeUnreachableRemote(input.remote, remoteEntry, response.networkError) };
  }
  if (!response.ok) {
    return { ok: false, error: describeApprovalDecisionFailure(input.remote, response), status: response.status };
  }

  const body = response.body as RemoteDecisionResponseBody | undefined;
  if (!body?.task) {
    return { ok: false, error: `Remote "${input.remote}" returned an unexpected response for the approval decision — no "task" field.` };
  }

  // Explicit ALLOWLIST, not a spread of `body`/`body.task` — task.decision
  // (arbitrary human/agent-authored payload) is deliberately excluded,
  // mirroring both aart_remote_why's own "who-approved" allowlist
  // (remote-observability.ts: {gate, reviewer, authenticatedAs, decidedAt,
  // status}) and the LOCAL approveHandler's own return shape (governance.ts),
  // which never echoes task.decision back either — three independent
  // surfaces, one consistent rule.
  return {
    ok: true,
    remote: input.remote,
    taskId: input.taskId,
    kind: body.kind,
    runId: body.task.runId,
    stepId: body.task.stepId,
    status: body.task.status,
    reviewer: body.task.reviewer,
    authenticatedAs: body.task.authenticatedAs,
    decidedAt: body.task.decidedAt,
    workflowId: body.workflowId,
    workflowVersion: body.workflowVersion,
    gates: body.gates,
    approval: body.approval,
    resume: body.resume,
  };
}
