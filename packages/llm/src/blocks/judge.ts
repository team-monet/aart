// llm.judge — architecture §12.3: "the non-deterministic scorer-flavored
// variant, used both as a workflow step and, via @aart/evidence's scorer
// registry, as the LLM-judge Scorer kind (§9.5)." Two consumption surfaces,
// one core (`llmJudgeCore`):
//   1. `createLlmJudgeBlock` — a BlockImplementation for use as a workflow
//      step (`uses: llm.judge`).
//   2. `createLlmJudge` — a standalone `LlmJudgeFn` factory matching S6's
//      documented seam (SEAMS.md entry E1 in this session's sibling
//      worktree, adopted here VERBATIM field-for-field — see SEAMS.md L2)
//      for @aart/evidence's `createScorerRegistry({ llmJudge })` to consume
//      directly, bypassing the BlockExecutionContext machinery a scorer
//      registry has no reason to construct.
import { toJsonSchema, type BlockExecutionContext, type BlockImplementation, type BlockManifest, type LlmCallMetadata } from "@aart/types";
import { z } from "zod";
import type { ProviderRegistry } from "../provider.js";
import { selectProvider } from "../provider.js";
import { inlinePromptResolution } from "../registry.js";
import { validateAgainstSchema } from "../validate-output.js";
import type { LlmBlockExecutionContext } from "./core.js";

// Matches S6's SEAMS.md E1 shape EXACTLY (field names, optionality) — see
// this package's SEAMS.md entry L2 for the full cross-session note and the
// S9 verification step this independent (not-imported) declaration needs.
export interface LlmJudgeInput {
  /** provider/model convention, spec §13.6/§22.4. */
  model: string;
  actual: unknown;
  expected: unknown;
  criteria?: string;
  /** Always invoked at 0 by @aart/evidence's createLlmJudgeScorer (per S6's own doc comment) — this module also DEFAULTS to 0 when omitted, for the same determinism-seeking reason, regardless of caller. */
  temperature?: number;
}
export interface LlmJudgeOutput {
  passed: boolean;
  score: number;
  detail?: string;
}
export type LlmJudgeFn = (input: LlmJudgeInput) => Promise<LlmJudgeOutput>;

const JUDGE_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    passed: { type: "boolean" },
    score: { type: "number", minimum: 0, maximum: 1 },
    detail: { type: "string" },
  },
  required: ["passed", "score"],
  additionalProperties: false,
};

function buildJudgePrompt(input: LlmJudgeInput): string {
  const criteria = input.criteria ?? "Judge whether the ACTUAL output faithfully matches the EXPECTED output.";
  return [
    "You are an evaluation judge for an automated test suite. Compare ACTUAL against EXPECTED using CRITERIA below, and return your verdict as JSON matching the required schema.",
    `CRITERIA: ${criteria}`,
    `EXPECTED: ${JSON.stringify(input.expected)}`,
    `ACTUAL: ${JSON.stringify(input.actual)}`,
    'Respond with a JSON object: "passed" (boolean — does ACTUAL satisfy CRITERIA against EXPECTED), "score" (a number from 0 to 1), and optionally "detail" (a short explanation of the verdict).',
  ].join("\n\n");
}

export interface LlmJudgeCoreResult {
  output: LlmJudgeOutput;
  llmCallMetadata: LlmCallMetadata;
}

export interface LlmJudgeDeps {
  providers: ProviderRegistry;
}

/**
 * The shared judge engine. No `store` dependency (unlike `llmCallCore`) —
 * the judge prompt is always built internally from
 * criteria/actual/expected (see module comment); there is no
 * `prompts.<name>` indirection point for it in v1, so resolution is always
 * the `inlinePromptResolution` path. `scorerResult` on the returned
 * `LlmCallMetadata` carries the verdict itself (spec §19.2's `scorerResult?:
 * unknown` field exists for exactly this).
 */
export async function llmJudgeCore(input: LlmJudgeInput, deps: LlmJudgeDeps): Promise<LlmJudgeCoreResult> {
  const { adapter, modelName } = selectProvider(input.model, deps.providers);
  const promptResolution = inlinePromptResolution(buildJudgePrompt(input));
  const temperature = input.temperature ?? 0;

  const callResult = await adapter.call({
    model: modelName,
    prompt: promptResolution.body,
    input: { actual: input.actual, expected: input.expected },
    outputSchema: JUDGE_OUTPUT_SCHEMA,
    temperature,
  });

  validateAgainstSchema(callResult.output, JUDGE_OUTPUT_SCHEMA, { model: input.model, ref: "inline" });
  const verdict = callResult.output as LlmJudgeOutput;
  const output: LlmJudgeOutput = { passed: verdict.passed, score: verdict.score, detail: verdict.detail };

  const llmCallMetadata: LlmCallMetadata = {
    provider: adapter.id,
    model: input.model,
    promptRef: promptResolution.ref,
    promptVersion: promptResolution.version,
    schemaRef: "inline",
    tokensIn: callResult.tokensIn,
    tokensOut: callResult.tokensOut,
    latencyMs: callResult.latencyMs,
    costEstimate: callResult.costEstimate,
    scorerResult: output,
  };

  return { output, llmCallMetadata };
}

/** The `LlmJudgeFn` factory — wire this into `@aart/evidence`'s `createScorerRegistry({ llmJudge })` at the composition root (SEAMS.md L2). */
export function createLlmJudge(deps: LlmJudgeDeps): LlmJudgeFn {
  return async (input) => (await llmJudgeCore(input, deps)).output;
}

// --- Workflow-step surface -------------------------------------------------

const LlmJudgeStepSchema = z.object({
  model: z.string(),
  actual: z.unknown(),
  expected: z.unknown(),
  criteria: z.string().optional(),
  temperature: z.number().optional(),
});

export const LLM_JUDGE_MANIFEST: BlockManifest = {
  id: "llm.judge",
  version: "0.1.0",
  capabilities: ["llm"],
  inputSchema: toJsonSchema(LlmJudgeStepSchema),
  outputSchema: toJsonSchema(z.object({ passed: z.boolean(), score: z.number(), detail: z.string().optional() })),
  description:
    "Non-deterministic LLM-judge scoring (architecture §12.3, spec §24.3 'LLM judge scorer, clearly marked non-deterministic'). Compares `actual` against `expected` per `criteria` and returns { passed, score, detail? }. Defaults to temperature 0. Also usable as @aart/evidence's llm_judge Scorer kind via createLlmJudge — the same core, a different call surface.",
  category: "llm",
};

export function createLlmJudgeBlock(deps: LlmJudgeDeps): BlockImplementation {
  return {
    manifest: LLM_JUDGE_MANIFEST,
    async execute(resolvedInputs: unknown, ctx: BlockExecutionContext): Promise<unknown> {
      const input = LlmJudgeStepSchema.parse(resolvedInputs);
      const { output, llmCallMetadata } = await llmJudgeCore(input, deps);
      (ctx as LlmBlockExecutionContext).recordLlmCall?.(llmCallMetadata);
      return output;
    },
  };
}
