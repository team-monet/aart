// @aart/llm — LLM pack: provider adapters, prompt/schema registry runtime,
// llm.* block implementations (architecture §12, spec §13.6/§22). See
// SEAMS.md (L1-L3) for the cross-session coordination points (S1's
// ExecutionSnapshot capture, S6's LlmJudgeFn, S1's BlockExecutionContext
// extension proposal) and this session's report for design decisions.
import type { AartStore } from "@aart/store";
import type { BlockImplementation } from "@aart/types";
import { createAnthropicAdapter, type AnthropicAdapterOptions } from "./providers/anthropic.js";
import { createGoogleAdapter, type GoogleAdapterOptions } from "./providers/google.js";
import { createOpenAiAdapter, type OpenAiAdapterOptions } from "./providers/openai.js";
import { createLlmCallBlock } from "./blocks/call.js";
import { createLlmClassifyBlock } from "./blocks/classify.js";
import type { LlmBlockDeps } from "./blocks/core.js";
import { createLlmExtractBlock } from "./blocks/extract.js";
import { createLlmGenerateBlock } from "./blocks/generate.js";
import { createLlmJudge, createLlmJudgeBlock, type LlmJudgeDeps, type LlmJudgeFn } from "./blocks/judge.js";
import { createProviderRegistry, type ProviderRegistry } from "./provider.js";

export {
  InvalidRegistryRefError,
  LlmOutputParseError,
  LlmOutputSchemaValidationError,
  MissingOutputSchemaError,
  MissingPromptError,
  ProviderHttpError,
  RegistryVersionImmutableError,
  UnknownProviderError,
  UnresolvedRegistryRefError,
} from "./errors.js";
export {
  createProviderRegistry,
  parseModelRef,
  selectProvider,
  type LlmCallParams,
  type LlmCallResult,
  type ParsedModelRef,
  type ProviderAdapter,
  type ProviderId,
  type ProviderRegistry,
} from "./provider.js";
export {
  createAnthropicAdapter,
  type AnthropicAdapterOptions,
  type AnthropicClientLike,
  type AnthropicMessageResponse,
} from "./providers/anthropic.js";
export { createOpenAiAdapter, type OpenAiAdapterOptions, type OpenAiChatCompletionResponse } from "./providers/openai.js";
export { createGoogleAdapter, type GoogleAdapterOptions, type GoogleGenerateContentResponse } from "./providers/google.js";
export { nodeFetcher, type Fetcher, type HttpResponseLike } from "./providers/transport.js";
export {
  computeContentHash,
  decodeResolvedVersion,
  encodeResolvedVersion,
  inlinePromptResolution,
  inlineSchemaResolution,
  isRegistryRef,
  registerPrompt,
  registerSchema,
  resolvePromptRef,
  resolveSchemaRef,
  type PromptResolution,
  type SchemaResolution,
} from "./registry.js";
export { validateAgainstSchema, type ValidateOutputContext } from "./validate-output.js";
export {
  llmCallCore,
  toBlockExecute,
  type LlmBlockDeps,
  type LlmBlockExecutionContext,
  type LlmCallCoreResult,
} from "./blocks/core.js";
export { createLlmCallBlock, LLM_CALL_MANIFEST } from "./blocks/call.js";
export { createLlmExtractBlock, LLM_EXTRACT_MANIFEST } from "./blocks/extract.js";
export {
  classificationSchemaFromLabels,
  createLlmClassifyBlock,
  LLM_CLASSIFY_MANIFEST,
  type LlmClassifyStep,
} from "./blocks/classify.js";
export { createLlmGenerateBlock, LLM_GENERATE_MANIFEST } from "./blocks/generate.js";
export {
  createLlmJudge,
  createLlmJudgeBlock,
  LLM_JUDGE_MANIFEST,
  llmJudgeCore,
  type LlmJudgeCoreResult,
  type LlmJudgeDeps,
  type LlmJudgeFn,
  type LlmJudgeInput,
  type LlmJudgeOutput,
} from "./blocks/judge.js";

// ---------------------------------------------------------------------------
// createLlmPack — a composition-root convenience wiring all three provider
// adapters + all five llm.* blocks + the standalone LlmJudgeFn together.
// Not required reading for any single piece above (each is independently
// usable/testable, as this package's own test suite demonstrates) — this
// exists for whoever actually assembles a running AART process (S1's
// engine block registry, S9's integration wiring) so they don't have to
// re-derive "which five blocks, which three adapters, how do the judge
// deps relate to the block deps" by hand.
// ---------------------------------------------------------------------------

export interface CreateLlmPackOptions {
  store: AartStore;
  anthropic?: AnthropicAdapterOptions;
  openai?: OpenAiAdapterOptions;
  google?: GoogleAdapterOptions;
}

export interface LlmPack {
  providers: ProviderRegistry;
  /** All five llm.* BlockImplementations, ready to register with the engine's block dispatch table (architecture §2.5/§4.2). */
  blocks: readonly BlockImplementation[];
  /** Matches S6's documented `LlmJudgeFn` shape (SEAMS.md L2) — wire into `@aart/evidence`'s `createScorerRegistry({ llmJudge })`. */
  llmJudge: LlmJudgeFn;
}

export function createLlmPack(options: CreateLlmPackOptions): LlmPack {
  const providers = createProviderRegistry([
    createAnthropicAdapter(options.anthropic),
    createOpenAiAdapter(options.openai),
    createGoogleAdapter(options.google),
  ]);
  const blockDeps: LlmBlockDeps = { store: options.store, providers };
  const judgeDeps: LlmJudgeDeps = { providers };

  return {
    providers,
    blocks: [
      createLlmCallBlock(blockDeps),
      createLlmExtractBlock(blockDeps),
      createLlmClassifyBlock(blockDeps),
      createLlmGenerateBlock(blockDeps),
      createLlmJudgeBlock(judgeDeps),
    ],
    llmJudge: createLlmJudge(judgeDeps),
  };
}
