import { describe, expect, it } from "vitest";
import { parse as parseYamlDoc } from "yaml";
import { dataStringifyBlock } from "./stringify.js";
import { parseCsv } from "../lib/csv.js";
import { fakeExecutionContext } from "../test-support/fake-context.js";

describe("data.stringify", () => {
  it("has complete, correctly-declared metadata", () => {
    expect(dataStringifyBlock.manifest.id).toBe("data.stringify");
    expect(dataStringifyBlock.manifest.capabilities).toEqual([]);
  });

  it("round-trips through json (compact and pretty)", async () => {
    const value = { a: 1, b: [1, 2, 3] };
    const compact = (await dataStringifyBlock.execute({ value, format: "json" }, fakeExecutionContext())) as { output: string };
    expect(JSON.parse(compact.output)).toEqual(value);
    expect(compact.output).not.toContain("\n");

    const pretty = (await dataStringifyBlock.execute({ value, format: "json", pretty: true }, fakeExecutionContext())) as { output: string };
    expect(pretty.output).toContain("\n");
    expect(JSON.parse(pretty.output)).toEqual(value);
  });

  it("round-trips through yaml", async () => {
    const value = { a: 1, b: "two" };
    const result = (await dataStringifyBlock.execute({ value, format: "yaml" }, fakeExecutionContext())) as { output: string };
    expect(parseYamlDoc(result.output)).toEqual(value);
  });

  it("round-trips through csv", async () => {
    const value = [{ a: "1", b: "2" }, { a: "3", b: "4" }];
    const result = (await dataStringifyBlock.execute({ value, format: "csv" }, fakeExecutionContext())) as { output: string };
    expect(parseCsv(result.output)).toEqual(value);
  });
});
