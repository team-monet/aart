// aart diff / aart correction add|list / aart promote / aart approve /
// aart request-approval.
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

export async function requestApprovalCommand(tokens: Tokenized, cli: CliContext): Promise<HandlerResult & { next: string }> {
  const workflowId = requirePositional(tokens.positionals, 0, "workflowId");
  const workflowVersion = flagString(tokens.flags, "version") ?? (await cli.aart.store.workflows.getLatest(workflowId))?.version;
  if (!workflowVersion) return { ok: false, error: `No versions found for workflow "${workflowId}".`, next: "Call aart register first." };
  const result = await requestApprovalHandler(cli.aart, { workflowId, workflowVersion });
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
