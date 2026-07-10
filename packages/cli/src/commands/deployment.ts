// aart deploy / aart trigger add — spec §33.
//
// `aart deploy` calls the exact same `deployWorkflowHandler`
// aart_deploy_workflow (MCP) calls. `aart trigger add` has no MCP-tool
// counterpart — S2's SEAMS.md is explicit that "this session [S2] does not
// own or build a CRUD/authoring surface for trigger configs ... spec's
// `aart trigger add` is @aart/cli's command, S5" and that whatever gets
// written into a `Deployment.triggerConfig` matching its documented
// `TriggerBinding` shape (minus id/type/workflowId, filled from the
// Deployment row) is what S2's adapters pick up — so this command writes
// directly into that field via the real (frozen) @aart/store, matching the
// field names S2's own SEAMS.md TriggerBinding interface lists.
import { deployWorkflowHandler, wrapResult, type HandlerResult } from "@aart/mcp";
import type { Tokenized } from "../args.js";
import { flagString, requireFlagString, requirePositional } from "../args.js";
import type { CliContext } from "../cli-context.js";

export async function deployCommand(tokens: Tokenized, cli: CliContext): Promise<HandlerResult & { next: string }> {
  const workflowId = requirePositional(tokens.positionals, 0, "workflowId");
  const workflowVersion = flagString(tokens.flags, "version") ?? (await cli.aart.store.workflows.getLatest(workflowId))?.version;
  if (!workflowVersion) return { ok: false, error: `No versions found for workflow "${workflowId}".`, next: "Call aart register first." };
  const target = requireFlagString(tokens.flags, "target");
  const result = await deployWorkflowHandler(cli.aart, { workflowId, workflowVersion, target });
  return wrapResult("aart_deploy_workflow", result);
}

// S2 SEAMS.md's documented TriggerBinding fields this command may populate
// on `Deployment.triggerConfig` (id/type/workflowId are filled from the
// Deployment row itself, per that same note, so they're excluded here).
const TRIGGER_CONFIG_FLAGS = [
  "mode",
  "webhook-path",
  "webhook-hmac-secret-ref",
  "cron",
  "timezone",
  "missed-run-policy",
  "poll-url",
  "poll-interval-ms",
  "poll-condition",
  "github-event",
  "dedupe-header-name",
] as const;

function toCamelCase(flagName: string): string {
  return flagName.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

export async function triggerAddCommand(tokens: Tokenized, cli: CliContext): Promise<HandlerResult> {
  const workflowId = requirePositional(tokens.positionals, 0, "workflowId");
  const type = requireFlagString(tokens.flags, "type");

  const deployments = await cli.aart.store.deployments.list({ workflowId });
  const deployment = deployments.at(-1);
  if (!deployment) return { ok: false, error: `Workflow "${workflowId}" is not deployed anywhere. Call aart deploy first.` };

  const triggerConfig: Record<string, unknown> = { ...deployment.triggerConfig, type };
  for (const flagName of TRIGGER_CONFIG_FLAGS) {
    const value = flagString(tokens.flags, flagName);
    if (value !== undefined) triggerConfig[toCamelCase(flagName)] = value;
  }

  const updated = { ...deployment, triggerConfig };
  await cli.aart.store.deployments.put(updated);
  return { ok: true, deployment: updated };
}

export async function triggerCommand(tokens: Tokenized, cli: CliContext): Promise<HandlerResult> {
  const [subcommand, ...rest] = tokens.positionals;
  if (subcommand === "add") return triggerAddCommand({ positionals: rest, flags: tokens.flags }, cli);
  return { ok: false, error: "Usage: aart trigger add <workflowId> --type <type>" };
}
