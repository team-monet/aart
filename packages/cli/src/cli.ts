// run(argv) — the full CLI command surface (spec §33), dispatching to the
// SAME handler functions the MCP tool surface calls wherever an MCP tool
// exists for that action (architecture's three-clients principle).
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createSqliteStore } from "@aart/store/sqlite";
import { flagString, tokenize, type Tokenized } from "./args.js";
import { createCliContext, type CliContext, type CreateCliContextOptions } from "./cli-context.js";
import { initAgentCommand, initCommand, listCommand, registerCommand, runCommand, validateCommand } from "./commands/authoring.js";
import { deployCommand, triggerCommand } from "./commands/deployment.js";
import { approveCommand, correctionCommand, diffCommand, promoteCommand, requestApprovalCommand } from "./commands/governance.js";
import { evalCommand } from "./commands/evals.js";
import { bundleCommand, flagCommand, mcpCommand, serverCommand, workerCommand } from "./commands/process.js";

export const USAGE = `AART CLI — usage:
  aart run <workflowId> --input <json> [--version <v>]
  aart validate <path>
  aart list
  aart register <path>
  aart init
  aart init-agent
  aart diff <workflowId> [--from <v>] [--to <v>]
  aart correction add <runId> --step <id> --field <path> --observed <json> --corrected <json> --reason <text> --reviewer <name>
  aart correction list [--run <runId>] [--step <id>]
  aart eval create <suite> [--scorer <kind>]
  aart eval add <suite> --from-run <runId>
  aart eval run <suite> --workflow <workflowId> [--version <v>]
  aart request-approval <workflowId> [--version <v>]
  aart promote <workflowId> [--version <v>]
  aart deploy <workflowId> --target <target> [--version <v>]
  aart trigger add <workflowId> --type <type>
  aart approve <taskId> --decision <approved|rejected|needs_changes> --reviewer <name>
  aart flag clear <runId> --by <name>
  aart flag list
  aart bundle <workflowId> [--version <v>] [--out <dir>] [--environment <name>]
  aart worker [--bundle <dir>] [--store fs|sqlite] [--root <dir>]
  aart server [--port <n>] [--bundle <dir>] [--environment <name>] [--store fs|sqlite] [--root <dir>]
  aart mcp [--store fs|sqlite] [--root <dir>]

  --root <dir>    (or AART_ROOT) the .aart store directory. Precedence: flag > env > ./.aart. Also honored by every command above, not only the ones listed.
  --store <kind>  fs (default) or sqlite — which @aart/store adapter backs this invocation. sqlite's db file lives at <root>/aart.db.
`;

export interface RunOptions {
  /** Reuse an already-constructed CLI context (tests: an isolated tmp-dir store). */
  cliContext?: CliContext;
  aartOptions?: CreateCliContextOptions;
  /** Threaded to worker/server/mcp — false makes them return immediately instead of blocking forever. Defaults true (real CLI use). */
  blocking?: boolean;
}

export interface CliOutcome {
  ok: boolean;
  exitCode: number;
  result: unknown;
}

function asOutcome(result: { ok?: boolean } & Record<string, unknown>): CliOutcome {
  const ok = result.ok === true;
  return { ok, exitCode: ok ? 0 : 1, result };
}

/**
 * Folds `--root <dir>` / `AART_ROOT` and `--store fs|sqlite` (AMENDMENTS.md
 * A45) into `aartOptions` before constructing the CLI context. Documented
 * on server/worker/run/mcp/init-agent specifically (the brief's own
 * enumerated list — the commands where a non-default store/root actually
 * matters in practice), but resolved once HERE for every command uniformly
 * rather than duplicated per-command: `run()` only ever builds one context
 * per invocation regardless of which command dispatches, so this is the one
 * correct place, and it's a strict superset — a command this wasn't
 * explicitly asked for (e.g. `aart list --root ./other`) simply also works,
 * and the default (neither flag/env given) is byte-for-byte what every
 * command already did before this function existed.
 *
 * Precedence for both flags: explicit `--flag` > env var > default — same
 * order the brief specifies for `--root`, applied consistently to `--store`
 * even though the brief only documented a flag for it (no env var was
 * asked for, so none is invented here).
 *
 * `--store sqlite`'s db file lives AT `<root>/aart.db` (under the store
 * root, matching `--root`'s own "under the store root" framing) —
 * constructed here, BEFORE `createCliContext`, and handed in via
 * `aartOptions.store` (the override seam `createAartContext`/
 * `createRealAartContextWithEngine` already document: "Ignored if `store`
 * is supplied" — context.ts) rather than making `createCliContext` itself
 * async-aware of store KIND. `createSqliteStore` is the only async
 * construction step in this whole path; skipped entirely if the caller
 * already supplied an explicit `store` override (tests, `{ real: false }`
 * callers) — that override always wins.
 */
async function resolveCliContext(tokens: Tokenized, aartOptions: CreateCliContextOptions | undefined): Promise<CliContext> {
  const root = flagString(tokens.flags, "root") ?? process.env.AART_ROOT ?? aartOptions?.root;
  const storeFlag = flagString(tokens.flags, "store");
  if (storeFlag !== undefined && storeFlag !== "fs" && storeFlag !== "sqlite") {
    throw new Error(`--store must be "fs" or "sqlite" (got "${storeFlag}").`);
  }

  if (storeFlag === "sqlite" && !aartOptions?.store) {
    const resolvedRoot = root ?? path.join(process.cwd(), ".aart");
    await mkdir(resolvedRoot, { recursive: true });
    const store = await createSqliteStore(path.join(resolvedRoot, "aart.db"));
    return createCliContext({ ...aartOptions, root: resolvedRoot, store });
  }

  return createCliContext({ ...aartOptions, root });
}

export async function run(argv: readonly string[], options: RunOptions = {}): Promise<CliOutcome> {
  const [command, ...rest] = argv;
  const tokens = tokenize(rest);

  try {
    const cli = options.cliContext ?? (await resolveCliContext(tokens, options.aartOptions));
    switch (command) {
      case "run":
        return asOutcome(await runCommand(tokens, cli));
      case "validate":
        return asOutcome(await validateCommand(tokens, cli));
      case "list":
        return asOutcome(await listCommand(tokens, cli));
      case "register":
        return asOutcome(await registerCommand(tokens, cli));
      case "init":
        return asOutcome(await initCommand(tokens, cli));
      case "init-agent":
        return asOutcome(await initAgentCommand(tokens, cli));
      case "diff":
        return asOutcome(await diffCommand(tokens, cli));
      case "correction":
        return asOutcome(await correctionCommand(tokens, cli));
      case "eval":
        return asOutcome(await evalCommand(tokens, cli));
      case "request-approval":
        return asOutcome(await requestApprovalCommand(tokens, cli));
      case "promote":
        return asOutcome(await promoteCommand(tokens, cli));
      case "deploy":
        return asOutcome(await deployCommand(tokens, cli));
      case "trigger":
        return asOutcome(await triggerCommand(tokens, cli));
      case "approve":
        return asOutcome(await approveCommand(tokens, cli));
      case "flag":
        return asOutcome(await flagCommand(tokens, cli));
      case "bundle":
        return asOutcome(await bundleCommand(tokens, cli));
      case "worker":
        return asOutcome(await workerCommand(tokens, cli, { blocking: options.blocking }));
      case "server":
        return asOutcome(await serverCommand(tokens, cli, { blocking: options.blocking }));
      case "mcp":
        return asOutcome(await mcpCommand(tokens, cli, { blocking: options.blocking }));
      case undefined:
        return asOutcome({ ok: false, error: "No command given.", usage: USAGE });
      default:
        return asOutcome({ ok: false, error: `Unknown command "${command}".`, usage: USAGE });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return asOutcome({ ok: false, error: message });
  }
}
