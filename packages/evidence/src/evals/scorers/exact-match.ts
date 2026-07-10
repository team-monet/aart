// exact-match.ts — "exact match", first of spec §24.3's 12 built-in scorer kinds.
import { deepEqual } from "./deep-equal.js";
import type { PureScorerFn } from "./types.js";

export const exactMatch: PureScorerFn = (actual, expected) => {
  const passed = deepEqual(actual, expected);
  return { passed, score: passed ? 1 : 0, deterministic: true };
};
