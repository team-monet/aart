// aart diff / aart correction add|list / aart promote / aart approve /
// aart approve-remote / aart request-approval.
//
// `aart approve` (spec §33 does not literally list this command) is this
// session's own deliberate, documented addition: spec §17.5's authority
// matrix names "CLI + dashboard" as the approval surface in EVERY trust
// mode, and is the ONLY surface left once `aart_approve` is absent from the
// MCP tool list in strict/production — without a CLI decision-recording
// path, those two modes would have no way to approve anything through
// anything this session builds. Calls the exact same `approveHandler`
// aart_approve (MCP) calls — see packages/mcp/src/handlers/governance.ts's
// own module doc comment for the full resolved-ambiguity note this shares.
//
// `aart approve-remote` (Wave 2C, AMENDMENTS.md A64): the REMOTE
// counterpart of `aart approve` — same CLI-is-always-a-valid-surface
// reasoning, now for a decision against a named remote's own
// POST /approvals/:id/decision instead of the local store. Calls the exact
// same `remoteApproveHandler` the MCP `aart_remote_approve` tool calls —
// see packages/mcp/src/handlers/remote-governance.ts's own module doc
// comment for the full design.
//
// `aart request-approval` (AMENDMENTS.md A45): the CLI-side gap A44 found
// and explicitly left open — `aart approve` could DECIDE on an existing
// ApprovalTask but nothing in the CLI's own surface could CREATE one
// (`aart_request_approval` was MCP-only), so `aart deploy` could never be
// made to succeed from the CLI alone. Calls the exact same
// `requestApprovalHandler` `aart_request_approval` (MCP) calls, same
// three-clients-principle pattern as `approveCommand` above — matches its
// `workflowId [--version]` shape to `promoteCommand`/`deployCommand`'s own
// (defaults to that workflow's latest registered version when omitted).
import {
  approveHandler,
  diffWorkflowHandler,
  promoteWorkflowHandler,
  recordCorrectionHandler,
  remoteApproveHandler,
  requestApprovalHandler,
  wrapResult,
  type HandlerResult,
} from "@aart/mcp";
import type { Tokenized } from "../args.js";
import { flagString, requireFlagString, requirePositional } from "../args.js";
import type { CliContext } from "../cli-context.js";

export async function diffCommand(tokens: Tokenized, cli: CliContext): Promise<HandlerResult & { next: string }> {
  const workflowId = requirePositional(tokens.positionals, 0, "workflowId");
  const toVersion = flagString(tokens.flags, "to") ?? (await cli.aart.store.workflows.getLatest(workflowId))?.version;
  if (!toVersion) return { ok: false, error: `No versions found for workflow "${workflowId}".`, next: "Call aart register first." };
  const versions = await cli.aart.store.workflows.listVersions(workflowId);
  const fromVersion = flagString(tokens.flags, "from") ?? versions.filter((v) => v !== toVersion).at(-1) ?? toVersion;
  const result = await diffWorkflowHandler(cli.aart, { workflowId, fromVersion, toVersion });
  return wrapResult("aart_diff_workflow", result);
}

export async function correctionCommand(tokens: Tokenized, cli: CliContext): Promise<HandlerResult & { next?: string }> {
  const [subcommand, ...rest] = tokens.positionals;
  if (subcommand === "add") {
    const runId = requirePositional(rest, 0, "runId");
    const result = await recordCorrectionHandler(cli.aart, {
      runId,
      stepId: requireFlagString(tokens.flags, "step"),
      fieldPath: requireFlagString(tokens.flags, "field"),
      observed: JSON.parse(requireFlagString(tokens.flags, "observed")),
      corrected: JSON.parse(requireFlagString(tokens.flags, "corrected")),
      reason: requireFlagString(tokens.flags, "reason"),
      reviewer: requireFlagString(tokens.flags, "reviewer"),
    });
    return wrapResult("aart_record_correction", result);
  }
  if (subcommand === "list") {
    const corrections = await cli.aart.store.corrections.list({
      runId: flagString(tokens.flags, "run"),
      stepId: flagString(tokens.flags, "step"),
    });
    return { ok: true, corrections };
  }
  return { ok: false, error: 'Usage: aart correction add <runId> | aart correction list' };
}

/** `--gate humanReview|riskReview` (S14 "gate write paths", default `humanReview` — this command's pre-S14 sole behavior): extends the SAME ApprovalTask task/decision flow to a `riskReview` workflow-version decision, no new mechanism. Validated here too (not only inside `requestApprovalHandler`) for a friendly early error, matching `approveCommand`'s own `--decision` enum check just below. */
export async function requestApprovalCommand(tokens: Tokenized, cli: CliContext): Promise<HandlerResult & { next: string }> {
  const workflowId = requirePositional(tokens.positionals, 0, "workflowId");
  // Flag-shape validation (--gate) happens BEFORE any store lookup — same
  // fail-fast-on-malformed-input discipline approveCommand's own --decision
  // check uses, so a bad --gate value is reported immediately rather than
  // masked by an unrelated "No versions found" error when both are wrong.
  const gate = flagString(tokens.flags, "gate");
  if (gate !== undefined && gate !== "humanReview" && gate !== "riskReview") {
    return { ok: false, error: "--gate must be one of: humanReview, riskReview", next: "Retry with a valid --gate." };
  }
  const workflowVersion = flagString(tokens.flags, "version") ?? (await cli.aart.store.workflows.getLatest(workflowId))?.version;
  if (!workflowVersion) return { ok: false, error: `No versions found for workflow "${workflowId}".`, next: "Call aart register first." };
  const result = await requestApprovalHandler(cli.aart, { workflowId, workflowVersion, gate });
  return wrapResult("aart_request_approval", result);
}

export async function promoteCommand(tokens: Tokenized, cli: CliContext): Promise<HandlerResult & { next: string }> {
  const workflowId = requirePositional(tokens.positionals, 0, "workflowId");
  const workflowVersion = flagString(tokens.flags, "version") ?? (await cli.aart.store.workflows.getLatest(workflowId))?.version;
  if (!workflowVersion) return { ok: false, error: `No versions found for workflow "${workflowId}".`, next: "Call aart register first." };
  const result = await promoteWorkflowHandler(cli.aart, { workflowId, workflowVersion });
  return wrapResult("aart_promote_workflow", result);
}

export async function approveCommand(tokens: Tokenized, cli: CliContext): Promise<HandlerResult & { next: string }> {
  const taskId = requirePositional(tokens.positionals, 0, "taskId");
  const decision = requireFlagString(tokens.flags, "decision");
  if (decision !== "approved" && decision !== "rejected" && decision !== "needs_changes") {
    return { ok: false, error: '--decision must be one of: approved, rejected, needs_changes', next: "Retry with a valid --decision." };
  }
  const result = await approveHandler(cli.aart, { taskId, decision, reviewer: requireFlagString(tokens.flags, "reviewer") });
  return wrapResult("aart_approve", result);
}

/**
 * `aart approve-remote <remote> <taskId> --decision <approved|rejected|needs_changes> --reviewer <name>`
 * — Wave 2C (AMENDMENTS.md A64). The REMOTE counterpart of `approveCommand`
 * above: identical `--decision` validation (same three values, same early
 * fail-fast-on-malformed-input discipline), one extra leading positional
 * (`remote`, matching `remoteWhyCommand`/`remoteRunCommand`'s own
 * `<remote> <id>` positional ordering, commands/remote-observability.ts) —
 * routes through the exact same `remoteApproveHandler` the MCP
 * `aart_remote_approve` tool calls (three-clients precedent, the same
 * shape `approveCommand` above already establishes for the local case).
 */
export async function approveRemoteCommand(tokens: Tokenized, cli: CliContext): Promise<HandlerResult & { next: string }> {
  const remote = requirePositional(tokens.positionals, 0, "remote");
  const taskId = requirePositional(tokens.positionals, 1, "taskId");
  const decision = requireFlagString(tokens.flags, "decision");
  if (decision !== "approved" && decision !== "rejected" && decision !== "needs_changes") {
    return { ok: false, error: '--decision must be one of: approved, rejected, needs_changes', next: "Retry with a valid --decision." };
  }
  const result = await remoteApproveHandler(cli.aart, { remote, taskId, decision, reviewer: requireFlagString(tokens.flags, "reviewer") });
  return wrapResult("aart_remote_approve", result);
}
