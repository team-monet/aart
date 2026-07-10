import { createFsStore, type AartStore } from "@aart/store";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProviderRegistry, type ProviderAdapter } from "../provider.js";
import type { LlmBlockDeps } from "./core.js";
import { createLlmGenerateBlock, LLM_GENERATE_MANIFEST } from "./generate.js";

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

describe("llm.generate block — architecture §12.3, the loosest wrapper (outputSchema stays optional)", () => {
  let root: string;
  let store: AartStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), "aart-llm-generate-block-"));
    store = createFsStore(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("manifest.id is 'llm.generate'", () => {
    expect(LLM_GENERATE_MANIFEST.id).toBe("llm.generate");
  });

  it("succeeds with NO outputSchema — free-form text generation is valid, unlike llm.extract", async () => {
    const deps: LlmBlockDeps = { store, providers: createProviderRegistry([fakeAnthropic("Once upon a time...")]) };
    const block = createLlmGenerateBlock(deps);
    const result = await block.execute({ model: "anthropic/claude-sonnet-5", prompt: "Write a short story opener.", input: {} }, fakeCtx());
    expect(result).toBe("Once upon a time...");
  });

  it("still validates output when a caller DOES supply outputSchema", async () => {
    const deps: LlmBlockDeps = { store, providers: createProviderRegistry([fakeAnthropic({ title: "A Tale" })]) };
    const block = createLlmGenerateBlock(deps);
    const result = await block.execute(
      { model: "anthropic/claude-sonnet-5", prompt: "Generate a title.", input: {}, outputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] } },
      fakeCtx(),
    );
    expect(result).toEqual({ title: "A Tale" });
  });
});
