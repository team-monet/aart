import { describe, expect, it } from "vitest";
import { LlmOutputParseError, ProviderHttpError } from "../errors.js";
import type { LlmCallParams } from "../provider.js";
import { createGoogleAdapter } from "./google.js";
import type { Fetcher, HttpResponseLike } from "./transport.js";

function fakeFetcher(responseBody: unknown, status = 200): { fetcher: Fetcher; lastRequest: () => { url: string; body: Record<string, unknown> } | undefined } {
  let captured: { url: string; body: Record<string, unknown> } | undefined;
  const fetcher: Fetcher = async (url, init) => {
    captured = { url, body: JSON.parse(init.body) };
    const response: HttpResponseLike = {
      ok: status >= 200 && status < 300,
      status,
      async json() {
        return responseBody;
      },
      async text() {
        return JSON.stringify(responseBody);
      },
    };
    return response;
  };
  return { fetcher, lastRequest: () => captured };
}

const baseParams: LlmCallParams = { model: "gemini-3-pro", prompt: "Summarize this.", input: { text: "hello world" } };

describe("createGoogleAdapter — architecture §12.1, never a real API call in this test file", () => {
  it("reports id 'google'", () => {
    const { fetcher } = fakeFetcher({ candidates: [{ content: { parts: [{ text: "ok" }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } });
    expect(createGoogleAdapter({ fetcher }).id).toBe("google");
  });

  it("populates tokensIn/tokensOut from usageMetadata", async () => {
    const { fetcher } = fakeFetcher({ candidates: [{ content: { parts: [{ text: "answer" }] } }], usageMetadata: { promptTokenCount: 55, candidatesTokenCount: 21 } });
    const result = await createGoogleAdapter({ fetcher }).call(baseParams);
    expect(result.tokensIn).toBe(55);
    expect(result.tokensOut).toBe(21);
  });

  it("returns raw joined text output when no outputSchema requested", async () => {
    const { fetcher } = fakeFetcher({ candidates: [{ content: { parts: [{ text: "part a " }, { text: "part b" }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } });
    const result = await createGoogleAdapter({ fetcher }).call(baseParams);
    expect(result.output).toBe("part a part b");
  });

  it("parses JSON output and sends responseSchema/responseMimeType when outputSchema requested", async () => {
    const schema = { type: "object", properties: { label: { type: "string" } } };
    const { fetcher, lastRequest } = fakeFetcher({ candidates: [{ content: { parts: [{ text: '{"label":"pos"}' }] } }] , usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } });
    const result = await createGoogleAdapter({ fetcher }).call({ ...baseParams, outputSchema: schema });
    expect(result.output).toEqual({ label: "pos" });
    const config = lastRequest()?.body.generationConfig as Record<string, unknown>;
    expect(config.responseMimeType).toBe("application/json");
    expect(config.responseSchema).toEqual(schema);
  });

  it("throws LlmOutputParseError on non-JSON content when outputSchema requested", async () => {
    const { fetcher } = fakeFetcher({ candidates: [{ content: { parts: [{ text: "nope" }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } });
    await expect(createGoogleAdapter({ fetcher }).call({ ...baseParams, outputSchema: { type: "object" } })).rejects.toThrow(LlmOutputParseError);
  });

  it("forwards temperature/maxTokens as generationConfig.temperature/maxOutputTokens", async () => {
    const { fetcher, lastRequest } = fakeFetcher({ candidates: [{ content: { parts: [{ text: "ok" }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } });
    await createGoogleAdapter({ fetcher }).call({ ...baseParams, temperature: 0.3, maxTokens: 800 });
    const config = lastRequest()?.body.generationConfig as Record<string, unknown>;
    expect(config.temperature).toBe(0.3);
    expect(config.maxOutputTokens).toBe(800);
  });

  it("throws ProviderHttpError on a non-2xx response", async () => {
    const { fetcher } = fakeFetcher({ error: "boom" }, 429);
    await expect(createGoogleAdapter({ fetcher }).call(baseParams)).rejects.toThrow(ProviderHttpError);
  });

  it("costEstimate is always undefined — no fabricated pricing table for this provider", async () => {
    const { fetcher } = fakeFetcher({ candidates: [{ content: { parts: [{ text: "ok" }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } });
    const result = await createGoogleAdapter({ fetcher }).call(baseParams);
    expect(result.costEstimate).toBeUndefined();
  });

  it("posts to the models/{model}:generateContent endpoint with the bare model name", async () => {
    const { fetcher, lastRequest } = fakeFetcher({ candidates: [{ content: { parts: [{ text: "ok" }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } });
    await createGoogleAdapter({ fetcher }).call(baseParams);
    expect(lastRequest()?.url).toContain("/models/gemini-3-pro:generateContent");
  });
});
