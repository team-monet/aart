// jsonpath-contains.ts — "JSONPath contains", spec §24.3 (F6 fix: distinct
// from jsonpath_exact above).
import { deepEqual } from "./deep-equal.js";
import { extractPath } from "./jsonpath-config.js";
import { jsonPathQuery } from "./jsonpath-lite.js";
import type { PureScorerFn } from "./types.js";

/**
 * Extracts `config.path` from `actual`. Passes iff any extracted match
 * "contains" `expected`: for a multi-match (wildcard) result, iff any
 * element deep-equals `expected`; for a single string match, iff it
 * contains `expected` as a substring; for any other single match, iff it
 * deep-equals `expected` (degrading to the same behavior as jsonpath_exact's
 * single-match case).
 */
export const jsonpathContains: PureScorerFn = (actual, expected, config) => {
  const path = extractPath(config);
  const matches = jsonPathQuery(actual, path);

  if (matches.length === 0) {
    return { passed: false, score: 0, deterministic: true, detail: `no matches at "${path}"` };
  }
  if (matches.length === 1) {
    const only = matches[0];
    if (typeof only === "string" && typeof expected === "string") {
      const passed = only.includes(expected);
      return { passed, score: passed ? 1 : 0, deterministic: true };
    }
    const passed = deepEqual(only, expected);
    return { passed, score: passed ? 1 : 0, deterministic: true };
  }
  const passed = matches.some((m) => deepEqual(m, expected));
  return { passed, score: passed ? 1 : 0, deterministic: true, detail: `${matches.length} candidate match(es) at "${path}"` };
};
