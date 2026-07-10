// llm.classify — a thin wrapper around llm.call whose convention
// (architecture §12.3: "expects an outputSchema shaped as an enum-like
// classification result") is baked in two ways: callers can pass a full
// `outputSchema` themselves (same as llm.extract), OR the convenience
// `labels: string[]` field, from which this block SYNTHESIZES the
// enum-classification outputSchema — the concrete shape architecture's own
// sentence describes, rather than leaving "enum-like" as prose callers have
// to hand-build themselves every time.
import { LlmCallStepSchema, toJsonSchema, type BlockImplementation, type BlockManifest, type LlmCallStep } from "@aart/types";
import { z } from "zod";
import { MissingOutputSchemaError } from "../errors.js";
import { llmCallCore, toBlockExecute, type LlmBlockDeps } from "./core.js";

const LlmClassifyStepSchema = LlmCallStepSchema.extend({
  /** Convenience: a closed label set. When set (and `outputSchema` is not explicitly given), this block synthesizes an enum-classification outputSchema from it. */
  labels: z.array(z.string()).min(1).optional(),
});
export type LlmClassifyStep = z.infer<typeof LlmClassifyStepSchema>;

export const LLM_CLASSIFY_MANIFEST: BlockManifest = {
  id: "llm.classify",
  version: "0.1.0",
  capabilities: ["llm"],
  inputSchema: toJsonSchema(LlmClassifyStepSchema),
  outputSchema: toJsonSchema(z.object({ label: z.string(), confidence: z.number().optional() })),
  description:
    'Classify input into one of a closed set of labels via an LLM call. Provide either `labels: string[]` (this block synthesizes an enum-classification outputSchema `{ label, confidence? }` from it) or your own `outputSchema` directly. Thin wrapper around llm.call (architecture §12.3).',
  category: "llm",
};

export function classificationSchemaFromLabels(labels: readonly string[]): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      label: { enum: [...labels] },
      confidence: { type: "number", minimum: 0, maximum: 1 },
    },
    required: ["label"],
    additionalProperties: false,
  };
}

function parseClassifyInput(raw: unknown): LlmCallStep {
  const step = LlmClassifyStepSchema.parse(raw);
  const { labels, ...rest } = step;
  if (rest.outputSchema !== undefined) {
    // Caller supplied their own outputSchema — takes precedence, labels ignored.
    return rest;
  }
  if (labels !== undefined) {
    return { ...rest, outputSchema: classificationSchemaFromLabels(labels) };
  }
  throw new MissingOutputSchemaError({
    message: 'llm.classify requires either `labels: string[]` or an explicit `outputSchema` — neither was provided',
    detail: { step },
  });
}

export function createLlmClassifyBlock(deps: LlmBlockDeps): BlockImplementation {
  return {
    manifest: LLM_CLASSIFY_MANIFEST,
    execute: toBlockExecute(parseClassifyInput, llmCallCore, deps),
  };
}
