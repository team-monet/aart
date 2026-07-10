// LlmCallStep, LlmCallMetadata — spec §13.6, §19.2.
import { z } from "zod";

export const LlmCallStepSchema = z.object({
  // provider/model convention (spec §13.6, §22.4) — e.g. "anthropic/claude-sonnet-5".
  model: z.string(),
  promptRef: z.string().optional(),
  prompt: z.string().optional(),
  input: z.unknown(),
  outputSchema: z.unknown().optional(),
  temperature: z.number().optional(),
  maxTokens: z.number().optional(),
  // Inline, single-call observability scoring — distinct from the EvalSuite
  // batch-gate system (eval.ts, spec §24); see spec §13.6/§24.1's own note.
  eval: z
    .object({
      suite: z.string().optional(),
      scorer: z.string().optional(),
    })
    .optional(),
});
export type LlmCallStep = z.infer<typeof LlmCallStepSchema>;

export const LlmCallMetadataSchema = z.object({
  provider: z.string(),
  model: z.string(),
  promptRef: z.string(),
  promptVersion: z.string(),
  schemaRef: z.string().optional(),
  tokensIn: z.number(),
  tokensOut: z.number(),
  latencyMs: z.number(),
  costEstimate: z.number().optional(),
  scorerResult: z.unknown().optional(),
});
export type LlmCallMetadata = z.infer<typeof LlmCallMetadataSchema>;
