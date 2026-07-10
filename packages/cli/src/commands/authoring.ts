// aart run / aart validate / aart list / aart register / aart init /
// aart init-agent — spec §33's first six commands. run/validate/register
// dispatch through @aart/mcp's SAME handler functions aart_run_workflow/
// aart_validate/aart_register_block call (architecture's three-clients
// principle). list/init have no MCP-tool counterpart at all (pure catalog
// listing / project scaffolding) so they're implemented directly here
// against the real @aart/store.
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generateInitAgentOutputs, registerWorkflowHandler, runWorkflowHandler, validateWorkflowHandler, wrapResult, type HandlerResult } from "@aart/mcp";
import type { Tokenized } from "../args.js";
import { flagString, requirePositional } from "../args.js";
import type { CliContext } from "../cli-context.js";

export async function runCommand(tokens: Tokenized, cli: CliContext): Promise<HandlerResult & { next: string }> {
  const workflowId = requirePositional(tokens.positionals, 0, "workflowId");
  const inputRaw = flagString(tokens.flags, "input");
  const input = inputRaw ? (JSON.parse(inputRaw) as Record<string, unknown>) : undefined;
  const result = await runWorkflowHandler(cli.aart, { workflowId, workflowVersion: flagString(tokens.flags, "version"), input });
  return wrapResult("aart_run_workflow", result);
}

export async function validateCommand(tokens: Tokenized, cli: CliContext): Promise<HandlerResult & { next: string }> {
  const path = requirePositional(tokens.positionals, 0, "path");
  const source = await readFile(path, "utf8");
  const result = await validateWorkflowHandler(cli.aart, { workflow: source });
  return wrapResult("aart_validate", result);
}

export async function registerCommand(tokens: Tokenized, cli: CliContext): Promise<HandlerResult & { next: string }> {
  const path = requirePositional(tokens.positionals, 0, "path");
  const source = await readFile(path, "utf8");
  const result = await registerWorkflowHandler(cli.aart, { workflow: source });
  return wrapResult("aart_register_block", result);
}

export async function listCommand(_tokens: Tokenized, cli: CliContext): Promise<HandlerResult> {
  const ids = await cli.aart.store.workflows.listWorkflowIds();
  const workflows = await Promise.all(
    ids.map(async (id) => {
      const versions = await cli.aart.store.workflows.listVersions(id);
      const latest = await cli.aart.store.workflows.getLatest(id);
      return { id, versions, latestVersion: latest?.version, approval: latest?.approval };
    }),
  );
  return { ok: true, workflows };
}

export async function initCommand(_tokens: Tokenized, cli: CliContext): Promise<HandlerResult> {
  // Touching every collection's list method is enough to make the fs
  // adapter materialize `.aart`'s full directory layout (architecture
  // §5.2) even before anything has been written.
  await cli.aart.store.workflows.listWorkflowIds();
  await cli.aart.store.evals.listSuites();
  await cli.aart.store.environments.list();
  return { ok: true, message: "AART project initialized." };
}

export async function initAgentCommand(tokens: Tokenized, cli: CliContext): Promise<HandlerResult> {
  const outputs = generateInitAgentOutputs({ trustMode: cli.aart.trustMode, packageName: flagString(tokens.flags, "package") });
  const cwd = flagString(tokens.flags, "cwd") ?? process.cwd();
  const mcpConfigPath = flagString(tokens.flags, "mcp-config-out") ?? join(cwd, ".mcp.json");
  const instructionsPath = flagString(tokens.flags, "instructions-out") ?? join(cwd, "AGENTS.md");
  await mkdir(join(mcpConfigPath, ".."), { recursive: true });
  await mkdir(join(instructionsPath, ".."), { recursive: true });
  await writeFile(mcpConfigPath, outputs.mcpConfigJson, "utf8");
  await writeFile(instructionsPath, outputs.instructions, "utf8");
  return { ok: true, mcpConfigPath, instructionsPath };
}
