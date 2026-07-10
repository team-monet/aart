// numeric-tolerance.ts — "numeric tolerance", spec §24.3.
import type { PureScorerFn } from "./types.js";

export interface NumericToleranceConfig {
  tolerance?: number;
}

export const numericTolerance: PureScorerFn = (actual, expected, config) => {
  const tolerance = (config as NumericToleranceConfig | undefined)?.tolerance ?? 0;
  const a = Number(actual);
  const e = Number(expected);
  if (Number.isNaN(a) || Number.isNaN(e)) {
    return { passed: false, score: 0, deterministic: true, detail: `non-numeric value: actual=${String(actual)} expected=${String(expected)}` };
  }
  const diff = Math.abs(a - e);
  const passed = diff <= tolerance;
  return { passed, score: passed ? 1 : 0, deterministic: true, detail: `|${a} - ${e}| = ${diff}, tolerance = ${tolerance}` };
};
