// field-level-accuracy.ts — "field-level accuracy", spec §24.3. The one
// built-in kind whose score is naturally graded (fraction of fields
// correct) rather than a plain 0/1 mirroring `passed`.
import { deepEqual } from "./deep-equal.js";
import type { PureScorerFn } from "./types.js";

export interface FieldLevelAccuracyConfig {
  /** Fraction of fields that must match for `passed` to be true. Defaults to 1 (every field must match). */
  passThreshold?: number;
  /** Restrict the comparison to these field names. Defaults to every key of `expected`. */
  fields?: string[];
}

export const fieldLevelAccuracy: PureScorerFn = (actual, expected, config) => {
  const cfg = config as FieldLevelAccuracyConfig | undefined;
  if (typeof expected !== "object" || expected === null || Array.isArray(expected)) {
    throw new Error("field_level_accuracy scorer requires `expected` to be a plain object of field -> value");
  }
  const expectedRecord = expected as Record<string, unknown>;
  const actualRecord = typeof actual === "object" && actual !== null && !Array.isArray(actual) ? (actual as Record<string, unknown>) : {};
  const fields = cfg?.fields ?? Object.keys(expectedRecord);

  let correct = 0;
  for (const field of fields) {
    if (deepEqual(actualRecord[field], expectedRecord[field])) correct++;
  }
  const score = fields.length === 0 ? 1 : correct / fields.length;
  const threshold = cfg?.passThreshold ?? 1;
  return { passed: score >= threshold, score, deterministic: true, detail: `${correct}/${fields.length} field(s) correct` };
};
