// run(argv) — the full CLI command surface (spec §33), dispatching to the
// SAME handler functions the MCP tool surface calls wherever an MCP tool
// exists for that action (architecture's three-clients principle).
import { tokenize } from "./args.js";
import { createCliContext, type CliContext, type CreateCliContextOptions } from "./cli-context.js";
import { initAgentCommand, initCommand, listCommand, registerCommand, runCommand, validateCommand } from "./commands/authoring.js";
import { deployCommand, triggerCommand } from "./commands/deployment.js";
import { approveCommand, correctionCommand, diffCommand, promoteCommand } from "./commands/governance.js";
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
  aart promote <workflowId> [--version <v>]
  aart deploy <workflowId> --target <target> [--version <v>]
  aart trigger add <workflowId> --type <type>
  aart approve <taskId> --decision <approved|rejected|needs_changes> --reviewer <name>
  aart flag clear <runId> --by <name>
  aart flag list
  aart bundle <workflowId> [--version <v>] [--out <dir>] [--environment <name>]
  aart worker
  aart server [--port <n>]
  aart mcp
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

export async function run(argv: readonly string[], options: RunOptions = {}): Promise<CliOutcome> {
  const cli = options.cliContext ?? createCliContext(options.aartOptions);
  const [command, ...rest] = argv;
  const tokens = tokenize(rest);

  try {
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
