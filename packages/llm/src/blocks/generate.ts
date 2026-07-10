// llm.generate — a thin wrapper around llm.call (architecture §12.3).
// Unlike llm.extract/llm.classify, generation's natural output is often
// free-form text — neither source document gives generate an additional
// MECHANICAL convention the way extract's "outputSchema required" and
// classify's "enum-like shape" get, so this wrapper is intentionally the
// loosest of the three: outputSchema stays fully optional (identical to
// llm.call's own contract), and the wrapper exists as its own named,
// discoverable block (spec §32.1's "make it familiar to models" — an
// authoring agent reaching for "generate text" should find `llm.generate`
// by name rather than being expected to know `llm.call` covers it too) with
// its own model-facing description, not to add a shape rule llm.call
// already omits by design.
import { LlmCallStepSchema, toJsonSchema, type BlockImplementation, type BlockManifest } from "@aart/types";
import { z } from "zod";
import { llmCallCore, toBlockExecute, type LlmBlockDeps } from "./core.js";

export const LLM_GENERATE_MANIFEST: BlockManifest = {
  id: "llm.generate",
  version: "0.1.0",
  capabilities: ["llm"],
  inputSchema: toJsonSchema(LlmCallStepSchema),
  outputSchema: toJsonSchema(z.unknown()),
  description:
    "Generate free-form text (or, if outputSchema is provided, structured output) via an LLM call. Use this for open-ended generation tasks (drafting, summarizing, composing) — for extraction into a required shape use llm.extract, for closed-set labeling use llm.classify. Thin wrapper around llm.call (architecture §12.3).",
  category: "llm",
};

export function createLlmGenerateBlock(deps: LlmBlockDeps): BlockImplementation {
  return {
    manifest: LLM_GENERATE_MANIFEST,
    execute: toBlockExecute((raw) => LlmCallStepSchema.parse(raw), llmCallCore, deps),
  };
}
