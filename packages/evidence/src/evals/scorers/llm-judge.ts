// llm-judge.ts — "LLM judge scorer, clearly marked non-deterministic", spec
// §24.3; architecture §9.5's deliberate exception to the other 11 kinds'
// pure-function contract.
//
// @aart/evidence does not depend on @aart/llm as a package (S7 hasn't
// started — this session's brief: "code the LLM-judge scorer against its
// documented llm.judge interface and stub it, consistent with how every
// other Wave-1 cross-dependency is handled"). LlmJudgeFn below is the SEAM
// this module expects @aart/llm's `llm.judge` block (architecture
// §9.5/§12.3) to satisfy — recorded in SEAMS.md for S7 to consume/align
// with. Until then, callers inject a fake (createFakeLlmJudge) or the
// scorer registry's default no-op-that-throws (registry.ts).
import type { AsyncScorerFn } from "./types.js";

export interface LlmJudgeInput {
  /** `provider/model` convention (spec §13.6/§22.4). */
  model: string;
  actual: unknown;
  expected: unknown;
  /** Free-text judging rubric/instructions, optional. */
  criteria?: string;
  /** architecture §9.5: "invoked at temperature: 0 where the provider supports it." */
  temperature?: number;
}

export interface LlmJudgeOutput {
  passed: boolean;
  score: number;
  detail?: string;
}

/** The @aart/llm (S7) seam — see SEAMS.md. */
export type LlmJudgeFn = (input: LlmJudgeInput) => Promise<LlmJudgeOutput>;

export interface LlmJudgeScorerConfig {
  model?: string;
  criteria?: string;
}

const DEFAULT_JUDGE_MODEL = "anthropic/claude-sonnet-5";

/**
 * Builds the `llm_judge` scorer entry from an injected LlmJudgeFn. Always
 * invokes at `temperature: 0` (architecture §9.5 — reduces, does not
 * eliminate, run-to-run variance) and always marks the result
 * `deterministic: false` regardless of what the injected judge itself
 * returns, since architecture §9.5 requires this flag unconditionally for
 * this one kind.
 */
export function createLlmJudgeScorer(judge: LlmJudgeFn): AsyncScorerFn {
  return async (actual, expected, config) => {
    const cfg = config as LlmJudgeScorerConfig | undefined;
    const output = await judge({
      model: cfg?.model ?? DEFAULT_JUDGE_MODEL,
      actual,
      expected,
      criteria: cfg?.criteria,
      temperature: 0,
    });
    return { ...output, deterministic: false };
  };
}

/** A scripted fake for offline testing (this session's own tests, and any sibling session's tests before @aart/llm lands) — see SEAMS.md. */
export function createFakeLlmJudge(handler: (input: LlmJudgeInput) => LlmJudgeOutput | Promise<LlmJudgeOutput>): LlmJudgeFn {
  return async (input) => handler(input);
}
