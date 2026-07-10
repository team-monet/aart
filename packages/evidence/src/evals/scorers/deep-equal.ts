// deep-equal.ts — a small, dependency-free structural-equality helper shared
// by exact_match/jsonpath_exact/jsonpath_contains. Handles primitives
// (including NaN/±0 via Object.is), arrays, and plain objects; deliberately
// does not special-case Map/Set/Date/etc. — scorer inputs/expected values
// are eval-example JSON data (spec §24.2's `input`/`expected: unknown`,
// always JSON-serializable in practice), not arbitrary JS values.
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  const aKeys = Object.keys(aRecord);
  const bKeys = Object.keys(bRecord);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) => Object.hasOwn(bRecord, k) && deepEqual(aRecord[k], bRecord[k]));
}
