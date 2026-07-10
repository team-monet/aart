// Shared llm.call core — architecture §12.3: "llm.extract/llm.classify/
// llm.generate (thin wrappers around llm.call with schema/prompt
// conventions baked in)." This module is the ONE place that does
// resolve-prompt → resolve-schema → select-provider → call → validate →
// build-metadata; every thin wrapper (blocks/extract.ts etc.) only adds its
// own pre/post convention around a call into `llmCallCore`.
import type { AartStore } from "@aart/store";
import type { BlockExecutionContext, LlmCallMetadata, LlmCallStep } from "@aart/types";
import { MissingPromptError } from "../errors.js";
import type { ProviderRegistry } from "../provider.js";
import { selectProvider } from "../provider.js";
import {
  inlinePromptResolution,
  inlineSchemaResolution,
  isRegistryRef,
  resolvePromptRef,
  resolveSchemaRef,
  type PromptResolution,
  type SchemaResolution,
} from "../registry.js";
import { validateAgainstSchema } from "../validate-output.js";

export interface LlmBlockDeps {
  store: AartStore;
  providers: ProviderRegistry;
}

export interface LlmCallCoreResult {
  output: unknown;
  llmCallMetadata: LlmCallMetadata;
  /** Exposed so a caller building an ExecutionSnapshot (S1) doesn't need to re-resolve — see registry.ts's encodeResolvedVersion / SEAMS.md L1. */
  resolutions: { prompt: PromptResolution; schema?: SchemaResolution };
}

/**
 * The generic `llm.call` engine (architecture §12.3). Resolution is LAZY by
 * construction: this function is only ever invoked from a block's
 * `execute()` (see `toBlockExecute` below), which the engine only calls
 * when the step actually dispatches — never at workflow-parse/run-start
 * time. See registry.test.ts's "laziness" suite for the exact proof at the
 * registry-function level; this function adds no eager resolution on top.
 */
export async function llmCallCore(step: LlmCallStep, deps: LlmBlockDeps): Promise<LlmCallCoreResult> {
  // 1. Resolve the prompt.
  let promptResolution: PromptResolution;
  if (step.promptRef !== undefined) {
    promptResolution = await resolvePromptRef(deps.store, step.promptRef);
  } else if (step.prompt !== undefined) {
    promptResolution = inlinePromptResolution(step.prompt);
  } else {
    throw new MissingPromptError({ message: "LlmCallStep has neither `prompt` nor `promptRef` set — at least one is required", detail: { step } });
  }

  // 2. Resolve outputSchema, if any. Per LlmCallStepSchema, `outputSchema`
  // is z.unknown() — either a "schemas.<name>" ref string, an inline JSON
  // Schema object, or absent entirely (unstructured output).
  let schemaResolution: SchemaResolution | undefined;
  if (typeof step.outputSchema === "string" && isRegistryRef(step.outputSchema) === "schema") {
    schemaResolution = await resolveSchemaRef(deps.store, step.outputSchema);
  } else if (step.outputSchema !== undefined) {
    schemaResolution = inlineSchemaResolution(step.outputSchema);
  }

  // 3. Select the provider adapter by the model's provider/ prefix and call it.
  const { adapter, modelName } = selectProvider(step.model, deps.providers);
  const callResult = await adapter.call({
    model: modelName,
    prompt: promptResolution.body,
    input: step.input,
    outputSchema: schemaResolution?.jsonSchema,
    temperature: step.temperature,
    maxTokens: step.maxTokens,
  });

  // 4. Validate output against the declared schema — architecture §12.3's
  // "schema-validated wrapper, never a free-form runtime LLM call." A
  // provider adapter already threw LlmOutputParseError if the text wasn't
  // even valid JSON when a schema was requested; this is the second,
  // shape-level check.
  if (schemaResolution) {
    validateAgainstSchema(callResult.output, schemaResolution.jsonSchema, { model: step.model, ref: schemaResolution.ref });
  }

  // 5. Build the trace metadata (spec §19.2/§22.3). `model` carries the
  // FULL author-written "provider/model" string (spec §22.4: the trace
  // "captures both the resolved provider and model fields regardless of
  // which form the workflow author wrote") — `provider` is the adapter's
  // own identity, not re-derived from the prefix a second time.
  const llmCallMetadata: LlmCallMetadata = {
    provider: adapter.id,
    model: step.model,
    promptRef: promptResolution.ref,
    promptVersion: promptResolution.version,
    schemaRef: schemaResolution?.ref,
    tokensIn: callResult.tokensIn,
    tokensOut: callResult.tokensOut,
    latencyMs: callResult.latencyMs,
    costEstimate: callResult.costEstimate,
  };

  return { output: callResult.output, llmCallMetadata, resolutions: { prompt: promptResolution, schema: schemaResolution } };
}

/**
 * SEAMS.md L3's proposed `BlockExecutionContext` extension — OPTIONAL, so
 * every `llm.*` block works correctly today against a bare
 * `BlockExecutionContext` (this package's own tests, or an engine that
 * hasn't added this method yet): the block still returns the correct plain
 * output either way, it just has nowhere to hand `LlmCallMetadata` out-of-
 * band without this. See SEAMS.md for the full rationale (why metadata
 * can't just be embedded in the return value without breaking
 * `{{ steps.X.outputs.field }}` ergonomics).
 */
export interface LlmBlockExecutionContext extends BlockExecutionContext {
  recordLlmCall?(metadata: LlmCallMetadata): void;
}

/**
 * Wraps a core function (`llmCallCore` or any of the thin-wrapper cores) as
 * a `BlockImplementation.execute` — the frozen `(resolvedInputs, ctx) =>
 * Promise<unknown>` signature (architecture §2.5). Returns ONLY the plain
 * output (never `{ output, llmCallMetadata }`) so a downstream step's
 * `{{ steps.X.outputs.field }}` reference keeps working exactly like any
 * other block's output — metadata goes out-of-band via `recordLlmCall`.
 */
export function toBlockExecute<TInput>(
  parseInput: (resolvedInputs: unknown) => TInput,
  core: (input: TInput, deps: LlmBlockDeps) => Promise<{ output: unknown; llmCallMetadata: LlmCallMetadata }>,
  deps: LlmBlockDeps,
): (resolvedInputs: unknown, ctx: BlockExecutionContext) => Promise<unknown> {
  return async (resolvedInputs, ctx) => {
    const input = parseInput(resolvedInputs);
    const { output, llmCallMetadata } = await core(input, deps);
    (ctx as LlmBlockExecutionContext).recordLlmCall?.(llmCallMetadata);
    return output;
  };
}
