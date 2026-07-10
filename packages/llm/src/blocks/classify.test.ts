import { createFsStore, type AartStore } from "@aart/store";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LlmOutputSchemaValidationError, MissingOutputSchemaError } from "../errors.js";
import { createProviderRegistry, type LlmCallParams, type ProviderAdapter } from "../provider.js";
import { classificationSchemaFromLabels, createLlmClassifyBlock, LLM_CLASSIFY_MANIFEST } from "./classify.js";
import type { LlmBlockDeps } from "./core.js";

function fakeProviderReturning(output: unknown): { adapter: ProviderAdapter; seen: () => LlmCallParams | undefined } {
  let seen: LlmCallParams | undefined;
  return {
    adapter: {
      id: "anthropic",
      async call(params) {
        seen = params;
        return { output, tokensIn: 1, tokensOut: 1, latencyMs: 1 };
      },
    },
    seen: () => seen,
  };
}
function fakeCtx() {
  return {
    runId: "run_1",
    stepId: "step_1",
    async resolveSecret() { return ""; },
    async writeArtifact() { return { id: "a", path: "/a" }; },
  };
}

describe("classificationSchemaFromLabels", () => {
  it("builds an enum-classification JSON Schema from a label list", () => {
    const schema = classificationSchemaFromLabels(["positive", "negative", "neutral"]);
    expect(schema).toEqual({
      type: "object",
      properties: { label: { enum: ["positive", "negative", "neutral"] }, confidence: { type: "number", minimum: 0, maximum: 1 } },
      required: ["label"],
      additionalProperties: false,
    });
  });
});

describe("llm.classify block — architecture §12.3: enum-like classification convention", () => {
  let root: string;
  let store: AartStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), "aart-llm-classify-block-"));
    store = createFsStore(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("manifest.id is 'llm.classify'", () => {
    expect(LLM_CLASSIFY_MANIFEST.id).toBe("llm.classify");
  });

  it("with `labels`, synthesizes the enum-classification outputSchema and sends it to the provider", async () => {
    const { adapter, seen } = fakeProviderReturning({ label: "positive", confidence: 0.9 });
    const deps: LlmBlockDeps = { store, providers: createProviderRegistry([adapter]) };
    const block = createLlmClassifyBlock(deps);
    const result = await block.execute({ model: "anthropic/claude-sonnet-5", prompt: "Classify sentiment.", input: { text: "great!" }, labels: ["positive", "negative", "neutral"] }, fakeCtx());
    expect(result).toEqual({ label: "positive", confidence: 0.9 });
    expect(seen()?.outputSchema).toEqual(classificationSchemaFromLabels(["positive", "negative", "neutral"]));
  });

  it("rejects a classification result whose label isn't in the given label set", async () => {
    const { adapter } = fakeProviderReturning({ label: "not-a-real-label" });
    const deps: LlmBlockDeps = { store, providers: createProviderRegistry([adapter]) };
    const block = createLlmClassifyBlock(deps);
    await expect(
      block.execute({ model: "anthropic/claude-sonnet-5", prompt: "Classify.", input: {}, labels: ["a", "b"] }, fakeCtx()),
    ).rejects.toThrow(LlmOutputSchemaValidationError);
  });

  it("an explicit outputSchema takes precedence over labels when both are given", async () => {
    const customSchema = { type: "object", properties: { category: { type: "string" } }, required: ["category"] };
    const { adapter, seen } = fakeProviderReturning({ category: "x" });
    const deps: LlmBlockDeps = { store, providers: createProviderRegistry([adapter]) };
    const block = createLlmClassifyBlock(deps);
    await block.execute({ model: "anthropic/claude-sonnet-5", prompt: "Classify.", input: {}, labels: ["a", "b"], outputSchema: customSchema }, fakeCtx());
    expect(seen()?.outputSchema).toEqual(customSchema);
  });

  it("throws MissingOutputSchemaError when neither labels nor outputSchema is given", async () => {
    const { adapter } = fakeProviderReturning({ label: "x" });
    const deps: LlmBlockDeps = { store, providers: createProviderRegistry([adapter]) };
    const block = createLlmClassifyBlock(deps);
    await expect(block.execute({ model: "anthropic/claude-sonnet-5", prompt: "Classify.", input: {} }, fakeCtx())).rejects.toThrow(MissingOutputSchemaError);
  });
});
