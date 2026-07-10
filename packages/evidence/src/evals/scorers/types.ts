// types.ts — scorer shape (architecture §9.5). 11 of the 12 built-in scorer
// kinds are pure functions `(actual, expected, scorerConfig) => { passed,
// score, detail? }`; LLM judge is the deliberate non-deterministic
// exception (async, calls a model).
export interface ScorerResult {
  passed: boolean;
  score: number;
  detail?: string;
  /** `false` ONLY for kind "llm_judge" (architecture §9.5) — the other 11 kinds always report `true`. Present on every ScorerResult (not just the judge's) so a caller never has to special-case which kind it's looking at to know whether a result is trustworthy-as-repeatable. */
  deterministic: boolean;
}

/** 11 of the 12 built-in scorer kinds match this exact shape (architecture §9.5). */
export type PureScorerFn = (actual: unknown, expected: unknown, config?: unknown) => ScorerResult;

/** The 12th kind, llm_judge — async because it calls a model (architecture §9.5's deliberate exception). */
export type AsyncScorerFn = (actual: unknown, expected: unknown, config?: unknown) => Promise<ScorerResult>;
