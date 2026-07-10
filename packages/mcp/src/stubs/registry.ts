// StubRegistry — mirrors @aart/registry's real, documented `findBlocks`
// signature (S7 SEAMS.md R2: `findBlocks(input: { query, scope,
// localCatalog?, remoteIndex? }): BlockSearchResult[]`), narrowed to the
// local-scope-only shape @aart/mcp/@aart/cli need (this worktree has no
// remote registry index to search — that's @aart/registry's §44.3 concern).
// Real @aart/registry is still an S0 `export {}` stub here (S7 builds it in
// the concurrent, unmerged /Users/johnlee/code/aart-s7); at merge time this
// module is superseded by a real `findBlocks` import fed the real
// blocks-core + pack-manifest-derived catalog, per S7's own SEAMS note.
//
// Matching algorithm: simple substring/fuzzy scoring over id/description/
// category, plus spec §32.5's NATIVE_ALIASES table (catalog.ts) — the same
// "no embedding-based semantic match in v1" choice architecture §10.5 makes
// for recipe matching (recipes.ts), applied here too since neither doc asks
// for anything more than lexical matching in the discovery tools either.
import type { BlockCatalogEntry, BlockSearchResult, RegistryPort } from "../types.js";
import { NATIVE_ALIASES } from "../catalog.js";
import { STOPWORDS } from "../recipes.js";

/** Whole-word tokens only — plain `.includes()` on short tokens would false-positive-match inside an unrelated word (e.g. "on" inside "python"). */
function wordSet(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9.]+/).filter(Boolean));
}

function score(entry: BlockCatalogEntry, query: string, category?: string): number {
  if (category && entry.manifest.category !== category) return 0;
  const q = query.trim().toLowerCase();
  if (q.length === 0) return 1;

  let best = 0;
  const id = entry.manifest.id.toLowerCase();
  const description = entry.manifest.description.toLowerCase();

  if (id === q) best = Math.max(best, 100);
  else if (id.includes(q) || q.includes(id)) best = Math.max(best, 60);

  // alias table: an exact alias phrase match resolves directly to its block
  // id (or block-id prefix, e.g. "assert.*").
  const aliasTarget = NATIVE_ALIASES[q];
  if (aliasTarget && (aliasTarget === id || (aliasTarget.endsWith(".*") && id.startsWith(aliasTarget.slice(0, -1))))) {
    best = Math.max(best, 90);
  }

  if (description.includes(q)) best = Math.max(best, 40);

  // token-overlap fallback — a query like "click a button" should still
  // surface browser.click via shared words even without a substring hit.
  // Whole-word matching (wordSet), not raw .includes(), and stopword-length
  // tokens excluded — same false-positive class recipes.ts's phraseScore
  // guards against (a short token like "on" must not match inside "python").
  const descriptionWords = wordSet(description);
  const idWords = wordSet(id.replace(/\./g, " "));
  const queryTokens = q.split(/\s+/).filter((t) => t.length > 2 && !STOPWORDS.has(t));
  const overlap = queryTokens.filter((t) => descriptionWords.has(t) || idWords.has(t)).length;
  if (overlap > 0) best = Math.max(best, 10 + overlap * 5);

  return best;
}

export function createStubRegistry(catalog: readonly BlockCatalogEntry[]): RegistryPort {
  return {
    findBlocks(input: { query: string; category?: string }): BlockSearchResult[] {
      return catalog
        .map((entry) => ({ entry, score: score(entry, input.query, input.category) }))
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score);
    },
    listBlocks(): readonly BlockCatalogEntry[] {
      return catalog;
    },
    getBlock(id: string): BlockCatalogEntry | undefined {
      return catalog.find((e) => e.manifest.id === id);
    },
  };
}
