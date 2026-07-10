// eval.score — spec §15.3 Eval group: "scores one output against an
// expected value using a §24.3 scorer." Delegates ALL scoring logic to
// S6's `@aart/evidence` scorer registry via the injected
// `ScorerRegistryPort` (scorer-registry-port.ts) — this block owns none of
// the 12 scorers' actual algorithms.
//
// Unlike most blocks in this catalog (a plain exported `BlockImplementation`
// constant), eval.score is a FACTORY — `createEvalScoreBlock(scorerRegistry?)`
// — because it needs a dependency injected at construction time. Call with
// no argument to get the lazy-resolves-real-@aart/evidence-or-throws
// default (used by `getBlockCatalog()`); pass an explicit
// `ScorerRegistryPort` (the real S6 export post-merge, or a test fake) to
// override it. See eval/index.ts for how this composes into the catalog.
//
// Capability `["llm"]`: declared defensively, not because 11 of the 12
// scorer kinds need it (they don't — exact_match/jsonpath_exact/regex/
// numeric_tolerance/etc. are pure data comparisons) but because `kind` is
// a RUNTIME input this manifest can't see ahead of time, and the
// `llm_judge` kind genuinely does invoke an LLM call under the hood (S6
// SEAMS.md E1). Per this session's own DoD: "an under-declared capability
// is a security hole" — the safer error, given a capability declaration is
// static per-manifest but `kind` is dynamic, is to over-declare for the
// one kind that needs it rather than risk under-declaring.
import { z } from "zod";
import { defineBlock } from "../lib/define-block.js";
import { ScorerRegistryUnavailableError, tryLoadEvidenceScorerRegistry, type ScorerRegistryPort } from "./scorer-registry-port.js";

const inputSchema = z.object({
  kind: z.string().describe("One of the 12 built-in scorer kinds (BUILTIN_SCORER_KINDS, @aart/types) or a pack-introduced kind, e.g. \"exact_match\", \"numeric_tolerance\", \"llm_judge\"."),
  actual: z.unknown(),
  expected: z.unknown(),
  config: z.unknown().optional(),
});
const outputSchema = z.object({
  passed: z.boolean(),
  score: z.number(),
  detail: z.string().optional(),
});

export function createEvalScoreBlock(scorerRegistry?: ScorerRegistryPort) {
  return defineBlock({
    id: "eval.score",
    capabilities: ["llm"],
    category: "eval",
    description:
      'Scores actual against expected using a named scorer kind. Example: kind: "numeric_tolerance", actual: "{{ steps.compute.outputs.total }}", expected: 100, config: { tolerance: 0.01 }.',
    inputSchema,
    outputSchema,
    execute: async (input) => {
      const registry = scorerRegistry ?? (await tryLoadEvidenceScorerRegistry());
      if (!registry) throw new ScorerRegistryUnavailableError("eval.score");
      return registry.score(input.kind, input.actual, input.expected, input.config);
    },
  });
}

/** The default catalog member — lazily resolves the real `@aart/evidence` registry at call time, no injection required. */
export const evalScoreBlock = createEvalScoreBlock();
