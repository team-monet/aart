import { describe, expect, it } from "vitest";
import { BlockManifestSchema, type BlockExecutionContext, type BlockImplementation } from "./block.js";

describe("BlockManifestSchema", () => {
  it("round-trips a BlockManifest (architecture §2.5)", () => {
    const input = {
      id: "browser.click",
      version: "1.0.0",
      capabilities: ["browser"],
      inputSchema: { type: "object", properties: { selector: { type: "string" } } },
      outputSchema: { type: "object" },
      description: "Clicks a DOM element matched by selector.",
      category: "browser",
    };
    expect(BlockManifestSchema.parse(input)).toEqual(input);
  });

  it("allows an empty capabilities array (a block that requires no capability, e.g. assert.*)", () => {
    const parsed = BlockManifestSchema.parse({
      id: "assert.contains",
      version: "1.0.0",
      capabilities: [],
      inputSchema: {},
      outputSchema: {},
      description: "Asserts a string contains a substring.",
    });
    expect(parsed.capabilities).toEqual([]);
  });

  it("rejects a manifest missing description (model-facing, spec §32.1)", () => {
    const result = BlockManifestSchema.safeParse({
      id: "http.request",
      version: "1.0.0",
      capabilities: ["http"],
      inputSchema: {},
      outputSchema: {},
    });
    expect(result.success).toBe(false);
  });
});

describe("BlockImplementation contract (type-level check)", () => {
  it("accepts an execute function matching (resolvedInputs, ctx) => Promise<unknown>, per architecture §2.5's frozen shape", async () => {
    const ctx: BlockExecutionContext = {
      runId: "run_1",
      stepId: "step_1",
      resolveSecret: async (ref: string) => `resolved:${ref}`,
      writeArtifact: async (input) => ({ id: "art_1", path: `artifacts/run_1/art_1.${input.mime}` }),
    };
    const impl: BlockImplementation = {
      manifest: {
        id: "data.identity",
        version: "1.0.0",
        capabilities: [],
        inputSchema: {},
        outputSchema: {},
        description: "Returns its input unchanged.",
      },
      execute: async (resolvedInputs) => resolvedInputs,
    };
    await expect(impl.execute({ x: 1 }, ctx)).resolves.toEqual({ x: 1 });
    await expect(ctx.resolveSecret("secrets.FOO")).resolves.toBe("resolved:secrets.FOO");
  });
});
