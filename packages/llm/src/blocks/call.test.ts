import { createFsStore, type AartStore } from "@aart/store";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProviderRegistry, type ProviderAdapter } from "../provider.js";
import type { LlmBlockDeps } from "./core.js";
import { createLlmCallBlock, LLM_CALL_MANIFEST } from "./call.js";

function fakeAnthropic(output: unknown = "the answer"): ProviderAdapter {
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

describe("llm.call block — architecture §12.3", () => {
  let root: string;
  let deps: LlmBlockDeps;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), "aart-llm-call-block-"));
    const store: AartStore = createFsStore(root);
    deps = { store, providers: createProviderRegistry([fakeAnthropic()]) };
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("manifest.id is 'llm.call' with capability 'llm'", () => {
    expect(LLM_CALL_MANIFEST.id).toBe("llm.call");
    expect(LLM_CALL_MANIFEST.capabilities).toEqual(["llm"]);
  });

  it("manifest carries a model-facing description (spec §32.1)", () => {
    expect(LLM_CALL_MANIFEST.description.length).toBeGreaterThan(20);
  });

  it("execute() returns the plain output for a valid step", async () => {
    const block = createLlmCallBlock(deps);
    const result = await block.execute({ model: "anthropic/claude-sonnet-5", prompt: "Say hi.", input: {} }, fakeCtx());
    expect(result).toBe("the answer");
  });

  it("execute() rejects a malformed step via LlmCallStepSchema.parse (e.g. missing model)", async () => {
    const block = createLlmCallBlock(deps);
    await expect(block.execute({ prompt: "hi", input: {} }, fakeCtx())).rejects.toThrow();
  });

  it("execute() works with an outputSchema and validates the result", async () => {
    const deps2: LlmBlockDeps = { store: deps.store, providers: createProviderRegistry([fakeAnthropic({ ok: true })]) };
    const block = createLlmCallBlock(deps2);
    const result = await block.execute(
      { model: "anthropic/claude-sonnet-5", prompt: "hi", input: {}, outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } },
      fakeCtx(),
    );
    expect(result).toEqual({ ok: true });
  });
});
