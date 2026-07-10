import { describe, expect, it } from "vitest";
import { dataParseBlock } from "./parse.js";
import { fakeExecutionContext } from "../test-support/fake-context.js";

describe("data.parse", () => {
  it("has complete, correctly-declared metadata", () => {
    expect(dataParseBlock.manifest.id).toBe("data.parse");
    expect(dataParseBlock.manifest.capabilities).toEqual([]);
    expect(dataParseBlock.manifest.category).toBe("data");
  });

  it("parses json", async () => {
    await expect(dataParseBlock.execute({ input: '{"a":1}', format: "json" }, fakeExecutionContext())).resolves.toEqual({ value: { a: 1 } });
  });

  it("parses yaml", async () => {
    await expect(dataParseBlock.execute({ input: "a: 1\nb: two\n", format: "yaml" }, fakeExecutionContext())).resolves.toEqual({
      value: { a: 1, b: "two" },
    });
  });

  it("parses csv", async () => {
    const result = await dataParseBlock.execute({ input: "a,b\n1,2\n3,4", format: "csv" }, fakeExecutionContext());
    expect(result).toEqual({ value: [{ a: "1", b: "2" }, { a: "3", b: "4" }] });
  });

  it("throws for malformed json", async () => {
    await expect(dataParseBlock.execute({ input: "{not json", format: "json" }, fakeExecutionContext())).rejects.toThrow();
  });
});
