// A small scripted fake ScorerRegistryPort for this package's OWN tests —
// mirroring S6's own `createFakeLlmJudge` pattern (SEAMS.md E1: "a
// scripted fake, not a real model call"). Implements just enough of the
// real 12-kind registry (exact_match, numeric_tolerance) to exercise
// eval.score/eval.run's plumbing; it is NOT a stand-in for S6's real
// scorer correctness and must never be treated as this package's
// production fallback (contrast report-renderers-port.ts's
// createFallbackReportRenderers, which IS a real production fallback —
// see eval/scorer-registry-port.ts's doc comment for why the two ports
// take different fallback stances).
import { isDeepStrictEqual } from "node:util";
import type { ScorerRegistryPort, ScorerResult } from "../eval/scorer-registry-port.js";

export interface FakeScorerRegistryOptions {
  /** Extra kinds beyond the built-in exact_match/numeric_tolerance fakes, e.g. to simulate llm_judge deterministically in a test. */
  extraKinds?: Record<string, (actual: unknown, expected: unknown, config?: unknown) => ScorerResult | Promise<ScorerResult>>;
}

export function createFakeScorerRegistry(options: FakeScorerRegistryOptions = {}): ScorerRegistryPort {
  const extraKinds = options.extraKinds ?? {};
  const kinds = ["exact_match", "numeric_tolerance", ...Object.keys(extraKinds)];

  return {
    kinds,
    get: (kind) => (kinds.includes(kind) ? { kind } : undefined),
    score: async (kind, actual, expected, config): Promise<ScorerResult> => {
      if (kind === "exact_match") {
        const passed = isDeepStrictEqual(actual, expected);
        return { passed, score: passed ? 1 : 0 };
      }
      if (kind === "numeric_tolerance") {
        const tolerance = (config as { tolerance?: number } | undefined)?.tolerance ?? 0;
        const a = Number(actual);
        const e = Number(expected);
        const passed = Math.abs(a - e) <= tolerance;
        return { passed, score: passed ? 1 : 0 };
      }
      const fn = extraKinds[kind];
      if (fn) return fn(actual, expected, config);
      return { passed: false, score: 0, detail: `fake registry: unknown kind "${kind}"` };
    },
  };
}
