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
    const result = await findPacksHandler(cli.aart, {
      query,
      indexUrl: flagString(tokens.flags, "index-url"),
    });
    return {
      ...wrapResult("aart_find_packs", result),
      next: result.matched && result.indexMode === "preview"
        ? "These are preview catalog fixtures, not published packages. Prepare and publish a real Pack before installation."
        : result.matched
          ? "Choose the closest result, then run `aart pack add <name> --version <version>`."
        : "Broaden the query or prepare the smallest reusable Pack with `aart pack prepare <directory>`.",
    };
  }
  if (action === "add") {
    const name = requirePositional(tokens.positionals, 1, "pack name");
    const result = await installPackHandler(cli.aart, {
      name,
      version: flagString(tokens.flags, "version"),
      sourcePath: flagString(tokens.flags, "from"),
    });
    return {
      ...wrapResult("aart_install_pack", result),
      next: result.ok
        ? "Run `aart pack list --status unapproved`, inspect the exact seal, and ask a human before approval."
        : "Verify the Pack name, version, or local source directory, then run `aart pack add` again.",
    };
  }
  if (action === "list") {
    const status = flagString(tokens.flags, "status");
    if (status && status !== "unapproved" && status !== "approved") {
      throw new Error('--status must be "unapproved" or "approved"');
    }
    const result = await listPacksHandler(cli.aart, {
      status: status as "unapproved" | "approved" | undefined,
    });
    const first = Array.isArray(result.packs)
      ? (result.packs as Array<{
          name?: string;
          version?: string;
          contentHash?: string;
          approvalStatus?: string;
        }>).find((pack) => pack.approvalStatus === "unapproved")
      : undefined;
    return {
      ...wrapResult("aart_list_packs", result),
      next:
        first?.name && first.version && first.contentHash
          ? `After explicit review, run \`aart pack approve ${first.name} --version ${first.version} --content-hash ${first.contentHash} --reviewer <name>\`.`
          : "Install a reusable Pack with `aart pack add <name>` or search with `aart pack search`.",
    };
  }
  if (action === "approve") {
    const name = requirePositional(tokens.positionals, 1, "pack name");
    const version = flagString(tokens.flags, "version");
    const contentHash = flagString(tokens.flags, "content-hash");
    const reviewer = flagString(tokens.flags, "reviewer");
    if (!version || !contentHash || !reviewer) {
      throw new Error("pack approve requires --version, --content-hash, and --reviewer");
    }
    const result = await approvePackHandler(cli.aart, { name, version, contentHash, reviewer });
    return {
      ...wrapResult("aart_approve_pack", result),
      next: result.ok
        ? "Restart AART, then run `aart find-blocks` or `aart find-workflows` to reuse the approved assets."
        : "Run `aart pack list --status unapproved`, review the current seal, and resolve the reported conflict.",
    };
  }
  if (action === "prepare") {
    const sourcePath = requirePositional(tokens.positionals, 1, "pack source path");
    const result = await preparePackHandler(
      cli.aart,
      {
        sourcePath,
        outputPath: flagString(tokens.flags, "out"),
      },
      { allowArbitraryOutputPath: true },
    );
    return {
      ...wrapResult("aart_prepare_pack", result),
      next: result.ok
        ? "Review the generated index entry, publish with `npm publish`, then add that entry to the public index."
        : "Fix the package identity or declared assets, then run `aart pack prepare <directory>` again.",
    };
  }
  return { ok: false, error: `Unknown pack action "${action}". Use search, add, list, approve, or prepare.` };
}
