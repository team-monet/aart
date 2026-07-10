// OpenAI provider adapter — architecture §12.1. Built against the OpenAI
// Chat Completions REST wire format (a long-stable, publicly documented
// shape) behind an injectable `Fetcher` (transport.ts) rather than the
// `openai` npm package — this package's own tests inject a fake `Fetcher`,
// never a real network call, matching this session's DoD ("no real API
// calls required for this session's own test suite"). See anthropic.ts's
// module comment for why this adapter's internal shape differs from the
// Anthropic one (independent verifiability of the exact binding this
// session), while still implementing the identical `ProviderAdapter`
// interface every caller sees.
import { LlmOutputParseError, ProviderHttpError } from "../errors.js";
import type { LlmCallParams, LlmCallResult, ProviderAdapter } from "../provider.js";
import { nodeFetcher, type Fetcher } from "./transport.js";

export interface OpenAiChatCompletionResponse {
  choices: Array<{ message: { content: string | null } }>;
  usage: { prompt_tokens: number; completion_tokens: number };
}

function buildMessageContent(params: LlmCallParams): string {
  if (params.input === undefined) return params.prompt;
  return `${params.prompt}\n\n${JSON.stringify(params.input)}`;
}

function parseJsonOutput(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new LlmOutputParseError({
      message: `OpenAI response was not valid JSON despite outputSchema being requested: ${(cause as Error).message}`,
      detail: { rawText: text },
      cause,
    });
  }
}

// No pricing table here — unlike anthropic.ts, this session has no
// independently-verified, current OpenAI pricing source to draw from (the
// bundled research this session ran was Anthropic-specific). Fabricating
// numbers for a COST estimate is worse than omitting them:
// `LlmCallMetadata.costEstimate` is optional exactly for this case, and
// every openai/* call therefore reports `costEstimate: undefined` until a
// real pricing table is populated by whoever has current, authoritative
// numbers — a one-line addition to this file when that's available (see
// anthropic.ts's PRICING_PER_MTOK for the shape to mirror).

export interface OpenAiAdapterOptions {
  apiKey?: string;
  fetcher?: Fetcher;
  /** Default "https://api.openai.com/v1" — overridable for Azure OpenAI / a compatible gateway, which is why this is exposed rather than hardcoded. */
  baseUrl?: string;
}

export function createOpenAiAdapter(options: OpenAiAdapterOptions = {}): ProviderAdapter {
  const fetcher = options.fetcher ?? nodeFetcher;
  const baseUrl = options.baseUrl ?? "https://api.openai.com/v1";

  return {
    id: "openai",
    async call(params: LlmCallParams): Promise<LlmCallResult> {
      const startedAt = Date.now();

      const body: Record<string, unknown> = {
        model: params.model,
        messages: [{ role: "user", content: buildMessageContent(params) }],
      };
      if (params.temperature !== undefined) body.temperature = params.temperature;
      if (params.maxTokens !== undefined) body.max_tokens = params.maxTokens;
      if (params.outputSchema !== undefined) {
        body.response_format = { type: "json_schema", json_schema: { name: "output", strict: true, schema: params.outputSchema } };
      }

      const response = await fetcher(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${options.apiKey ?? ""}` },
        body: JSON.stringify(body),
      });
      const latencyMs = Date.now() - startedAt;

      if (!response.ok) {
        throw new ProviderHttpError({ message: `OpenAI API returned HTTP ${response.status}`, detail: { status: response.status, body: await response.text() } });
      }

      const json = (await response.json()) as OpenAiChatCompletionResponse;
      const rawText = json.choices[0]?.message.content ?? "";
      const output = params.outputSchema !== undefined ? parseJsonOutput(rawText) : rawText;

      return {
        output,
        tokensIn: json.usage.prompt_tokens,
        tokensOut: json.usage.completion_tokens,
        latencyMs,
        costEstimate: undefined,
      };
    },
  };
}
