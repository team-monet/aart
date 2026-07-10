import { createFsStore, type AartStore } from "@aart/store";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MissingOutputSchemaError } from "../errors.js";
import { createProviderRegistry, type ProviderAdapter } from "../provider.js";
import type { LlmBlockDeps } from "./core.js";
import { createLlmExtractBlock, LLM_EXTRACT_MANIFEST } from "./extract.js";

function fakeAnthropic(output: unknown): ProviderAdapter {
  return { id: "anthropic", async call() { return { output, tokensIn: 3, tokensOut: 2, latencyMs: 5 }; } };
}
function fakeCtx() {
  return {
    runId: "run_1",
    stepId: "step_1",
    async resolveSecret() { return ""; },
    async writeArtifact() { return { id: "a", path: "/a" }; },
  };
}

describe("llm.extract block — architecture §12.3: outputSchema REQUIRED", () => {
  let root: string;
  let deps: LlmBlockDeps;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), "aart-llm-extract-block-"));
    const store: AartStore = createFsStore(root);
    deps = { store, providers: createProviderRegistry([fakeAnthropic({ amount: 42, currency: "USD" })]) };
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("manifest.id is 'llm.extract'", () => {
    expect(LLM_EXTRACT_MANIFEST.id).toBe("llm.extract");
  });

  it("execute() succeeds and returns the validated extraction when outputSchema is provided", async () => {
    const block = createLlmExtractBlock(deps);
    const result = await block.execute(
      {
        model: "anthropic/claude-sonnet-5",
        prompt: "Extract the bill amount.",
        input: { text: "Your bill is $42 USD" },
        outputSchema: { type: "object", properties: { amount: { type: "number" }, currency: { type: "string" } }, required: ["amount", "currency"] },
      },
      fakeCtx(),
    );
    expect(result).toEqual({ amount: 42, currency: "USD" });
  });

  it("execute() throws MissingOutputSchemaError when outputSchema is omitted — extract's own convention", async () => {
    const block = createLlmExtractBlock(deps);
    await expect(block.execute({ model: "anthropic/claude-sonnet-5", prompt: "Extract.", input: {} }, fakeCtx())).rejects.toThrow(MissingOutputSchemaError);
  });

  it("manifest's inputSchema documents outputSchema as required (spec §32.1 model-native design law)", () => {
    const inputSchema = LLM_EXTRACT_MANIFEST.inputSchema as { required?: string[] };
    expect(inputSchema.required).toContain("outputSchema");
  });
});
