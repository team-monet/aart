import {
  approvePackHandler,
  findPacksHandler,
  installPackHandler,
  listPacksHandler,
  preparePackHandler,
  wrapResult,
  type HandlerResult,
} from "@aart/mcp";
import type { Tokenized } from "../args.js";
import { flagString, requirePositional } from "../args.js";
import type { CliContext } from "../cli-context.js";

export async function packCommand(tokens: Tokenized, cli: CliContext): Promise<HandlerResult & { next?: string }> {
  const action = requirePositional(tokens.positionals, 0, "pack action");
  if (action === "search") {
    const query = tokens.positionals.slice(1).join(" ");
    return wrapResult(
      "aart_find_packs",
      await findPacksHandler(cli.aart, { query, indexUrl: flagString(tokens.flags, "index-url") }),
    );
  }
  if (action === "add") {
    const name = requirePositional(tokens.positionals, 1, "pack name");
    return wrapResult(
      "aart_install_pack",
      await installPackHandler(cli.aart, {
        name,
        version: flagString(tokens.flags, "version"),
        sourcePath: flagString(tokens.flags, "from"),
      }),
    );
  }
  if (action === "list") {
    const status = flagString(tokens.flags, "status");
    if (status && status !== "unapproved" && status !== "approved") {
      throw new Error('--status must be "unapproved" or "approved"');
    }
    return wrapResult(
      "aart_list_packs",
      await listPacksHandler(cli.aart, { status: status as "unapproved" | "approved" | undefined }),
    );
  }
  if (action === "approve") {
    const name = requirePositional(tokens.positionals, 1, "pack name");
    const version = flagString(tokens.flags, "version");
    const reviewer = flagString(tokens.flags, "reviewer");
    if (!version || !reviewer) throw new Error("pack approve requires --version and --reviewer");
    return wrapResult("aart_approve_pack", await approvePackHandler(cli.aart, { name, version, reviewer }));
  }
  if (action === "prepare") {
    const sourcePath = requirePositional(tokens.positionals, 1, "pack source path");
    return wrapResult(
      "aart_prepare_pack",
      await preparePackHandler(cli.aart, { sourcePath, outputPath: flagString(tokens.flags, "out") }),
    );
  }
  return { ok: false, error: `Unknown pack action "${action}". Use search, add, list, approve, or prepare.` };
}
