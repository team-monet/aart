// Anthropic provider adapter — architecture §12.1. Uses the official
// `@anthropic-ai/sdk` client (per this session's own research pass against
// Anthropic's current API docs) rather than hand-rolled HTTP, unlike the
// openai.ts/google.ts siblings — see this package's README/this session's
// report for why: Anthropic's SDK usage is independently verifiable this
// session; OpenAI's/Google's are not, so those two stay on a uniform
// injectable-REST-transport shape instead of three unequally-verified SDK
// integrations. All three still expose the identical `ProviderAdapter`
// interface (provider.ts) — this is purely an internal implementation
// choice per adapter, invisible to callers.
import Anthropic from "@anthropic-ai/sdk";
import { LlmOutputParseError } from "../errors.js";
import type { LlmCallParams, LlmCallResult, ProviderAdapter } from "../provider.js";

// Minimal structural shape of what this adapter reads off an
// @anthropic-ai/sdk `Message` response — NOT the full SDK response type, so
// this package's own tests can inject a plain object instead of
// constructing a real `Anthropic` client. A real `Anthropic().messages.create()`
// call's resolved value structurally satisfies this (superset of fields).
export interface AnthropicMessageResponse {
  content: Array<{ type: string; text?: string }>;
  usage: { input_tokens: number; output_tokens: number };
}

export interface AnthropicClientLike {
  messages: {
    create(params: Record<string, unknown>): Promise<AnthropicMessageResponse>;
  };
}

// Models on which sampling parameters (temperature/top_p/top_k) are
// REJECTED with a 400 — a real, current (as of this session) Anthropic API
// contract, not derivable from the model id's shape alone. Forwarding
// `temperature` to one of these would break every workflow step that sets
// it once the workflow author upgrades to one of these models, so this
// adapter drops it defensively rather than forwarding blindly.
const NO_SAMPLING_PARAMS_MODELS = new Set(["claude-fable-5", "claude-mythos-5", "claude-opus-4-8", "claude-opus-4-7", "claude-sonnet-5"]);

// USD per million tokens, [input, output] — Anthropic's published pricing
// as of this session. Sonnet 5's introductory $2/$10 rate (through
// 2026-08-31) is deliberately NOT modeled — this uses the standing $3/$15
// rate; a date-conditional price is more precision than a cost ESTIMATE
// needs and adds a second time-dependent thing to keep in sync. Absent
// entries (legacy models, or models newer than this session's research)
// intentionally produce no cost estimate (`costEstimate: undefined`) rather
// than a guessed number — `LlmCallMetadata.costEstimate` is optional
// precisely for this case.
const PRICING_PER_MTOK: Readonly<Record<string, readonly [number, number]>> = {
  "claude-fable-5": [10, 50],
  "claude-mythos-5": [10, 50],
  "claude-opus-4-8": [5, 25],
  "claude-opus-4-7": [5, 25],
  "claude-opus-4-6": [5, 25],
  "claude-sonnet-5": [3, 15],
  "claude-sonnet-4-6": [3, 15],
  "claude-haiku-4-5": [1, 5],
};

function estimateCost(model: string, tokensIn: number, tokensOut: number): number | undefined {
  const rate = PRICING_PER_MTOK[model];
  if (!rate) return undefined;
  const [inRate, outRate] = rate;
  return (tokensIn / 1_000_000) * inRate + (tokensOut / 1_000_000) * outRate;
}

function buildUserContent(params: LlmCallParams): string {
  // `input` is workflow-resolved structured data accompanying the prompt.
  // Neither spec nor architecture specifies a templating syntax for
  // combining `prompt` text with `input` data (spec §13.6's LlmCallStep
  // keeps them as two separate fields with no interpolation rule given) —
  // appending `input` as a JSON block after the prompt is a plain,
  // provider-agnostic, information-preserving choice that doesn't invent
  // syntax this task's scope doesn't call for.
  if (params.input === undefined) return params.prompt;
  return `${params.prompt}\n\n${JSON.stringify(params.input)}`;
}

function parseJsonOutput(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new LlmOutputParseError({
      message: `Anthropic response was not valid JSON despite outputSchema being requested: ${(cause as Error).message}`,
      detail: { rawText: text },
      cause,
    });
  }
}

export interface AnthropicAdapterOptions {
  apiKey?: string;
  /** Injected client — this package's own tests always supply one (a fake); production code omits it and gets a real `new Anthropic({ apiKey })`. */
  client?: AnthropicClientLike;
}

export function createAnthropicAdapter(options: AnthropicAdapterOptions = {}): ProviderAdapter {
  const client: AnthropicClientLike = options.client ?? (new Anthropic({ apiKey: options.apiKey }) as unknown as AnthropicClientLike);

  return {
    id: "anthropic",
    async call(params: LlmCallParams): Promise<LlmCallResult> {
      const startedAt = Date.now();

      const request: Record<string, unknown> = {
        model: params.model,
        max_tokens: params.maxTokens ?? 4096,
        messages: [{ role: "user", content: buildUserContent(params) }],
      };
      if (params.temperature !== undefined && !NO_SAMPLING_PARAMS_MODELS.has(params.model)) {
        request.temperature = params.temperature;
      }
      if (params.outputSchema !== undefined) {
        // Structured outputs — output_config.format (current Anthropic API;
        // supersedes the removed top-level output_format parameter).
        request.output_config = { format: { type: "json_schema", schema: params.outputSchema } };
      }

      const response = await client.messages.create(request);
      const latencyMs = Date.now() - startedAt;

      const rawText = response.content
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text as string)
        .join("");
      const output = params.outputSchema !== undefined ? parseJsonOutput(rawText) : rawText;

      return {
        output,
        tokensIn: response.usage.input_tokens,
        tokensOut: response.usage.output_tokens,
        latencyMs,
        costEstimate: estimateCost(params.model, response.usage.input_tokens, response.usage.output_tokens),
      };
    },
  };
}
