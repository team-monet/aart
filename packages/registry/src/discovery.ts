// Discovery — architecture §11.4, spec §44.3. "This is the hard part the
// founder's notes flag directly... the authoring loop's first step becomes
// search before you build."
//
// Neither source document gives `aart_find_blocks` a literal TS signature
// anywhere — it's named only in prose (architecture §11.4: "`aart_find_blocks`
// search + per-block `Example[]`... accepting a `scope: 'local'|'remote'`
// parameter"). This module is this package's own reasonable fill for that
// gap, the same way S0 designed AartStore's per-member method shapes
// (AMENDMENTS.md A1) — `@aart/mcp` (S5)'s actual `aart_find_blocks` MCP
// tool is expected to be a thin caller of `findBlocks` below, not a
// reimplementation of the search itself.
import type { BlockManifest, Example } from "@aart/types";

/**
 * A block as it appears in a search result. `BlockManifest` (frozen,
 * `@aart/types`) has no `examples` field of its own — only `Workflow`
 * does (spec §14.1) — so rather than widen the frozen S0 type for a need
 * that is entirely local to how DISCOVERY shapes its results, `examples`
 * is composed on here, at the registry-package level, reusing the
 * already-frozen `Example` type. See this session's report for the
 * fuller rationale (a locally-composed search-result type vs. amending
 * `@aart/types`).
 */
export interface BlockCatalogEntry {
  readonly manifest: BlockManifest;
  /** undefined for a core (`@aart/blocks-core`/`@aart/llm`) built-in; set to the owning pack's short name for a pack-delivered block. */
  readonly packName?: string;
  readonly examples: readonly Example[];
}

export interface BlockSearchResult extends BlockCatalogEntry {
  /** Higher is a better match. Ties broken by `manifest.id` for deterministic ordering. */
  readonly score: number;
}

export type DiscoveryScope = "local" | "remote";

/** v1 remote discovery index (architecture §11.4's own `[DECISION]`): "a static JSON index file... listing every published `aart-pack-*` with its manifest summary... searched client-side." One entry per published pack. */
export interface RemoteRegistryIndexEntry {
  readonly npmPackageName: string;
  readonly packName: string;
  readonly version: string;
  readonly description?: string;
  readonly blocks: readonly BlockCatalogEntry[];
}

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s._-]+/)
    .filter(Boolean);
}

function scoreEntry(entry: BlockCatalogEntry, tokens: string[]): number {
  if (tokens.length === 0) return 1; // empty query matches everything, uniformly — a deliberate "list everything" mode, not "match nothing"
  const id = entry.manifest.id.toLowerCase();
  const haystack = [id, entry.manifest.description, entry.manifest.category ?? "", entry.packName ?? "", ...entry.examples.map((e) => e.description)]
    .join(" ")
    .toLowerCase();

  let score = 0;
  for (const token of tokens) {
    if (id === token) score += 10;
    else if (id.includes(token)) score += 5;
    else if (haystack.includes(token)) score += 1;
  }
  return score;
}

function rank(entries: readonly BlockCatalogEntry[], query: string): BlockSearchResult[] {
  const tokens = tokenize(query);
  return entries
    .map((entry) => ({ ...entry, score: scoreEntry(entry, tokens) }))
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score || a.manifest.id.localeCompare(b.manifest.id));
}

/** Local search — spec §44.3's "locally" half: "searchable against the local + installed catalog." */
export function searchLocalCatalog(catalog: readonly BlockCatalogEntry[], query: string): BlockSearchResult[] {
  return rank(catalog, query);
}

/** Remote search — spec §44.3's "remotely" half: "the public registry exposes the SAME search surface... over the full public catalog instead of just the local one." */
export function searchRemoteIndex(index: readonly RemoteRegistryIndexEntry[], query: string): BlockSearchResult[] {
  const allBlocks = index.flatMap((pack) => pack.blocks.map((block) => ({ ...block, packName: block.packName ?? pack.packName })));
  return rank(allBlocks, query);
}

export interface FindBlocksInput {
  readonly query: string;
  readonly scope: DiscoveryScope;
  readonly localCatalog?: readonly BlockCatalogEntry[];
  readonly remoteIndex?: readonly RemoteRegistryIndexEntry[];
}

/**
 * `aart_find_blocks`-shaped search (architecture §11.4/§44.3): "the
 * interface (`aart_find_blocks` accepting a `scope: 'local'|'remote'`
 * parameter) ships in v1." A block discovered this way comes with a
 * runnable usage pattern (`examples`), not just a schema — spec §44.3's
 * stated reason per-block examples matter for discovery at all.
 */
export function findBlocks(input: FindBlocksInput): BlockSearchResult[] {
  if (input.scope === "local") {
    return searchLocalCatalog(input.localCatalog ?? [], input.query);
  }
  return searchRemoteIndex(input.remoteIndex ?? [], input.query);
}
