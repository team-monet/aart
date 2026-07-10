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

export async function workerCommand(tokens: Tokenized, cli: CliContext, options: ProcessCommandOptions = {}): Promise<HandlerResult> {
  const handle = await cli.serverPort.startWorker({ workerId: flagString(tokens.flags, "id") });
  if (options.blocking ?? true) {
    await new Promise(() => {}); // aart worker is a long-running process — block until killed.
  }
  await handle.stop();
  return { ok: true, message: "Worker stopped." };
}

export async function serverCommand(tokens: Tokenized, cli: CliContext, options: ProcessCommandOptions = {}): Promise<HandlerResult> {
  const portFlag = flagString(tokens.flags, "port");
  const handle = await cli.serverPort.startServer({ port: portFlag ? Number(portFlag) : undefined });
  if (options.blocking ?? true) {
    await new Promise(() => {});
  }
  await handle.close();
  return { ok: true, message: "Server stopped.", port: handle.port };
}

export async function mcpCommand(_tokens: Tokenized, cli: CliContext, options: ProcessCommandOptions = {}): Promise<HandlerResult> {
  const handle = await startMcpStdioServer(cli.aart);
  if (options.blocking ?? true) {
    await new Promise(() => {}); // aart mcp serves over stdio until the client disconnects / process is killed.
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
