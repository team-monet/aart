// Google provider adapter — architecture §12.1. Built against the Gemini
// `generateContent` REST wire format behind an injectable `Fetcher`
// (transport.ts). See openai.ts's module comment — same rationale applies
// here (uniform injectable-REST-transport shape for the two providers this
// session has no independently-verified SDK-binding source for).
import { LlmOutputParseError, ProviderHttpError } from "../errors.js";
import type { LlmCallParams, LlmCallResult, ProviderAdapter } from "../provider.js";
import { nodeFetcher, type Fetcher } from "./transport.js";

export interface GoogleGenerateContentResponse {
  candidates: Array<{ content: { parts: Array<{ text?: string }> } }>;
  usageMetadata: { promptTokenCount: number; candidatesTokenCount: number };
}

function buildParts(params: LlmCallParams): Array<{ text: string }> {
  if (params.input === undefined) return [{ text: params.prompt }];
  return [{ text: `${params.prompt}\n\n${JSON.stringify(params.input)}` }];
}

function parseJsonOutput(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new LlmOutputParseError({
      message: `Google response was not valid JSON despite outputSchema being requested: ${(cause as Error).message}`,
      detail: { rawText: text },
      cause,
    });
  }
}

// No pricing table — same reasoning as openai.ts: no independently-verified,
// current Google pricing source this session. costEstimate is always
// undefined here until a real table is populated.

export interface GoogleAdapterOptions {
  apiKey?: string;
  fetcher?: Fetcher;
  /** Default "https://generativelanguage.googleapis.com/v1beta" — overridable for Vertex AI's differently-shaped endpoint, which callers can point this at once they inject a matching fetcher/baseUrl pair. */
  baseUrl?: string;
}

export function createGoogleAdapter(options: GoogleAdapterOptions = {}): ProviderAdapter {
  const fetcher = options.fetcher ?? nodeFetcher;
  const baseUrl = options.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";

  return {
    id: "google",
    async call(params: LlmCallParams): Promise<LlmCallResult> {
      const startedAt = Date.now();

      const generationConfig: Record<string, unknown> = {};
      if (params.temperature !== undefined) generationConfig.temperature = params.temperature;
      if (params.maxTokens !== undefined) generationConfig.maxOutputTokens = params.maxTokens;
      if (params.outputSchema !== undefined) {
        generationConfig.responseMimeType = "application/json";
        generationConfig.responseSchema = params.outputSchema;
      }

      const body: Record<string, unknown> = {
        contents: [{ role: "user", parts: buildParts(params) }],
        ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
      };

      const response = await fetcher(`${baseUrl}/models/${encodeURIComponent(params.model)}:generateContent?key=${encodeURIComponent(options.apiKey ?? "")}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const latencyMs = Date.now() - startedAt;

      if (!response.ok) {
        throw new ProviderHttpError({ message: `Google API returned HTTP ${response.status}`, detail: { status: response.status, body: await response.text() } });
      }

      const json = (await response.json()) as GoogleGenerateContentResponse;
      const rawText = (json.candidates[0]?.content.parts ?? []).map((part) => part.text ?? "").join("");
      const output = params.outputSchema !== undefined ? parseJsonOutput(rawText) : rawText;

      return {
        output,
        tokensIn: json.usageMetadata.promptTokenCount,
        tokensOut: json.usageMetadata.candidatesTokenCount,
        latencyMs,
        costEstimate: undefined,
      };
    },
  };
}
