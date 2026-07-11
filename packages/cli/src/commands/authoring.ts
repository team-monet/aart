// aart run / aart validate / aart list / aart register / aart init /
// aart init-agent — spec §33's first six commands. run/validate/register
// dispatch through @aart/mcp's SAME handler functions aart_run_workflow/
// aart_validate/aart_register_block call (architecture's three-clients
// principle). list/init have no MCP-tool counterpart at all (pure catalog
// listing / project scaffolding) so they're implemented directly here
// against the real @aart/store.
import { existsSync } from "node:fs";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generateInitAgentOutputs, registerWorkflowHandler, runWorkflowHandler, validateWorkflowHandler, wrapResult, type HandlerResult, type McpConfig } from "@aart/mcp";
import type { Tokenized } from "../args.js";
import { flagBoolean, flagString, requirePositional } from "../args.js";
import type { CliContext } from "../cli-context.js";

export async function runCommand(tokens: Tokenized, cli: CliContext): Promise<HandlerResult & { next: string }> {
  const workflowId = requirePositional(tokens.positionals, 0, "workflowId");
  const inputRaw = flagString(tokens.flags, "input");
  const input = inputRaw ? (JSON.parse(inputRaw) as Record<string, unknown>) : undefined;
  const result = await runWorkflowHandler(cli.aart, { workflowId, workflowVersion: flagString(tokens.flags, "version"), input });
  return wrapResult("aart_run_workflow", result);
}

/**
 * `--registered` (S14 "gate write paths"): validates an already-registered
 * VERSION by reference instead of a file path — the dead branch A45 found
 * (`validateWorkflowHandler`'s own `workflowId`+`workflowVersion` shape),
 * now genuinely reachable from the CLI. Matches `promoteCommand`/
 * `deployCommand`/`requestApprovalCommand`'s own `workflowId [--version]`
 * shape (defaults to that workflow's latest registered version). Default
 * (no `--registered`) is BYTE-FOR-BYTE the pre-S14 behavior: the positional
 * is a file path, read from disk, validated as a draft — never touches
 * gates (validating a file is pre-registration, spec §17.1's `validate`
 * gate is a fact about a stored VERSION).
 */
export async function validateCommand(tokens: Tokenized, cli: CliContext): Promise<HandlerResult & { next: string }> {
  if (flagBoolean(tokens.flags, "registered")) {
    const workflowId = requirePositional(tokens.positionals, 0, "workflowId");
    const workflowVersion = flagString(tokens.flags, "version") ?? (await cli.aart.store.workflows.getLatest(workflowId))?.version;
    if (!workflowVersion) return wrapResult("aart_validate", { ok: false, error: `No versions found for workflow "${workflowId}".` });
    const result = await validateWorkflowHandler(cli.aart, { workflowId, workflowVersion });
    return wrapResult("aart_validate", result);
  }

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

/**
 * `binPath` for `generateInitAgentOutputs` (`@aart/mcp`, see its own header
 * comment for the npx-registry trap this closes): defaults to
 * `process.argv[1]` — the path Node was actually launched with, which for a
 * real `aart init-agent` invocation is the installed `aart` entrypoint
 * itself (a global-install shim, an isolated-prefix `.bin/aart` symlink, or
 * a direct `node dist/bin.js`, whichever this process IS) — always
 * self-consistent, no npm-registry guesswork. `--npx` opts back into the
 * original registry-resolved form (correct once `packageName` is genuinely
 * published at a matching version); `--bin-path <path>` overrides the
 * default explicitly, mainly for tests that invoke this command in-process
 * (where `process.argv[1]` is the test runner's own script, not a
 * meaningful `aart` path).
 */
function resolveBinPath(tokens: Tokenized): string | undefined {
  if (flagBoolean(tokens.flags, "npx")) return undefined;
  return flagString(tokens.flags, "bin-path") ?? process.argv[1];
}

/**
 * `.mcp.json` is a shared, multi-tenant registry — a real project (this
 * founder's own included, per with-aart/bootstrap/install.md) routinely has
 * OTHER MCP servers already registered there (e.g. `monet`'s own per-repo
 * entry) before `aart init-agent` ever runs. Before this function existed,
 * `initAgentCommand` wrote `outputs.mcpConfigJson` straight over whatever
 * was already on disk — silently deleting every sibling server entry, the
 * exact "clobber" failure mode with-monet's own install.md explicitly
 * guards against by hand for every host config it touches. Read-merge-write
 * instead: parse what's already there, replace only the `aart` key (in
 * place — re-running `init-agent` after an update is the documented
 * refresh mechanism, AUTHORING.md part (f), so `aart`'s own entry is MEANT
 * to be overwritten each run), keep every other top-level key and every
 * sibling server entry untouched. No existing file -> behaves exactly as
 * before (the common case; byte-identical output, since `generated` IS
 * `outputs.mcpConfig`). A file that exists but fails to parse as JSON is
 * left on disk untouched and reported as an error, rather than silently
 * replaced — the same "fail loudly instead of silently doing the wrong
 * thing" tradeoff `aart server`'s missing-store-root check (cli.ts,
 * AMENDMENTS.md A47) and A54's own binPath fix already make elsewhere in
 * this codebase.
 */
async function mergeMcpConfig(mcpConfigPath: string, generated: McpConfig): Promise<Record<string, unknown>> {
  // A fresh object-literal spread, not the `generated` variable itself —
  // `McpConfig` is a named interface with no index signature, so returning
  // it directly doesn't structurally satisfy `Record<string, unknown>`
  // (TS2322), even though the merge branch below's own fresh literal does.
  if (!existsSync(mcpConfigPath)) return { ...generated };
  const raw = await readFile(mcpConfigPath, "utf8");
  let existing: Record<string, unknown>;
  try {
    existing = JSON.parse(raw) as Record<string, unknown>;
  } catch (cause) {
    throw new Error(
      `${mcpConfigPath} already exists but is not valid JSON — fix or remove it by hand before re-running "aart init-agent", so its other MCP server entries (if any) aren't silently lost.`,
      { cause },
    );
  }
  const existingServers = (existing["mcpServers"] as Record<string, unknown> | undefined) ?? {};
  return { ...existing, mcpServers: { ...existingServers, ...generated.mcpServers } };
}

export async function initAgentCommand(tokens: Tokenized, cli: CliContext): Promise<HandlerResult> {
  const outputs = generateInitAgentOutputs({
    trustMode: cli.aart.trustMode,
    packageName: flagString(tokens.flags, "package"),
    binPath: resolveBinPath(tokens),
  });
  const cwd = flagString(tokens.flags, "cwd") ?? process.cwd();
  const mcpConfigPath = flagString(tokens.flags, "mcp-config-out") ?? join(cwd, ".mcp.json");
  const instructionsPath = flagString(tokens.flags, "instructions-out") ?? join(cwd, "AGENTS.md");
  await mkdir(join(mcpConfigPath, ".."), { recursive: true });
  await mkdir(join(instructionsPath, ".."), { recursive: true });
  const mergedMcpConfig = await mergeMcpConfig(mcpConfigPath, outputs.mcpConfig);
  await writeFile(mcpConfigPath, JSON.stringify(mergedMcpConfig, null, 2), "utf8");
  await writeFile(instructionsPath, outputs.instructions, "utf8");
  return { ok: true, mcpConfigPath, instructionsPath };
}
