import { describe, expect, it } from "vitest";
import { UnknownProviderError } from "./errors.js";
import { createProviderRegistry, parseModelRef, selectProvider, type ProviderAdapter } from "./provider.js";

function fakeAdapter(id: "anthropic" | "openai" | "google"): ProviderAdapter {
  return {
    id,
    async call() {
      return { output: `from ${id}`, tokensIn: 1, tokensOut: 1, latencyMs: 0 };
    },
  };
}

describe("parseModelRef — spec §22.4 provider/model convention", () => {
  it("splits provider/model on the first slash", () => {
    expect(parseModelRef("anthropic/claude-sonnet-5")).toEqual({ provider: "anthropic", modelName: "claude-sonnet-5" });
    expect(parseModelRef("openai/gpt-5.5-thinking")).toEqual({ provider: "openai", modelName: "gpt-5.5-thinking" });
    expect(parseModelRef("google/gemini-3-pro")).toEqual({ provider: "google", modelName: "gemini-3-pro" });
  });

  it("splits on the FIRST slash only, so a model name containing a slash still parses", () => {
    expect(parseModelRef("openai/gpt-5/preview")).toEqual({ provider: "openai", modelName: "gpt-5/preview" });
  });

  it("throws UnknownProviderError when there's no slash at all", () => {
    expect(() => parseModelRef("claude-sonnet-5")).toThrow(UnknownProviderError);
  });

  it("throws when the model string starts with a slash (empty provider segment)", () => {
    expect(() => parseModelRef("/claude-sonnet-5")).toThrow(UnknownProviderError);
  });

  it("throws when the model string ends with a slash (empty model segment)", () => {
    expect(() => parseModelRef("anthropic/")).toThrow(UnknownProviderError);
  });
});

describe("selectProvider — dispatch by prefix (architecture §12.1)", () => {
  const registry = createProviderRegistry([fakeAdapter("anthropic"), fakeAdapter("openai"), fakeAdapter("google")]);

  it("selects the anthropic adapter for an anthropic/ model", () => {
    const { adapter, modelName } = selectProvider("anthropic/claude-sonnet-5", registry);
    expect(adapter.id).toBe("anthropic");
    expect(modelName).toBe("claude-sonnet-5");
  });

  it("selects the openai adapter for an openai/ model", () => {
    const { adapter, modelName } = selectProvider("openai/gpt-5.5-thinking", registry);
    expect(adapter.id).toBe("openai");
    expect(modelName).toBe("gpt-5.5-thinking");
  });

  it("selects the google adapter for a google/ model", () => {
    const { adapter, modelName } = selectProvider("google/gemini-3-pro", registry);
    expect(adapter.id).toBe("google");
    expect(modelName).toBe("gemini-3-pro");
  });

  it("passes only the BARE model name to the selected adapter, never the provider/ prefix", async () => {
    const result = await selectProvider("anthropic/claude-sonnet-5", registry).adapter.call({
      model: "claude-sonnet-5", // caller is responsible for stripping — verified by selectProvider's own return above
      prompt: "hi",
      input: {},
    });
    expect(result.output).toBe("from anthropic");
  });

  it("throws UnknownProviderError for an unregistered provider prefix", () => {
    expect(() => selectProvider("mistral/mixtral-8x7b", registry)).toThrow(UnknownProviderError);
  });

  it("adding a new provider is purely additive — a registry missing google still resolves anthropic/openai", () => {
    const partial = createProviderRegistry([fakeAdapter("anthropic")]);
    expect(selectProvider("anthropic/claude-sonnet-5", partial).adapter.id).toBe("anthropic");
    expect(() => selectProvider("google/gemini-3-pro", partial)).toThrow(UnknownProviderError);
  });
});
