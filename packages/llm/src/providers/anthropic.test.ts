import { describe, expect, it } from "vitest";
import { LlmOutputParseError } from "../errors.js";
import type { LlmCallParams } from "../provider.js";
import { createAnthropicAdapter, type AnthropicClientLike, type AnthropicMessageResponse } from "./anthropic.js";

function fakeClient(response: AnthropicMessageResponse): { client: AnthropicClientLike; lastRequest: () => Record<string, unknown> | undefined } {
  let captured: Record<string, unknown> | undefined;
  return {
    client: {
      messages: {
        async create(params) {
          captured = params;
          return response;
        },
      },
    },
    lastRequest: () => captured,
  };
}

const baseParams: LlmCallParams = { model: "claude-sonnet-5", prompt: "Summarize this.", input: { text: "hello world" } };

describe("createAnthropicAdapter — architecture §12.1, never a real API call in this test file", () => {
  it("reports id 'anthropic'", () => {
    const { client } = fakeClient({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } });
    expect(createAnthropicAdapter({ client }).id).toBe("anthropic");
  });

  it("populates tokensIn/tokensOut directly from the provider response's usage — DoD's own framing", async () => {
    const { client } = fakeClient({ content: [{ type: "text", text: "the answer" }], usage: { input_tokens: 42, output_tokens: 17 } });
    const result = await createAnthropicAdapter({ client }).call(baseParams);
    expect(result.tokensIn).toBe(42);
    expect(result.tokensOut).toBe(17);
  });

  it("returns raw text as output when no outputSchema was requested", async () => {
    const { client } = fakeClient({ content: [{ type: "text", text: "plain text answer" }], usage: { input_tokens: 1, output_tokens: 1 } });
    const result = await createAnthropicAdapter({ client }).call(baseParams);
    expect(result.output).toBe("plain text answer");
  });

  it("parses JSON output when outputSchema was requested, and sends output_config.format in the request", async () => {
    const { client, lastRequest } = fakeClient({ content: [{ type: "text", text: '{"label":"positive","confidence":0.9}' }], usage: { input_tokens: 1, output_tokens: 1 } });
    const schema = { type: "object", properties: { label: { type: "string" } } };
    const result = await createAnthropicAdapter({ client }).call({ ...baseParams, outputSchema: schema });
    expect(result.output).toEqual({ label: "positive", confidence: 0.9 });
    expect(lastRequest()?.output_config).toEqual({ format: { type: "json_schema", schema } });
  });

  it("throws LlmOutputParseError when outputSchema was requested but the response text isn't valid JSON", async () => {
    const { client } = fakeClient({ content: [{ type: "text", text: "not json at all" }], usage: { input_tokens: 1, output_tokens: 1 } });
    await expect(createAnthropicAdapter({ client }).call({ ...baseParams, outputSchema: { type: "object" } })).rejects.toThrow(LlmOutputParseError);
  });

  it("defaults max_tokens to 4096 when maxTokens isn't specified on the step", async () => {
    const { client, lastRequest } = fakeClient({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } });
    await createAnthropicAdapter({ client }).call(baseParams);
    expect(lastRequest()?.max_tokens).toBe(4096);
  });

  it("forwards an explicit maxTokens through as max_tokens", async () => {
    const { client, lastRequest } = fakeClient({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } });
    await createAnthropicAdapter({ client }).call({ ...baseParams, maxTokens: 2048 });
    expect(lastRequest()?.max_tokens).toBe(2048);
  });

  it("forwards temperature for a model that still accepts sampling params", async () => {
    const { client, lastRequest } = fakeClient({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } });
    await createAnthropicAdapter({ client }).call({ ...baseParams, model: "claude-sonnet-4-6", temperature: 0.4 });
    expect(lastRequest()?.temperature).toBe(0.4);
  });

  it("DROPS temperature for a model on which sampling params 400 (claude-opus-4-8) — a real, current API contract, not a guess", async () => {
    const { client, lastRequest } = fakeClient({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } });
    await createAnthropicAdapter({ client }).call({ ...baseParams, model: "claude-opus-4-8", temperature: 0.4 });
    expect(lastRequest()?.temperature).toBeUndefined();
  });

  it("also drops temperature for claude-sonnet-5 and claude-fable-5", async () => {
    const { client, lastRequest } = fakeClient({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } });
    await createAnthropicAdapter({ client }).call({ ...baseParams, model: "claude-sonnet-5", temperature: 0.2 });
    expect(lastRequest()?.temperature).toBeUndefined();
    await createAnthropicAdapter({ client }).call({ ...baseParams, model: "claude-fable-5", temperature: 0.2 });
    expect(lastRequest()?.temperature).toBeUndefined();
  });

  it("computes costEstimate from the current published per-model rate table", async () => {
    const { client } = fakeClient({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 } });
    const result = await createAnthropicAdapter({ client }).call({ ...baseParams, model: "claude-opus-4-8" });
    // $5/MTok in + $25/MTok out at exactly 1M tokens each
    expect(result.costEstimate).toBeCloseTo(30, 5);
  });

  it("costEstimate is undefined for a model with no pricing-table entry — never a fabricated number", async () => {
    const { client } = fakeClient({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 100, output_tokens: 100 } });
    const result = await createAnthropicAdapter({ client }).call({ ...baseParams, model: "claude-3-opus-legacy-hypothetical" });
    expect(result.costEstimate).toBeUndefined();
  });

  it("latencyMs is a non-negative number", async () => {
    const { client } = fakeClient({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } });
    const result = await createAnthropicAdapter({ client }).call(baseParams);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("concatenates multiple text content blocks", async () => {
    const { client } = fakeClient({ content: [{ type: "text", text: "part one " }, { type: "text", text: "part two" }], usage: { input_tokens: 1, output_tokens: 1 } });
    const result = await createAnthropicAdapter({ client }).call(baseParams);
    expect(result.output).toBe("part one part two");
  });
});
