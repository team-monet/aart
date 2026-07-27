import { afterEach, describe, expect, it } from "vitest";
import type { TestContext } from "../test-utils.js";
import { createTestContext } from "../test-utils.js";
import { findBlocksHandler, findWorkflowsHandler, getBlockHandler, getSchemaHandler, listBlocksHandler, proposeWorkflowHandler } from "./discovery.js";

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

  it("treats an empty result as a successful search with no match", async () => {
    tc = await createTestContext();
    const result = await findBlocksHandler(tc.ctx, { query: "xyzzy-nonexistent-capability" });
    expect(result.ok).toBe(true);
    expect(result.matched).toBe(false);
    expect(result.blocks).toEqual([]);
  });

  it("filters by category", async () => {
    tc = await createTestContext();
    const result = await findBlocksHandler(tc.ctx, { query: "goto", category: "http" });
    expect(result.blocks).toEqual([]);
  });

  it("searches the configured public index without mixing it into local-only results", async () => {
    tc = await createTestContext();
    const indexUrl = publicIndexUrl();
    const local = await findBlocksHandler(tc.ctx, { query: "public.demo", scope: "local", indexUrl });
    expect(local.blocks).toEqual([]);
    const remote = await findBlocksHandler(tc.ctx, { query: "public.demo", scope: "remote", indexUrl });
    expect(remote.blocks).toEqual([
      expect.objectContaining({
        id: "public.demo",
        packName: "public-demo",
        source: "public",
        catalogMode: "preview",
        examples: [{ description: "Reuse the public Block", inputs: { value: "demo" } }],
      }),
    ]);
  });
});

describe("findWorkflowsHandler (aart_find_workflows)", () => {
  it("searches the latest registered versions by reusable metadata", async () => {
    tc = await createTestContext();
    await tc.ctx.store.workflows.put({
      id: "release-proof",
      name: "Production release verification",
      version: "1.0.0",
      inputs: [],
      outputs: [],
      execution: { type: "workflow", steps: [] },
      approval: "approved",
      gates: { validate: "passed", readiness: "passed", evals: "passed", riskReview: "passed", humanReview: "passed" },
      category: "quality",
      keywords: ["deploy", "evidence"],
    });
    const result = await findWorkflowsHandler(tc.ctx, { query: "deploy" });
    expect(result.ok).toBe(true);
    expect(result.workflows).toEqual([
      expect.objectContaining({ id: "release-proof", version: "1.0.0", approval: "approved" }),
    ]);
  });

  it("returns an honest empty result instead of implying a reusable workflow exists", async () => {
    tc = await createTestContext();
    const result = await findWorkflowsHandler(tc.ctx, { query: "nothing-here" });
    expect(result.ok).toBe(true);
    expect(result.matched).toBe(false);
    expect(result.workflows).toEqual([]);
  });

  it("searches public Pack workflows with owning-pack provenance", async () => {
    tc = await createTestContext();
    const result = await findWorkflowsHandler(tc.ctx, {
      query: "remote reusable",
      scope: "remote",
      indexUrl: publicIndexUrl(),
    });
    expect(result.workflows).toEqual([
      expect.objectContaining({
        id: "public-demo-flow",
        packName: "public-demo",
        source: "public",
        catalogMode: "preview",
      }),
    ]);
  });
});

function publicIndexUrl(): string {
  const workflow = {
    id: "public-demo-flow",
    name: "Remote reusable flow",
    version: "1.0.0",
    inputs: [],
    outputs: [],
    execution: { type: "workflow", steps: [] },
    approval: "draft",
    gates: {
      validate: "pending",
      readiness: "pending",
      evals: "pending",
      riskReview: "pending",
      humanReview: "pending",
    },
  };
  const index = {
    mode: "preview",
    packs: [
      {
        npmPackageName: "aart-pack-public-demo",
        packName: "public-demo",
        version: "1.0.0",
        blocks: [
          {
            manifest: {
              id: "public.demo",
              version: "1.0.0",
              capabilities: [],
              inputSchema: {},
              outputSchema: {},
              description: "Public demo block",
            },
            examples: [{ description: "Reuse the public Block", inputs: { value: "demo" } }],
          },
        ],
        workflows: [workflow],
      },
    ],
  };
  return `data:application/json,${encodeURIComponent(JSON.stringify(index))}`;
}

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
