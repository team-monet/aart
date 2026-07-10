// classification-match.ts — "classification match", spec §24.3. Normalizes
// (trim + lowercase) before comparing, since a model's classification label
// commonly differs from the gold label only in case/whitespace.
import type { PureScorerFn } from "./types.js";

function normalizeLabel(value: unknown): string {
  return String(value).trim().toLowerCase();
}

export const classificationMatch: PureScorerFn = (actual, expected) => {
  const passed = normalizeLabel(actual) === normalizeLabel(expected);
  return { passed, score: passed ? 1 : 0, deterministic: true };
};
