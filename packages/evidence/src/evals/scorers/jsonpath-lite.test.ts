import { describe, expect, it } from "vitest";
import { JsonPathSyntaxError, jsonPathQuery, pathEndsInWildcard } from "./jsonpath-lite.js";

const fixture = {
  outputs: { nmi: "6401234567", tags: ["a", "b", "c"] },
  items: [{ name: "x" }, { name: "y" }],
};

describe("jsonPathQuery", () => {
  it("resolves the root alone", () => {
    expect(jsonPathQuery(fixture, "$")).toEqual([fixture]);
  });

  it("resolves a dot-property path", () => {
    expect(jsonPathQuery(fixture, "$.outputs.nmi")).toEqual(["6401234567"]);
  });

  it("resolves a bracket-property path with single or double quotes", () => {
    expect(jsonPathQuery(fixture, "$['outputs']['nmi']")).toEqual(["6401234567"]);
    expect(jsonPathQuery(fixture, '$["outputs"]["nmi"]')).toEqual(["6401234567"]);
  });

  it("resolves an array index, including negative indices", () => {
    expect(jsonPathQuery(fixture, "$.items[0].name")).toEqual(["x"]);
    expect(jsonPathQuery(fixture, "$.items[-1].name")).toEqual(["y"]);
  });

  it("resolves a wildcard over an array", () => {
    expect(jsonPathQuery(fixture, "$.outputs.tags[*]")).toEqual(["a", "b", "c"]);
  });

  it("resolves a wildcard over an object's values", () => {
    expect(jsonPathQuery(fixture, "$.outputs.*")).toEqual(expect.arrayContaining(["6401234567", ["a", "b", "c"]]));
  });

  it("returns no matches (not a throw) for a missing property", () => {
    expect(jsonPathQuery(fixture, "$.outputs.doesNotExist")).toEqual([]);
  });

  it("returns no matches for an out-of-range index", () => {
    expect(jsonPathQuery(fixture, "$.items[99].name")).toEqual([]);
  });

  it("throws JsonPathSyntaxError when the path doesn't start with $", () => {
    expect(() => jsonPathQuery(fixture, "outputs.nmi")).toThrow(JsonPathSyntaxError);
  });

  it("throws JsonPathSyntaxError for an unsupported filter expression (deliberately scoped subset)", () => {
    expect(() => jsonPathQuery(fixture, "$.items[?(@.name=='x')]")).toThrow(JsonPathSyntaxError);
  });

  it("throws JsonPathSyntaxError for an unterminated bracket", () => {
    expect(() => jsonPathQuery(fixture, "$.items[0")).toThrow(JsonPathSyntaxError);
  });
});

describe("pathEndsInWildcard", () => {
  it("is true for the bracket wildcard form ([*]) — regression test: a naive path.endsWith(\"*\") string check misses this, since the literal last character is \"]\" not \"*\"", () => {
    expect(pathEndsInWildcard("$.outputs.tags[*]")).toBe(true);
  });

  it("is true for the dot wildcard form (.*)", () => {
    expect(pathEndsInWildcard("$.outputs.*")).toBe(true);
  });

  it("is false for a path with no trailing wildcard, even if the path contains array indices", () => {
    expect(pathEndsInWildcard("$.outputs.tags[0]")).toBe(false);
    expect(pathEndsInWildcard("$.outputs.nmi")).toBe(false);
  });

  it("is false for the bare root", () => {
    expect(pathEndsInWildcard("$")).toBe(false);
  });
});
