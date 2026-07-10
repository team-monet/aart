// llm.extract — a thin wrapper around llm.call with extraction's own
// convention baked in (architecture §12.3): structured extraction is
// meaningless without a target shape, so `outputSchema` is REQUIRED for
// this block specifically (llm.call itself leaves it optional).
import { LlmCallStepSchema, toJsonSchema, type BlockImplementation, type BlockManifest, type LlmCallStep } from "@aart/types";
import { MissingOutputSchemaError } from "../errors.js";
import { llmCallCore, toBlockExecute, type LlmBlockDeps } from "./core.js";

// Manifest-facing shape: outputSchema marked required — model-facing
// documentation of the convention (spec §32.1's model-native design law:
// the schema itself teaches the constraint), independent of the runtime
// check below (which raises a purpose-built error rather than a generic
// Zod parse failure).
const LlmExtractStepSchema = LlmCallStepSchema.required({ outputSchema: true });

export const LLM_EXTRACT_MANIFEST: BlockManifest = {
  id: "llm.extract",
  version: "0.1.0",
  capabilities: ["llm"],
  inputSchema: toJsonSchema(LlmExtractStepSchema),
  outputSchema: toJsonSchema(LlmExtractStepSchema.shape.outputSchema),
  description: "Extract structured data from unstructured input via an LLM call. outputSchema is REQUIRED (inline JSON Schema or a \"schemas.<name>\" registry ref) — the extracted result is validated against it before the step completes. Thin wrapper around llm.call (architecture §12.3).",
  category: "llm",
};

function parseExtractInput(raw: unknown): LlmCallStep {
  const step = LlmCallStepSchema.parse(raw);
  if (step.outputSchema === undefined) {
    throw new MissingOutputSchemaError({
      message: "llm.extract requires outputSchema (inline JSON Schema or a \"schemas.<name>\" ref) — extraction without a target shape is not this block's job, use llm.call for unstructured output",
      detail: { step },
    });
  }
  return step;
}

export function createLlmExtractBlock(deps: LlmBlockDeps): BlockImplementation {
  return {
    manifest: LLM_EXTRACT_MANIFEST,
    execute: toBlockExecute(parseExtractInput, llmCallCore, deps),
  };
}
