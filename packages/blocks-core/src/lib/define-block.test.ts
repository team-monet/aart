import { describe, expect, it } from "vitest";
import { z } from "zod";
import { BlockSchemaError, defineBlock } from "./define-block.js";
import { fakeExecutionContext } from "../test-support/fake-context.js";

describe("defineBlock", () => {
  it("builds a manifest with derived JSON Schema, description, category, and capabilities", () => {
    const block = defineBlock({
      id: "test.echo",
      capabilities: ["http"],
      description: "Echoes its input back.",
      category: "test",
      inputSchema: z.object({ value: z.string() }),
      outputSchema: z.object({ value: z.string() }),
      execute: async (input) => ({ value: input.value }),
    });

    expect(block.manifest.id).toBe("test.echo");
    expect(block.manifest.version).toBe("0.1.0");
    expect(block.manifest.capabilities).toEqual(["http"]);
    expect(block.manifest.description).toBe("Echoes its input back.");
    expect(block.manifest.category).toBe("test");
    expect(block.manifest.inputSchema).toMatchObject({ type: "object" });
    expect(block.manifest.outputSchema).toMatchObject({ type: "object" });
  });

  it("allows an empty capability set (possibly-empty is valid per the metadata-completeness contract)", () => {
    const block = defineBlock({
      id: "test.noop",
      capabilities: [],
      description: "Does nothing.",
      category: "test",
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      execute: async () => ({}),
    });
    expect(block.manifest.capabilities).toEqual([]);
  });

  it("parses resolvedInputs against the input schema before calling execute", async () => {
    const block = defineBlock({
      id: "test.add",
      capabilities: [],
      description: "Adds one.",
      category: "test",
      inputSchema: z.object({ n: z.number() }),
      outputSchema: z.object({ n: z.number() }),
      execute: async (input) => ({ n: input.n + 1 }),
    });

    const result = await block.execute({ n: 1 }, fakeExecutionContext());
    expect(result).toEqual({ n: 2 });
  });

  it("throws BlockSchemaError (not a raw ZodError) when resolvedInputs don't match the input schema", async () => {
    const block = defineBlock({
      id: "test.add",
      capabilities: [],
      description: "Adds one.",
      category: "test",
      inputSchema: z.object({ n: z.number() }),
      outputSchema: z.object({ n: z.number() }),
      execute: async (input) => ({ n: input.n + 1 }),
    });

    await expect(block.execute({ n: "not-a-number" }, fakeExecutionContext())).rejects.toThrow(BlockSchemaError);
    await expect(block.execute({ n: "not-a-number" }, fakeExecutionContext())).rejects.toThrow(/input failed schema validation/);
  });

  it("throws BlockSchemaError when the block's own computed output doesn't match its declared output schema", async () => {
    const block = defineBlock({
      id: "test.broken",
      capabilities: [],
      description: "Lies about its own output shape.",
      category: "test",
      inputSchema: z.object({}),
      outputSchema: z.object({ n: z.number() }),
      // @ts-expect-error — deliberately wrong at the type level too, to prove the runtime check catches what TS would already flag
      execute: async () => ({ n: "oops" }),
    });

    await expect(block.execute({}, fakeExecutionContext())).rejects.toThrow(/output failed schema validation/);
  });
});
