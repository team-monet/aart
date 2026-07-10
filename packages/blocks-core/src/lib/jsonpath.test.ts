import { describe, expect, it } from "vitest";
import { JsonPathSyntaxError, queryJsonPath } from "./jsonpath.js";

describe("queryJsonPath", () => {
  const data = {
    store: {
      name: "acme",
      items: [
        { id: 1, tags: ["a", "b"] },
        { id: 2, tags: ["c"] },
      ],
      "weird key": "value",
    },
  };

  it("resolves a simple dot-property path", () => {
    expect(queryJsonPath(data, "$.store.name")).toEqual(["acme"]);
  });

  it("resolves a bracket numeric index", () => {
    expect(queryJsonPath(data, "$.store.items[0].id")).toEqual([1]);
  });

  it("resolves a quoted bracket key (single or double quotes)", () => {
    expect(queryJsonPath(data, "$.store['weird key']")).toEqual(["value"]);
    expect(queryJsonPath(data, '$.store["weird key"]')).toEqual(["value"]);
  });

  it("resolves a wildcard over an array to every element", () => {
    expect(queryJsonPath(data, "$.store.items[*].id")).toEqual([1, 2]);
  });

  it("resolves a wildcard over an object to every value", () => {
    expect(queryJsonPath({ a: 1, b: 2, c: 3 }, "$.*")).toEqual(expect.arrayContaining([1, 2, 3]));
  });

  it("returns the root value for the bare $ path", () => {
    expect(queryJsonPath(data, "$")).toEqual([data]);
  });

  it("returns an empty array (not a throw) for a path with no match", () => {
    expect(queryJsonPath(data, "$.store.nonexistent")).toEqual([]);
    expect(queryJsonPath(data, "$.store.items[99].id")).toEqual([]);
  });

  it("chains a wildcard through a nested array field", () => {
    expect(queryJsonPath(data, "$.store.items[*].tags")).toEqual([["a", "b"], ["c"]]);
  });

  it("throws JsonPathSyntaxError for a path not starting with $", () => {
    expect(() => queryJsonPath(data, "store.name")).toThrow(JsonPathSyntaxError);
  });

  it("throws JsonPathSyntaxError for an unsupported filter expression", () => {
    expect(() => queryJsonPath(data, "$.store.items[?(@.id==1)]")).toThrow(JsonPathSyntaxError);
  });

  it("throws JsonPathSyntaxError for an unterminated bracket", () => {
    expect(() => queryJsonPath(data, "$.store[0")).toThrow(JsonPathSyntaxError);
  });
});
