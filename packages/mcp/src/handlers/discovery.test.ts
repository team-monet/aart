import { afterEach, describe, expect, it } from "vitest";
import type { TestContext } from "../test-utils.js";
import { createTestContext } from "../test-utils.js";
import { findBlocksHandler, getBlockHandler, getSchemaHandler, listBlocksHandler, proposeWorkflowHandler } from "./discovery.js";

let tc: TestContext;
afterEach(async () => {
  await tc?.cleanup();
});

describe("findBlocksHandler (aart_find_blocks)", () => {
  it("finds browser.goto by a natural-language query", async () => {
    tc = await createTestContext();
    const result = await findBlocksHandler(tc.ctx, { query: "open page" });
    expect(result.ok).toBe(true);
    expect((result.blocks as { id: string }[]).some((b) => b.id === "browser.goto")).toBe(true);
  });

  it("returns ok:false with an empty list when nothing matches", async () => {
    tc = await createTestContext();
    const result = await findBlocksHandler(tc.ctx, { query: "xyzzy-nonexistent-capability" });
    expect(result.ok).toBe(false);
    expect(result.blocks).toEqual([]);
  });

  it("filters by category", async () => {
    tc = await createTestContext();
    const result = await findBlocksHandler(tc.ctx, { query: "goto", category: "http" });
    expect(result.blocks).toEqual([]);
  });
});

describe("getBlockHandler (aart_get_block)", () => {
  it("returns the full manifest for a known block id", async () => {
    tc = await createTestContext();
    const result = await getBlockHandler(tc.ctx, { id: "http.request" });
    expect(result.ok).toBe(true);
    expect((result.block as { id: string }).id).toBe("http.request");
  });

  it("returns ok:false for an unknown block id", async () => {
    tc = await createTestContext();
    const result = await getBlockHandler(tc.ctx, { id: "nope.nonexistent" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Unknown block id/);
  });
});

describe("listBlocksHandler (aart_list_blocks)", () => {
  it("lists the full catalog", async () => {
    tc = await createTestContext();
    const result = await listBlocksHandler(tc.ctx, {});
    expect(result.ok).toBe(true);
    expect((result.blocks as unknown[]).length).toBeGreaterThan(10);
  });

  it("filters by category", async () => {
    tc = await createTestContext();
    const result = await listBlocksHandler(tc.ctx, { category: "assert" });
    expect(result.ok).toBe(true);
    for (const block of result.blocks as { category?: string }[]) expect(block.category).toBe("assert");
  });
});

describe("getSchemaHandler (aart_get_schema)", () => {
  it("returns the real Workflow JSON Schema for kind=workflow", async () => {
    tc = await createTestContext();
    const result = await getSchemaHandler(tc.ctx, { kind: "workflow" });
    expect(result.ok).toBe(true);
    const schema = result.schema as { properties?: Record<string, unknown> };
    expect(schema.properties).toHaveProperty("id");
    expect(schema.properties).toHaveProperty("execution");
  });

  it("returns a block's input/output schema for kind=block", async () => {
    tc = await createTestContext();
    const result = await getSchemaHandler(tc.ctx, { kind: "block", blockId: "assert.equals" });
    expect(result.ok).toBe(true);
    expect(result.inputSchema).toBeDefined();
    expect(result.outputSchema).toBeDefined();
  });

  it("fails when kind=block has no blockId", async () => {
    tc = await createTestContext();
    const result = await getSchemaHandler(tc.ctx, { kind: "block" });
    expect(result.ok).toBe(false);
  });

  it("fails for an unknown blockId", async () => {
    tc = await createTestContext();
    const result = await getSchemaHandler(tc.ctx, { kind: "block", blockId: "nope" });
    expect(result.ok).toBe(false);
  });
});

describe("proposeWorkflowHandler (aart_propose_workflow)", () => {
  it("returns a recipe skeleton for a matching request, without calling an LLM", async () => {
    tc = await createTestContext();
    const result = await proposeWorkflowHandler(tc.ctx, { request: "verify page renders" });
    expect(result.ok).toBe(true);
    expect(result.recipeId).toBe("verify-page-renders");
    expect(typeof result.skeleton).toBe("string");
  });

  it("returns ok:false when no recipe matches", async () => {
    tc = await createTestContext();
    const result = await proposeWorkflowHandler(tc.ctx, { request: "reticulate splines" });
    expect(result.ok).toBe(false);
  });
});
