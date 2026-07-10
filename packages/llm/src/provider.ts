// Provider adapter contract — architecture §12.1: "each adapter implements
// one common interface: call({ model, prompt, input, outputSchema,
// temperature, maxTokens }) → { output, tokensIn, tokensOut, latencyMs,
// costEstimate }." The `provider/model` prefix convention (spec §22.4) means
// adding a new provider is purely additive — register a new adapter keyed
// on a new prefix, zero change to LlmCallStep or any workflow-authoring
// surface (ADR-11).
import { UnknownProviderError } from "./errors.js";

export interface LlmCallParams {
  /** The BARE model name for this provider (prefix already stripped by `parseModelRef`/the dispatch layer — see provider.test.ts) — e.g. "claude-sonnet-5", not "anthropic/claude-sonnet-5". */
  model: string;
  /** Final resolved prompt text (inline `prompt`, or a resolved `promptRef` registry entry's body). */
  prompt: string;
  input: unknown;
  /** Resolved JSON Schema (already dereferenced from a `schemas.<name>` ref, if that's how it was written) — absent means unstructured/free-text output. */
  outputSchema?: unknown;
  temperature?: number;
  maxTokens?: number;
}

export interface LlmCallResult {
  output: unknown;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  costEstimate?: number;
}

export type ProviderId = "anthropic" | "openai" | "google";

export interface ProviderAdapter {
  readonly id: ProviderId;
  call(params: LlmCallParams): Promise<LlmCallResult>;
}

export interface ParsedModelRef {
  /** The prefix exactly as written (e.g. "anthropic") — @aart/types' CAPABILITY_TAXONOMY-style lowercase convention is not enforced here; provider registries key by this string verbatim. */
  provider: string;
  /** Everything after the first "/" — the bare model name a provider's own API expects. */
  modelName: string;
}

/**
 * Splits a `provider/model` string on its FIRST "/" — spec §22.4: "Model ids
 * use the provider/model convention... The provider is derived from the
 * prefix rather than specified separately." Splitting on the first slash
 * (not the only slash) means a model name that itself contains a "/" (none
 * of today's provider model ids do, but this is defensive) still parses:
 * "openai/gpt-5.5-thinking" → { provider: "openai", modelName:
 * "gpt-5.5-thinking" }.
 */
export function parseModelRef(model: string): ParsedModelRef {
  const idx = model.indexOf("/");
  if (idx <= 0 || idx === model.length - 1) {
    throw new UnknownProviderError({
      message: `model id "${model}" does not follow the "provider/model" convention (spec §22.4) — expected e.g. "anthropic/claude-sonnet-5"`,
      detail: { model },
    });
  }
  return { provider: model.slice(0, idx), modelName: model.slice(idx + 1) };
}

export type ProviderRegistry = Readonly<Record<string, ProviderAdapter>>;

export function createProviderRegistry(adapters: readonly ProviderAdapter[]): ProviderRegistry {
  const registry: Record<string, ProviderAdapter> = {};
  for (const adapter of adapters) {
    registry[adapter.id] = adapter;
  }
  return registry;
}

/**
 * Resolves a full `provider/model` string to its adapter + the bare model
 * name that adapter's `call()` should receive. The one place prefix-
 * stripping happens — every `ProviderAdapter` implementation receives an
 * already-bare `model` in `LlmCallParams`, so no adapter re-implements this
 * split.
 */
export function selectProvider(model: string, registry: ProviderRegistry): { adapter: ProviderAdapter; modelName: string } {
  const { provider, modelName } = parseModelRef(model);
  const adapter = registry[provider];
  if (!adapter) {
    throw new UnknownProviderError({
      message: `no provider adapter registered for "${provider}" (from model "${model}") — registered: ${Object.keys(registry).join(", ") || "(none)"}`,
      detail: { provider, model, registered: Object.keys(registry) },
    });
  }
  return { adapter, modelName };
}
