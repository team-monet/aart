// Errors-as-corrections (architecture §7.7, spec §32.2b): "didYouMean is
// computed via edit distance (Levenshtein or similar) against the union of
// (a) the real block catalog and (b) the §32.5 alias table."
//
// Neither S3's real @aart/blocks-core catalog nor spec §32.5's full alias
// table is available in this Wave-1 worktree (a concurrent sibling session
// / a spec section outside this session's own reading list) — this
// session's own DoD explicitly anticipates that: "this test necessarily
// depends on S3's block catalog existing or a fixture catalog stub — flag
// as a same-wave convergence point if S3 lags." This module is generic
// over both (catalog + alias table are caller-supplied), and this
// package's own tests supply a small fixture standing in for both.

function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Two-row rolling DP — O(min(a,b)) memory.
  let previousRow = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const currentRow = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      currentRow.push(
        Math.min(
          (currentRow[j - 1] ?? Infinity) + 1, // insertion
          (previousRow[j] ?? Infinity) + 1, // deletion
          (previousRow[j - 1] ?? Infinity) + cost, // substitution
        ),
      );
    }
    previousRow = currentRow;
  }
  return previousRow[b.length] ?? Math.max(a.length, b.length);
}

export interface DidYouMeanOptions {
  /** Maximum edit distance to accept as a suggestion. Defaults to a length-scaled threshold (roughly a third of the input's length, minimum 2) so a wildly-off guess doesn't produce a misleading suggestion. */
  maxDistance?: number;
}

/**
 * Suggests the closest match for `input` against (a) an alias table
 * (checked FIRST, by exact phrase match — architecture §7.7's own example:
 * "a model writing `browser.open` ... gets suggested `browser.goto`,
 * sourced from the alias table entry 'open page -> browser.goto'" — an
 * alias table entry maps a natural-language PHRASE to a real id, so an
 * exact match there always wins over edit distance) then (b) the real
 * catalog by edit distance. Returns undefined if nothing is close enough.
 */
export function computeDidYouMean(
  input: string,
  catalog: readonly string[],
  aliasTable: Readonly<Record<string, string>> = {},
  options: DidYouMeanOptions = {},
): string | undefined {
  const aliasHit = aliasTable[input];
  if (aliasHit) return aliasHit;

  const maxDistance = options.maxDistance ?? Math.max(2, Math.floor(input.length / 3));
  let best: { candidate: string; distance: number } | undefined;
  for (const candidate of catalog) {
    const distance = levenshteinDistance(input, candidate);
    if (distance > maxDistance) continue;
    if (!best || distance < best.distance) best = { candidate, distance };
  }
  return best?.candidate;
}

export { levenshteinDistance };
