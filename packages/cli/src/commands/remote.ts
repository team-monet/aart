// aart remote add/list/remove — D1 "remotes + push" (AMENDMENTS.md A56),
// D-4 of the design memo.
//
// CLI-only CRUD over `<root>/remotes.json` (remote-config.ts) — no MCP-tool
// counterpart, the same class as `aart trigger add` (commands/deployment.ts's
// own doc comment: "S2's SEAMS.md is explicit that this session does not
// own or build a CRUD/authoring surface for trigger configs"). Subcommand
// dispatch mirrors `triggerCommand`'s own shape exactly.
import { readRemotes, writeRemotes, type RemoteEntry } from "../remote-config.js";
import type { Tokenized } from "../args.js";
import { flagString, requireFlagString, requirePositional } from "../args.js";
import type { CliContext } from "../cli-context.js";
import type { HandlerResult } from "@aart/mcp";

export async function remoteAddCommand(tokens: Tokenized, cli: CliContext): Promise<HandlerResult> {
  const name = requirePositional(tokens.positionals, 0, "name");
  const url = requirePositional(tokens.positionals, 1, "url");
  const environment = requireFlagString(tokens.flags, "environment");
  const tokenRef = flagString(tokens.flags, "token-ref");

  const remotes = await readRemotes(cli.root);
  const entry: RemoteEntry = { url, environment, ...(tokenRef ? { tokenRef } : {}) };
  remotes[name] = entry;
  await writeRemotes(cli.root, remotes);
  return { ok: true, remote: { name, ...entry } };
}

export async function remoteListCommand(cli: CliContext): Promise<HandlerResult> {
  const remotes = await readRemotes(cli.root);
  return { ok: true, remotes: Object.entries(remotes).map(([name, entry]) => ({ name, ...entry })) };
}

export async function remoteRemoveCommand(tokens: Tokenized, cli: CliContext): Promise<HandlerResult> {
  const name = requirePositional(tokens.positionals, 0, "name");
  const remotes = await readRemotes(cli.root);
  if (!(name in remotes)) {
    return { ok: false, error: `Remote "${name}" not found. Call "aart remote list" to see configured remotes.` };
  }
  delete remotes[name];
  await writeRemotes(cli.root, remotes);
  return { ok: true, removed: name };
}

export async function remoteCommand(tokens: Tokenized, cli: CliContext): Promise<HandlerResult> {
  const [subcommand, ...rest] = tokens.positionals;
  if (subcommand === "add") return remoteAddCommand({ positionals: rest, flags: tokens.flags }, cli);
  if (subcommand === "list") return remoteListCommand(cli);
  if (subcommand === "remove") return remoteRemoveCommand({ positionals: rest, flags: tokens.flags }, cli);
  return { ok: false, error: "Usage: aart remote add <name> <url> --environment <envName> [--token-ref <name>] | aart remote list | aart remote remove <name>" };
}
