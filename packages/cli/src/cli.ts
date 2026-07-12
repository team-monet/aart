// run(argv) — the full CLI command surface (spec §33), dispatching to the
// SAME handler functions the MCP tool surface calls wherever an MCP tool
// exists for that action (architecture's three-clients principle).
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createSqliteStore } from "@aart/store/sqlite";
import { flagString, tokenize, type Tokenized } from "./args.js";
import { createCliContext, type CliContext, type CreateCliContextOptions } from "./cli-context.js";
import { initAgentCommand, initCommand, listCommand, registerCommand, runCommand, validateCommand } from "./commands/authoring.js";
import { deployCommand, pushCommand, triggerCommand } from "./commands/deployment.js";
import { environmentCommand } from "./commands/environment.js";
import { approveCommand, correctionCommand, diffCommand, promoteCommand, requestApprovalCommand } from "./commands/governance.js";
import { evalCommand } from "./commands/evals.js";
import { bundleCommand, flagCommand, mcpCommand, serverCommand, workerCommand } from "./commands/process.js";
import { remoteCommand } from "./commands/remote.js";
import { remoteRunCommand, remoteRunsCommand, remoteStatusCommand, remoteWhyCommand } from "./commands/remote-observability.js";

export const USAGE = `AART CLI — usage:
  aart run <workflowId> --input <json> [--version <v>]
  aart validate <path>
  aart validate <workflowId> --registered [--version <v>]
  aart list
  aart register <path>
  aart init
  aart init-agent
  aart diff <workflowId> [--from <v>] [--to <v>]
  aart correction add <runId> --step <id> --field <path> --observed <json> --corrected <json> --reason <text> --reviewer <name>
  aart correction list [--run <runId>] [--step <id>]
  aart eval create <suite> [--scorer <kind>]
  aart eval add <suite> --from-run <runId>
  aart eval run <suite> --workflow <workflowId> [--version <v>] [--min-score <n>]
  aart request-approval <workflowId> [--version <v>] [--gate humanReview|riskReview]
  aart promote <workflowId> [--version <v>]
  aart deploy <workflowId> --target <target> [--version <v>]
  aart trigger add <workflowId> --type <type>
  aart approve <taskId> --decision <approved|rejected|needs_changes> --reviewer <name>
  aart flag clear <runId> --by <name>
  aart flag list
  aart bundle <workflowId> [--version <v>] [--out <dir>] [--environment <name>]
  aart worker [--bundle <dir>] [--store fs|sqlite] [--root <dir>]
  aart server [--port <n>] [--host <addr>] [--bundle <dir>] [--environment <name>] [--store fs|sqlite] [--root <dir>]
  aart mcp [--store fs|sqlite] [--root <dir>]
  aart remote add <name> <url> --environment <envName> [--token-ref <name>]
  aart remote list
  aart remote remove <name>
  aart push <remote> <workflowId> [--version <v>] [--plan]
  aart remote-status <workflowId> [--remote <name>]
  aart remote-why <remote> <workflowId>
  aart remote-runs <remote> [--status <status>]
  aart remote-run <remote> <runId> [--format model|markdown]
  aart environment register <name> --trust-mode <dev|governed|strict|production>
  aart environment list

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

/** Resolves `--root`/`AART_ROOT`/`aartOptions.root` with the exact same precedence `resolveCliContext` applies internally (flag > env > programmatic option > `./.aart` default) — shared so `assertServerRootExists` below and the context construction it gates never disagree about which path is "the" root. */
function resolveRootOption(tokens: Tokenized, aartOptions: CreateCliContextOptions | undefined): string {
  return flagString(tokens.flags, "root") ?? process.env.AART_ROOT ?? aartOptions?.root ?? path.join(process.cwd(), ".aart");
}

/**
 * AMENDMENTS.md A47 — composition-time loud failure for `aart server`/`aart
 * worker` specifically (the two long-running, serve-existing-data
 * processes root AMENDMENTS.md A43's founder-visible bug was actually
 * about): a store root that doesn't exist yet is, for these two commands,
 * almost always a misconfiguration (a wrong or copy-pasted path), not a
 * legitimate fresh start. `@aart/store`'s fs adapter treats a missing root
 * as "zero records" on every read (`packages/store/src/adapters/fs/*.ts`'s
 * own `isEnoent`-as-empty handling, deliberately UNCHANGED here — this
 * repo's own conformance suite depends on that lazy-creation semantics,
 * and a fresh-store `aart register`/`aart init` flow needs it too, so this
 * check is scoped to the composition/launch layer, not the adapter) —
 * which is exactly how A43's founder-visible bug went unnoticed until a
 * real test drive: no error anywhere, just silent emptiness. This refuses
 * to start rather than bind a port against a store that will silently
 * look empty.
 *
 * Bypassed when `--bundle <dir>` is given (`maybeHydrateBundle`,
 * `commands/process.ts`) — hydrating a fresh root is the ENTIRE point of
 * that flag (AMENDMENTS.md A44/A45's own deploy-story proof: "a store that
 * didn't exist a moment earlier hydrates then binds"), so a missing root
 * there is the expected starting state, not a misconfiguration. Also
 * skipped whenever the caller supplies its own `options.cliContext`
 * (this package's own test suite, `cli.test.ts`'s "aart server"/"aart
 * worker" describe blocks chief among them) — a caller that already built
 * its own context has taken responsibility for its correctness; this
 * check only guards the real `--root`/`AART_ROOT`/default resolution path
 * `resolveCliContext` performs.
 */
function assertServerRootExists(tokens: Tokenized, aartOptions: CreateCliContextOptions | undefined): void {
  if (flagString(tokens.flags, "bundle")) return;
  const root = resolveRootOption(tokens, aartOptions);
  if (!existsSync(root)) {
    throw new Error(
      `Store root "${root}" does not exist. Refusing to start against a missing root — a missing root used to fail SILENTLY (the fs store adapter treats it as an empty store on every read, root AMENDMENTS.md A43/A47). If this is a fresh deployment, hydrate it first with "aart server --bundle <dir>" (or "aart worker --bundle <dir>"); otherwise point --root/AART_ROOT at the directory your data already lives in, or create it first (e.g. "aart register <path>").`,
    );
  }
}

export async function run(argv: readonly string[], options: RunOptions = {}): Promise<CliOutcome> {
  const [command, ...rest] = argv;
  const tokens = tokenize(rest);

  try {
    if (!options.cliContext && (command === "server" || command === "worker")) {
      assertServerRootExists(tokens, options.aartOptions);
    }
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
      case "remote":
        return asOutcome(await remoteCommand(tokens, cli));
      case "push":
        return asOutcome(await pushCommand(tokens, cli));
      case "remote-status":
        return asOutcome(await remoteStatusCommand(tokens, cli));
      case "remote-why":
        return asOutcome(await remoteWhyCommand(tokens, cli));
      case "remote-runs":
        return asOutcome(await remoteRunsCommand(tokens, cli));
      case "remote-run":
        return asOutcome(await remoteRunCommand(tokens, cli));
      case "environment":
        return asOutcome(await environmentCommand(tokens, cli));
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
      // AMENDMENTS.md A63 FIX 7 (optional/low-priority, tester UX) — `--help`/
      // `-h`/`help` used to fall through to `default:` below, so `aart --help`
      // printed the correct USAGE block (still embedded in the JSON `usage`
      // field) wrapped in a false `{"ok":false,"error":"Unknown command
      // \"--help\"."}` envelope, exit code 1 — misleading (not actually an
      // unknown command) and a footgun for any script that checks the exit
      // code. `bin.ts` (the real `aart` entry point) intercepts these three
      // BEFORE ever calling this function, printing USAGE as plain stdout text
      // with exit 0 (mirroring its own pre-existing zero-arg special case) —
      // this case exists for defense in depth, so a caller of `run()` directly
      // (this package's own tests, or any other embedder) gets a
      // non-misleading `{ok:true}` outcome too, not just the real CLI binary.
      case "--help":
      case "-h":
      case "help":
        return asOutcome({ ok: true, usage: USAGE });
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
