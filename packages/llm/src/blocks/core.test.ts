import { createFsStore, type AartStore } from "@aart/store";
import type { BlockExecutionContext, LlmCallStep } from "@aart/types";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LlmOutputSchemaValidationError, MissingPromptError } from "../errors.js";
import { createProviderRegistry, type LlmCallParams, type LlmCallResult, type ProviderAdapter } from "../provider.js";
import { registerPrompt, registerSchema } from "../registry.js";
import { llmCallCore, toBlockExecute, type LlmBlockDeps, type LlmBlockExecutionContext } from "./core.js";

function fakeProvider(id: "anthropic" | "openai" | "google", handler: (params: LlmCallParams) => LlmCallResult): ProviderAdapter {
  return { id, async call(params) { return handler(params); } };
}

function fakeCtx(overrides: Partial<BlockExecutionContext> = {}): BlockExecutionContext {
  return {
    runId: "run_1",
    stepId: "step_1",
    async resolveSecret() {
      return "unused";
    },
    async writeArtifact() {
      return { id: "artifact_1", path: "/artifacts/artifact_1" };
    },
    ...overrides,
  };
}

describe("llmCallCore — architecture §12.3 the generic llm.call engine", () => {
  let root: string;
  let store: AartStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), "aart-llm-core-"));
    store = createFsStore(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("with an inline prompt and no outputSchema: returns raw output, promptRef 'inline', promptVersion = content hash", async () => {
    const providers = createProviderRegistry([fakeProvider("anthropic", () => ({ output: "the summary", tokensIn: 10, tokensOut: 5, latencyMs: 12, costEstimate: 0.001 }))]);
    const step: LlmCallStep = { model: "anthropic/claude-sonnet-5", prompt: "Summarize this.", input: { text: "..." } };
    const result = await llmCallCore(step, { store, providers });

    expect(result.output).toBe("the summary");
    expect(result.llmCallMetadata.promptRef).toBe("inline");
    expect(result.llmCallMetadata.promptVersion).toBe(result.resolutions.prompt.contentHash);
    expect(result.llmCallMetadata.provider).toBe("anthropic");
    expect(result.llmCallMetadata.model).toBe("anthropic/claude-sonnet-5"); // full author-written string, spec §22.4
    expect(result.llmCallMetadata.tokensIn).toBe(10);
    expect(result.llmCallMetadata.tokensOut).toBe(5);
    expect(result.llmCallMetadata.latencyMs).toBe(12);
    expect(result.llmCallMetadata.costEstimate).toBe(0.001);
    expect(result.llmCallMetadata.schemaRef).toBeUndefined();
  });

  it("with a promptRef: resolves via the registry, promptRef/promptVersion reflect the registered entry", async () => {
    await registerPrompt(store, "energy_bill_extraction", "1.0.0", "Extract the bill fields.");
    const providers = createProviderRegistry([fakeProvider("openai", () => ({ output: "extracted", tokensIn: 1, tokensOut: 1, latencyMs: 1 }))]);
    const step: LlmCallStep = { model: "openai/gpt-5.5-thinking", promptRef: "prompts.energy_bill_extraction", input: {} };
    const result = await llmCallCore(step, { store, providers });

    expect(result.llmCallMetadata.promptRef).toBe("prompts.energy_bill_extraction");
    expect(result.llmCallMetadata.promptVersion).toBe("1.0.0");
    expect(result.llmCallMetadata.provider).toBe("openai");
  });

  it("with an inline outputSchema: validates the output and sets schemaRef 'inline'", async () => {
    const schema = { type: "object", properties: { label: { type: "string" } }, required: ["label"] };
    const providers = createProviderRegistry([fakeProvider("anthropic", () => ({ output: { label: "positive" }, tokensIn: 1, tokensOut: 1, latencyMs: 1 }))]);
    const step: LlmCallStep = { model: "anthropic/claude-sonnet-5", prompt: "Classify.", input: {}, outputSchema: schema };
    const result = await llmCallCore(step, { store, providers });

    expect(result.output).toEqual({ label: "positive" });
    expect(result.llmCallMetadata.schemaRef).toBe("inline");
  });

  it("with a schemaRef: resolves via the registry and validates against it", async () => {
    const schema = { type: "object", properties: { amount: { type: "number" } }, required: ["amount"] };
    await registerSchema(store, "energy_bill", "0.1.0", schema);
    const providers = createProviderRegistry([fakeProvider("anthropic", () => ({ output: { amount: 42 }, tokensIn: 1, tokensOut: 1, latencyMs: 1 }))]);
    const step: LlmCallStep = { model: "anthropic/claude-sonnet-5", prompt: "Extract.", input: {}, outputSchema: "schemas.energy_bill" };
    const result = await llmCallCore(step, { store, providers });

    expect(result.llmCallMetadata.schemaRef).toBe("schemas.energy_bill");
    expect(result.output).toEqual({ amount: 42 });
  });

  it("propagates LlmOutputSchemaValidationError when the provider's output doesn't match the resolved schema", async () => {
    const schema = { type: "object", properties: { amount: { type: "number" } }, required: ["amount"] };
    const providers = createProviderRegistry([fakeProvider("anthropic", () => ({ output: { amount: "not a number" }, tokensIn: 1, tokensOut: 1, latencyMs: 1 }))]);
    const step: LlmCallStep = { model: "anthropic/claude-sonnet-5", prompt: "Extract.", input: {}, outputSchema: schema };
    await expect(llmCallCore(step, { store, providers })).rejects.toThrow(LlmOutputSchemaValidationError);
  });

  it("throws MissingPromptError when neither prompt nor promptRef is set", async () => {
    const providers = createProviderRegistry([fakeProvider("anthropic", () => ({ output: "x", tokensIn: 1, tokensOut: 1, latencyMs: 1 }))]);
    const step = { model: "anthropic/claude-sonnet-5", input: {} } as LlmCallStep;
    await expect(llmCallCore(step, { store, providers })).rejects.toThrow(MissingPromptError);
  });

  it("passes maxTokens/temperature through to the selected provider", async () => {
    let seen: LlmCallParams | undefined;
    const providers = createProviderRegistry([
      fakeProvider("anthropic", (params) => {
        seen = params;
        return { output: "ok", tokensIn: 1, tokensOut: 1, latencyMs: 1 };
      }),
    ]);
    await llmCallCore({ model: "anthropic/claude-sonnet-5", prompt: "hi", input: {}, temperature: 0.5, maxTokens: 256 }, { store, providers });
    expect(seen?.temperature).toBe(0.5);
    expect(seen?.maxTokens).toBe(256);
    expect(seen?.model).toBe("claude-sonnet-5"); // bare model name, prefix already stripped before reaching the adapter
  });
});

describe("toBlockExecute — the BlockImplementation.execute adapter (architecture §2.5)", () => {
  let root: string;
  let store: AartStore;
  let deps: LlmBlockDeps;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), "aart-llm-core-execute-"));
    store = createFsStore(root);
    deps = { store, providers: createProviderRegistry([fakeProvider("anthropic", () => ({ output: "the plain output", tokensIn: 1, tokensOut: 1, latencyMs: 1 }))]) };
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("returns the PLAIN output — not { output, llmCallMetadata } — so {{ steps.X.outputs.field }} ergonomics stay correct", async () => {
    const execute = toBlockExecute<LlmCallStep>((raw) => raw as LlmCallStep, llmCallCore, deps);
    const result = await execute({ model: "anthropic/claude-sonnet-5", prompt: "hi", input: {} }, fakeCtx());
    expect(result).toBe("the plain output");
  });

  it("calls ctx.recordLlmCall with the metadata when the context provides it (SEAMS.md L3's proposed extension)", async () => {
    const calls: unknown[] = [];
    const ctx: LlmBlockExecutionContext = { ...fakeCtx(), recordLlmCall: (metadata) => calls.push(metadata) };
    const execute = toBlockExecute<LlmCallStep>((raw) => raw as LlmCallStep, llmCallCore, deps);
    await execute({ model: "anthropic/claude-sonnet-5", prompt: "hi", input: {} }, ctx);
    expect(calls).toHaveLength(1);
    expect((calls[0] as { provider: string }).provider).toBe("anthropic");
  });

  it("does NOT throw when ctx has no recordLlmCall — works against a bare BlockExecutionContext (defensive optional-chaining)", async () => {
    const execute = toBlockExecute<LlmCallStep>((raw) => raw as LlmCallStep, llmCallCore, deps);
    await expect(execute({ model: "anthropic/claude-sonnet-5", prompt: "hi", input: {} }, fakeCtx())).resolves.toBe("the plain output");
  });
});
