// regex.ts — "regex", spec §24.3.
import type { PureScorerFn } from "./types.js";

export interface RegexScorerConfig {
  pattern?: string;
  flags?: string;
}

/** The pattern lives in `config.pattern`; a string `expected` is accepted as a fallback pattern source (so an EvalExample can express "actual must match this pattern" purely via its own `expected` field without a scorerConfig). */
export const regexScorer: PureScorerFn = (actual, expected, config) => {
  const cfg = config as RegexScorerConfig | undefined;
  const pattern = cfg?.pattern ?? (typeof expected === "string" ? expected : undefined);
  if (!pattern) {
    throw new Error("regex scorer requires config.pattern, or a string `expected` to use as the pattern");
  }
  const re = new RegExp(pattern, cfg?.flags);
  const passed = re.test(String(actual));
  return { passed, score: passed ? 1 : 0, deterministic: true, detail: `pattern: /${pattern}/${cfg?.flags ?? ""}` };
};
