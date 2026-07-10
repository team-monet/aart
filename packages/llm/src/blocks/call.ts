// llm.call — the generic block (architecture §12.3). Every other llm.*
// block (extract/classify/generate/judge) is a thin convention layered on
// top of the same `llmCallCore` engine this block wraps directly.
import { LlmCallStepSchema, toJsonSchema, type BlockImplementation, type BlockManifest } from "@aart/types";
import { z } from "zod";
import { llmCallCore, toBlockExecute, type LlmBlockDeps } from "./core.js";

export const LLM_CALL_MANIFEST: BlockManifest = {
  id: "llm.call",
  version: "0.1.0",
  capabilities: ["llm"],
  inputSchema: toJsonSchema(LlmCallStepSchema),
  // The actual output shape is runtime-parameterized by the step's own
  // `outputSchema` field (schema-validated when present, plain text
  // otherwise) — there is no single static Zod shape for it, so the
  // manifest's outputSchema is deliberately unconstrained (any JSON value).
  outputSchema: toJsonSchema(z.unknown()),
  description: "Make an explicit, declared LLM call. model uses the provider/model convention (e.g. \"anthropic/claude-sonnet-5\"). Provide prompt or promptRef (not both required, but at least one). If outputSchema is given (inline JSON Schema, or a \"schemas.<name>\" registry ref), the result is validated against it before the step completes.",
  category: "llm",
};

export function createLlmCallBlock(deps: LlmBlockDeps): BlockImplementation {
  return {
    manifest: LLM_CALL_MANIFEST,
    execute: toBlockExecute((raw) => LlmCallStepSchema.parse(raw), llmCallCore, deps),
  };
}
