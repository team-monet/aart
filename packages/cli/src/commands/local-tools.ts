import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  checkToolHandler,
  findToolsHandler,
  getToolRunHandler,
  listToolRunsHandler,
  registerToolHandler,
  runToolHandler,
  wrapResult,
  type HandlerResult,
} from "@aart/mcp";
import { flagString, requirePositional, type Tokenized } from "../args.js";
import type { CliContext } from "../cli-context.js";

function parseInputs(tokens: Tokenized): Record<string, string> | undefined {
  const raw = flagString(tokens.flags, "input");
  if (!raw) return undefined;
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("--input must be a JSON object of string values");
  }
  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value !== "string") throw new Error(`tool input "${name}" must be a string`);
  }
  return parsed as Record<string, string>;
}

function parsePrerequisiteHashes(tokens: Tokenized): Record<string, string> {
  const raw = flagString(tokens.flags, "prerequisite-hashes");
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("--prerequisite-hashes must be a JSON object mapping prerequisite names to sha256 hashes");
  }
  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
      throw new Error(`prerequisite hash "${name}" must be a sha256:<64 lowercase hex> string`);
    }
  }
  return parsed as Record<string, string>;
}

export async function findToolsCommand(tokens: Tokenized, cli: CliContext): Promise<HandlerResult & { next: string }> {
  const scope = flagString(tokens.flags, "scope");
  if (scope && scope !== "local" && scope !== "remote" && scope !== "all") {
    throw new Error('--scope must be "local", "remote", or "all"');
  }
  const result = await findToolsHandler(cli.aart, {
    query: tokens.positionals.join(" "),
    scope: scope as "local" | "remote" | "all" | undefined,
    indexUrl: flagString(tokens.flags, "index-url"),
  });
  return {
    ...wrapResult("aart_find_tools", result),
  };
}

export async function localToolCommand(tokens: Tokenized, cli: CliContext): Promise<HandlerResult & { next?: string }> {
  const action = requirePositional(tokens.positionals, 0, "tool action");
  if (action === "register") {
    const path = resolve(requirePositional(tokens.positionals, 1, "tool manifest path"));
    const result = await registerToolHandler(cli.aart, {
      tool: await readFile(path, "utf8"),
      sourcePath: path,
    });
    return {
      ...wrapResult("aart_register_tool", result),
      next: result.ok
        ? "Run `aart find-tools <task wording>` to verify fresh-session discovery."
        : "Fix the manifest or immutable version conflict, then register again.",
    };
  }
  if (action === "check") {
    const id = requirePositional(tokens.positionals, 1, "tool id");
    const result = await checkToolHandler(cli.aart, {
      id,
      version: flagString(tokens.flags, "version"),
      inputs: parseInputs(tokens),
    });
    return {
      ...wrapResult("aart_check_tool", result),
      next: result.ok
        ? "Review the command, authority, effects, contentHash, executable contentHash, argvHash, cwdHash, and prerequisite hashes before running it."
        : "Install or configure the reported prerequisite, then check again.",
    };
  }
  if (action === "run") {
    const id = requirePositional(tokens.positionals, 1, "tool id");
    const contentHash = flagString(tokens.flags, "content-hash");
    const executableHash = flagString(tokens.flags, "executable-hash");
    const argvHash = flagString(tokens.flags, "argv-hash");
    const cwdHash = flagString(tokens.flags, "cwd-hash");
    if (!contentHash || !executableHash || !argvHash || !cwdHash) {
      throw new Error(
        "tool run requires --content-hash, --executable-hash, --argv-hash, and --cwd-hash from one reviewed `aart tool check` result",
      );
    }
    const result = await runToolHandler(cli.aart, {
      id,
      version: flagString(tokens.flags, "version"),
      inputs: parseInputs(tokens),
      contentHash,
      executableHash,
      argvHash,
      cwdHash,
      prerequisiteHashes: parsePrerequisiteHashes(tokens),
    });
    return wrapResult("aart_run_tool", result);
  }
  if (action === "report") {
    const runId = requirePositional(tokens.positionals, 1, "local tool run id");
    return wrapResult("aart_get_tool_run", await getToolRunHandler(cli.aart, { runId }));
  }
  if (action === "runs") {
    const status = flagString(tokens.flags, "status");
    if (status !== undefined && status !== "running" && status !== "terminal") {
      throw new Error('--status must be "running" or "terminal"');
    }
    return wrapResult(
      "aart_list_tool_runs",
      await listToolRunsHandler(cli.aart, {
        toolId: flagString(tokens.flags, "tool-id"),
        status: status as "running" | "terminal" | undefined,
      }),
    );
  }
  return { ok: false, error: `Unknown tool action "${action}". Use register, check, run, report, or runs.` };
}
