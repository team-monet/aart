import { createFsStore, type AartStore } from "@aart/store";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AnthropicClientLike } from "./providers/anthropic.js";
import type { Fetcher, HttpResponseLike } from "./providers/transport.js";
import { createLlmPack } from "./index.js";

function fakeAnthropicClient(text = "ok"): AnthropicClientLike {
  return {
    messages: {
      async create() {
        return { content: [{ type: "text", text }], usage: { input_tokens: 1, output_tokens: 1 } };
      },
    },
  };
}

function fakeOpenAiFetcher(): Fetcher {
  return async (): Promise<HttpResponseLike> => ({
    ok: true,
    status: 200,
    async json() {
      return { choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
    },
    async text() {
      return "ok";
    },
  });
}

function fakeGoogleFetcher(): Fetcher {
  return async (): Promise<HttpResponseLike> => ({
    ok: true,
    status: 200,
    async json() {
      return { candidates: [{ content: { parts: [{ text: "ok" }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } };
    },
    async text() {
      return "ok";
    },
  });
}

describe("createLlmPack — the composition-root convenience wiring all 3 providers + all 5 llm.* blocks", () => {
  let root: string;
  let store: AartStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), "aart-llm-pack-"));
    store = createFsStore(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("registers all three providers", () => {
    const pack = createLlmPack({
      store,
      anthropic: { client: fakeAnthropicClient() },
      openai: { fetcher: fakeOpenAiFetcher() },
      google: { fetcher: fakeGoogleFetcher() },
    });
    expect(Object.keys(pack.providers).sort()).toEqual(["anthropic", "google", "openai"]);
  });

  it("provides exactly the five llm.* blocks named in architecture §12.3, each with a matching manifest.id", () => {
    const pack = createLlmPack({
      store,
      anthropic: { client: fakeAnthropicClient() },
      openai: { fetcher: fakeOpenAiFetcher() },
      google: { fetcher: fakeGoogleFetcher() },
    });
    const ids = pack.blocks.map((b) => b.manifest.id).sort();
    expect(ids).toEqual(["llm.call", "llm.classify", "llm.extract", "llm.generate", "llm.judge"]);
  });

  it("every block declares capabilities: ['llm'] (architecture §31.0 taxonomy)", () => {
    const pack = createLlmPack({ store, anthropic: { client: fakeAnthropicClient() }, openai: { fetcher: fakeOpenAiFetcher() }, google: { fetcher: fakeGoogleFetcher() } });
    for (const block of pack.blocks) {
      expect(block.manifest.capabilities).toEqual(["llm"]);
    }
  });

  it("llmJudge is directly callable and returns the LlmJudgeFn shape", async () => {
    const pack = createLlmPack({
      store,
      anthropic: { client: fakeAnthropicClient(JSON.stringify({ passed: true, score: 1 })) },
      openai: { fetcher: fakeOpenAiFetcher() },
      google: { fetcher: fakeGoogleFetcher() },
    });
    const verdict = await pack.llmJudge({ model: "anthropic/claude-sonnet-5", actual: "x", expected: "x" });
    expect(verdict).toEqual({ passed: true, score: 1 });
  });

  it("end-to-end: llm.call block dispatches through the anthropic adapter and returns the fake's output", async () => {
    const pack = createLlmPack({ store, anthropic: { client: fakeAnthropicClient("hello from the fake") }, openai: { fetcher: fakeOpenAiFetcher() }, google: { fetcher: fakeGoogleFetcher() } });
    const callBlock = pack.blocks.find((b) => b.manifest.id === "llm.call")!;
    const ctx = { runId: "r", stepId: "s", async resolveSecret() { return ""; }, async writeArtifact() { return { id: "a", path: "/a" }; } };
    const result = await callBlock.execute({ model: "anthropic/claude-sonnet-5", prompt: "hi", input: {} }, ctx);
    expect(result).toBe("hello from the fake");
  });
});
