// remotes.json — D1 "remotes + push" (AMENDMENTS.md A56), D-4 of the design
// memo: git-style named remotes, `<root>/remotes.json`, sibling to
// `secrets.json` (secrets.ts's own `secretsFilePath` establishes this
// store-root-sibling-file convention; `.aart/` is already gitignored — no
// gitignore change needed for this new file either).
//
// CLI-only — this module owns the WRITE side (`aart remote add/remove`,
// commands/remote.ts) as well as reads for `aart remote list`. `ctx.remotes`
// (the AartContext port `@aart/mcp`'s `types.ts` defines, real-implemented
// in that package's own `real-context.ts`) is a SEPARATE, read-only
// implementation — @aart/mcp cannot import this file (the dependency runs
// the other way: @aart/cli depends on @aart/mcp, never the reverse), so its
// real port mirrors this file's tiny JSON-read shape independently rather
// than sharing code across that boundary. Both read the identical on-disk
// format; see that package's own doc comment for the full reasoning.
import { promises as fs } from "node:fs";
import { join } from "node:path";

export interface RemoteEntry {
  url: string;
  environment: string;
  tokenRef?: string;
}

/** `{ "<name>": RemoteEntry }` — the entire file's shape; `aart remote add`/`remove` upsert/delete one key at a time. */
export type RemoteConfig = Record<string, RemoteEntry>;

function remotesFilePath(root: string): string {
  return join(root, "remotes.json");
}

/** Returns `{}` (never throws) when `remotes.json` doesn't exist yet — the common case before a first `aart remote add` — or is malformed, matching this codebase's established "a missing/bad config file is an empty result, not a crash" discipline (secrets.ts's `createRealSecretResolver`). */
export async function readRemotes(root: string): Promise<RemoteConfig> {
  try {
    const raw = await fs.readFile(remotesFilePath(root), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as RemoteConfig;
  } catch {
    return {};
  }
}

export async function writeRemotes(root: string, config: RemoteConfig): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(remotesFilePath(root), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}
