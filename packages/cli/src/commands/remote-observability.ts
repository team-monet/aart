// aart remote-status / remote-why / remote-runs / remote-run — D2b "remote
// reads" (AMENDMENTS.md, this session). Thin wrappers calling the exact
// same handler functions the aart_remote_* MCP tools call (three-clients
// precedent, the SAME shape as deployCommand/pushCommand,
// commands/deployment.ts).
//
// Hyphenated command names, not `aart remote <subcommand>` — deliberate, two
// reasons: (1) bare `aart status`/`aart run`/`aart runs` are already taken —
// `case "run":` (cli.ts) dispatches to the LOCAL `runCommand`
// (commands/authoring.ts), and neither `status` nor `runs` exists as a
// standalone command today either, so reusing either bare word for a
// REMOTE-scoped operation would read as if it were the local equivalent.
// (2) `aart remote <subcommand>` (commands/remote.ts) is already reserved
// for `remotes.json` CRUD (add/list/remove, zero network calls) — these four
// commands are live network reads against a configured remote, a
// meaningfully different operation that deserves a visibly different verb,
// not a same-named subcommand of `remote` that behaves nothing like its
// siblings.
import { remoteRunHandler, remoteRunsHandler, remoteStatusHandler, remoteWhyHandler, wrapResult, type HandlerResult } from "@aart/mcp";
import type { RunStatus } from "@aart/types";
import type { Tokenized } from "../args.js";
import { flagString, requirePositional } from "../args.js";
import type { CliContext } from "../cli-context.js";

/** `aart remote-status <workflowId> [--remote <name>]` — local-vs-remote drift, one named remote or every configured remote when `--remote` is omitted. */
export async function remoteStatusCommand(tokens: Tokenized, cli: CliContext): Promise<HandlerResult & { next: string }> {
  const workflowId = requirePositional(tokens.positionals, 0, "workflowId");
  const remote = flagString(tokens.flags, "remote");
  const result = await remoteStatusHandler(cli.aart, { workflowId, remote });
  return wrapResult("aart_remote_status", result);
}

/** `aart remote-why <remote> <workflowId>` — what's live on that remote and why. */
export async function remoteWhyCommand(tokens: Tokenized, cli: CliContext): Promise<HandlerResult & { next: string }> {
  const remote = requirePositional(tokens.positionals, 0, "remote");
  const workflowId = requirePositional(tokens.positionals, 1, "workflowId");
  const result = await remoteWhyHandler(cli.aart, { remote, workflowId });
  return wrapResult("aart_remote_why", result);
}

/** `aart remote-runs <remote> [--status <status>]` — compact run summaries, optionally filtered (`pending|running|waiting|completed|failed|cancelled`, mirroring `GET /runs`'s own server-side `?status=` filter). Not Zod-validated here (this file's own `--status`, like every other CLI flag in this package, is trusted through to the handler/remote — matching this package's established "no CLI-layer schema validation, only the MCP `callTool` boundary has one" convention); an unrecognized value simply matches nothing server-side rather than erroring. */
export async function remoteRunsCommand(tokens: Tokenized, cli: CliContext): Promise<HandlerResult & { next: string }> {
  const remote = requirePositional(tokens.positionals, 0, "remote");
  const status = flagString(tokens.flags, "status");
  const result = await remoteRunsHandler(cli.aart, { remote, status: status as RunStatus | undefined });
  return wrapResult("aart_remote_runs", result);
}

/** `aart remote-run <remote> <runId> [--format model|markdown]` — one run's full evidence report, rendered through the exact same redaction/report seam `aart_get_report` uses locally. */
export async function remoteRunCommand(tokens: Tokenized, cli: CliContext): Promise<HandlerResult & { next: string }> {
  const remote = requirePositional(tokens.positionals, 0, "remote");
  const runId = requirePositional(tokens.positionals, 1, "runId");
  const format = flagString(tokens.flags, "format");
  const result = await remoteRunHandler(cli.aart, { remote, runId, format: format as "model" | "markdown" | undefined });
  return wrapResult("aart_remote_run", result);
}
