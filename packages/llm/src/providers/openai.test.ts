import { describe, expect, it } from "vitest";
import { LlmOutputParseError, ProviderHttpError } from "../errors.js";
import type { LlmCallParams } from "../provider.js";
import { createOpenAiAdapter } from "./openai.js";
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

const baseParams: LlmCallParams = { model: "gpt-5.5-thinking", prompt: "Summarize this.", input: { text: "hello world" } };

describe("createOpenAiAdapter — architecture §12.1, never a real API call in this test file", () => {
  it("reports id 'openai'", () => {
    const { fetcher } = fakeFetcher({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    expect(createOpenAiAdapter({ fetcher }).id).toBe("openai");
  });

  it("populates tokensIn/tokensOut from usage.prompt_tokens/completion_tokens", async () => {
    const { fetcher } = fakeFetcher({ choices: [{ message: { content: "the answer" } }], usage: { prompt_tokens: 30, completion_tokens: 12 } });
    const result = await createOpenAiAdapter({ fetcher }).call(baseParams);
    expect(result.tokensIn).toBe(30);
    expect(result.tokensOut).toBe(12);
  });

  it("returns raw text output when no outputSchema requested", async () => {
    const { fetcher } = fakeFetcher({ choices: [{ message: { content: "plain answer" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    const result = await createOpenAiAdapter({ fetcher }).call(baseParams);
    expect(result.output).toBe("plain answer");
  });

  it("parses JSON output and sends response_format when outputSchema requested", async () => {
    const schema = { type: "object", properties: { label: { type: "string" } } };
    const { fetcher, lastRequest } = fakeFetcher({ choices: [{ message: { content: '{"label":"neg"}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    const result = await createOpenAiAdapter({ fetcher }).call({ ...baseParams, outputSchema: schema });
    expect(result.output).toEqual({ label: "neg" });
    expect(lastRequest()?.body.response_format).toEqual({ type: "json_schema", json_schema: { name: "output", strict: true, schema } });
  });

  it("throws LlmOutputParseError on non-JSON content when outputSchema requested", async () => {
    const { fetcher } = fakeFetcher({ choices: [{ message: { content: "nope" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    await expect(createOpenAiAdapter({ fetcher }).call({ ...baseParams, outputSchema: { type: "object" } })).rejects.toThrow(LlmOutputParseError);
  });

  it("forwards temperature and maxTokens", async () => {
    const { fetcher, lastRequest } = fakeFetcher({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    await createOpenAiAdapter({ fetcher }).call({ ...baseParams, temperature: 0.7, maxTokens: 500 });
    expect(lastRequest()?.body.temperature).toBe(0.7);
    expect(lastRequest()?.body.max_tokens).toBe(500);
  });

  it("throws ProviderHttpError on a non-2xx response", async () => {
    const { fetcher } = fakeFetcher({ error: "boom" }, 500);
    await expect(createOpenAiAdapter({ fetcher }).call(baseParams)).rejects.toThrow(ProviderHttpError);
  });

  it("costEstimate is always undefined — no fabricated pricing table for this provider", async () => {
    const { fetcher } = fakeFetcher({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    const result = await createOpenAiAdapter({ fetcher }).call(baseParams);
    expect(result.costEstimate).toBeUndefined();
  });

  it("posts to the chat/completions endpoint with the bare (already-stripped) model name", async () => {
    const { fetcher, lastRequest } = fakeFetcher({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    await createOpenAiAdapter({ fetcher }).call(baseParams);
    expect(lastRequest()?.url).toContain("/chat/completions");
    expect(lastRequest()?.body.model).toBe("gpt-5.5-thinking");
  });
});
