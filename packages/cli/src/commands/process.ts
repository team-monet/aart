// aart worker / aart server / aart bundle / aart flag clear|list / aart mcp.
//
// worker/server/bundle delegate to @aart/server's production logic via the
// StubServerPort (../stubs/server.ts, mirroring S2's documented exports) —
// architecture §1's note: "@aart/cli's bundle/worker/server subcommands
// each parse arguments, then call one exported function from @aart/server
// ... @aart/cli never reimplements what those functions do." `aart flag
// clear` is architecture §13.3's stated exception to the three-client
// principle (CLI/dashboard only, deliberately no MCP tool). `aart mcp`
// starts the real MCP stdio server (spec §27.2: `npx @team-monet/aart mcp`)
// — the command `aart init-agent`'s generated config actually invokes.
import { startMcpStdioServer, type HandlerResult } from "@aart/mcp";
import type { Tokenized } from "../args.js";
import { flagString, requireFlagString, requirePositional } from "../args.js";
import type { CliContext } from "../cli-context.js";

export interface ProcessCommandOptions {
  /** Defaults true (real CLI use keeps the process alive). Tests pass `false` so the command returns immediately instead of hanging the test runner. */
  blocking?: boolean;
}

/** Resolves on SIGTERM or SIGINT — how workerCommand/serverCommand's "block until killed" wait ends cleanly instead of relying on Node's default (immediate, no-cleanup) signal behavior. Registers with `once` so repeated command invocations in one process (tests) never accumulate listeners. */
function waitForShutdownSignal(): Promise<void> {
  return new Promise<void>((resolve) => {
    process.once("SIGTERM", resolve);
    process.once("SIGINT", resolve);
  });
}

export async function workerCommand(tokens: Tokenized, cli: CliContext, options: ProcessCommandOptions = {}): Promise<HandlerResult> {
  const handle = await cli.serverPort.startWorker({ workerId: flagString(tokens.flags, "id") });
  if (options.blocking ?? true) {
    await waitForShutdownSignal(); // aart worker is a long-running process — block until SIGTERM/SIGINT, then stop cleanly below.
  }
  await handle.stop();
  return { ok: true, message: "Worker stopped." };
}

export async function serverCommand(tokens: Tokenized, cli: CliContext, options: ProcessCommandOptions = {}): Promise<HandlerResult> {
  const portFlag = flagString(tokens.flags, "port");
  const handle = await cli.serverPort.startServer({ port: portFlag ? Number(portFlag) : undefined });
  if (options.blocking ?? true) {
    await waitForShutdownSignal();
  }
  await handle.close();
  return { ok: true, message: "Server stopped.", port: handle.port };
}

export async function mcpCommand(_tokens: Tokenized, cli: CliContext, options: ProcessCommandOptions = {}): Promise<HandlerResult> {
  const handle = await startMcpStdioServer(cli.aart);
  if (options.blocking ?? true) {
    // aart mcp serves over stdio until the client disconnects or the
    // process receives SIGTERM/SIGINT, whichever happens first, then stops
    // cleanly below. Three distinct disconnect signals raced together —
    // verified empirically during this session's isolated-install testing
    // (AMENDMENTS.md A42), not assumed:
    //   1. handle.transport.onclose -- the MCP SDK's own hook, fires when
    //      something calls the transport's own close() (e.g. a future SDK
    //      version, or a caller of this same process's transport directly).
    //   2. process.stdin's "end" event -- the case that actually matters in
    //      practice: @modelcontextprotocol/sdk's StdioServerTransport (as
    //      shipped in the pinned SDK version) only ever listens for stdin's
    //      "data"/"error" events, never "end" — so a client that disconnects
    //      by closing its write end of stdin (StdioClientTransport.close()'s
    //      own documented mechanism: `childProcess.stdin.end()`, no signal
    //      sent at all) is otherwise never noticed by onclose above; Node's
    //      own empty-event-loop exit then force-terminates this function's
    //      pending await with a "Detected unsettled top-level await"
    //      warning instead of a clean stop. Listening directly closes that
    //      gap regardless of the SDK's own incompleteness.
    //   3. SIGTERM/SIGINT -- a host that manages this subprocess by signal
    //      instead of by closing stdio (e.g. worker/server's own convention
    //      elsewhere in this file).
    await Promise.race([
      new Promise<void>((resolve) => {
        handle.transport.onclose = resolve;
      }),
      new Promise<void>((resolve) => process.stdin.once("end", resolve)),
      waitForShutdownSignal(),
    ]);
  }
  await handle.close();
  return { ok: true, message: "MCP server stopped." };
}

export async function bundleCommand(tokens: Tokenized, cli: CliContext): Promise<HandlerResult> {
  const workflowId = requirePositional(tokens.positionals, 0, "workflowId");
  const workflowVersion = flagString(tokens.flags, "version") ?? (await cli.aart.store.workflows.getLatest(workflowId))?.version;
  if (!workflowVersion) return { ok: false, error: `No versions found for workflow "${workflowId}".` };
  const outDir = flagString(tokens.flags, "out") ?? "./bundle";
  const bundle = await cli.serverPort.produceBundle({ workflowId, workflowVersion, environment: flagString(tokens.flags, "environment") });
  await cli.serverPort.writeBundleToDisk(bundle, outDir);
  return { ok: true, outDir, manifest: bundle.manifest };
}

export async function flagCommand(tokens: Tokenized, cli: CliContext): Promise<HandlerResult> {
  const [subcommand, ...rest] = tokens.positionals;
  if (subcommand === "clear") {
    const runId = requirePositional(rest, 0, "runId");
    const clearedBy = requireFlagString(tokens.flags, "by");
    const result = await cli.serverPort.clearRunFlag(runId, clearedBy);
    return { ok: result.kind === "cleared", result };
  }
  if (subcommand === "list") {
    const runs = await cli.serverPort.listFlaggedRuns();
    return { ok: true, runs };
  }
  return { ok: false, error: "Usage: aart flag clear <runId> --by <name> | aart flag list" };
}
