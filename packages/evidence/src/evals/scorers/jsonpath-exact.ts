// jsonpath-exact.ts — "JSONPath exact", spec §24.3 (F6 fix: distinct from
// jsonpath_contains below, previously conflated into one kind).
import { deepEqual } from "./deep-equal.js";
import { extractPath } from "./jsonpath-config.js";
import { jsonPathQuery, pathEndsInWildcard } from "./jsonpath-lite.js";
import type { PureScorerFn } from "./types.js";

/**
 * Extracts `config.path` from `actual`. Passes iff there is exactly one
 * match and it deep-equals `expected` — UNLESS the path itself ends in a
 * wildcard token (`[*]`/`.*`), in which case it passes iff the full ARRAY
 * of matches deep-equals `expected` (an "exact" comparison of the whole
 * matched set, not a single-element one).
 */
export const jsonpathExact: PureScorerFn = (actual, expected, config) => {
  const path = extractPath(config);
  const matches = jsonPathQuery(actual, path);

  if (pathEndsInWildcard(path)) {
    const passed = deepEqual(matches, expected);
    return { passed, score: passed ? 1 : 0, deterministic: true, detail: `${matches.length} wildcard match(es) at "${path}"` };
  }
  if (matches.length !== 1) {
    return { passed: false, score: 0, deterministic: true, detail: `expected exactly 1 match at "${path}", got ${matches.length}` };
  }
  const passed = deepEqual(matches[0], expected);
  return { passed, score: passed ? 1 : 0, deterministic: true };
};
