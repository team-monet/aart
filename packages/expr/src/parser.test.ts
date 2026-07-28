import { describe, expect, it } from "vitest";
import {
  EXPR_ROOTS,
  assertExpressionDelimiters,
  ExprSyntaxError,
  findExpressionTokens,
  findUnmatchedExpressionDelimiters,
  parseExpression,
} from "./parser.js";

describe("parseExpression — roots (architecture §3.1 Root production)", () => {
  it.each(EXPR_ROOTS)("parses the bare root %s", (root) => {
    const parsed = parseExpression(`{{ ${root} }}`);
    expect(parsed.root).toBe(root);
    expect(parsed.path).toEqual([]);
  });

  it("rejects a root outside the 5-member set", () => {
    expect(() => parseExpression("{{ workflow.id }}")).toThrow(ExprSyntaxError);
  });
});

describe("parseExpression — PropertyPath production", () => {
  it("parses a dotted path (steps.<id>.outputs.<field>, spec's own example)", () => {
    const parsed = parseExpression("{{ steps.read.outputs.text }}");
    expect(parsed.root).toBe("steps");
    expect(parsed.path).toEqual([
      { kind: "property", name: "read" },
      { kind: "property", name: "outputs" },
      { kind: "property", name: "text" },
    ]);
  });

  it("parses a bracket index path", () => {
    const parsed = parseExpression("{{ steps.list.outputs.items[2] }}");
    expect(parsed.path).toEqual([
      { kind: "property", name: "list" },
      { kind: "property", name: "outputs" },
      { kind: "property", name: "items" },
      { kind: "index", index: 2 },
    ]);
  });

  it("parses a combined dot-and-bracket path", () => {
    const parsed = parseExpression("{{ steps.list.outputs.items[0].name }}");
    expect(parsed.path).toEqual([
      { kind: "property", name: "list" },
      { kind: "property", name: "outputs" },
      { kind: "property", name: "items" },
      { kind: "index", index: 0 },
      { kind: "property", name: "name" },
    ]);
  });

  it("tolerates {{ }} with no interior whitespace", () => {
    expect(parseExpression("{{inputs.url}}")).toEqual({ root: "inputs", path: [{ kind: "property", name: "url" }], raw: "{{inputs.url}}" });
  });

  it("tolerates surrounding whitespace outside {{ }}", () => {
    expect(parseExpression("   {{ inputs.url }}   ").root).toBe("inputs");
  });
});

describe("parseExpression — malformed wrapper rejection", () => {
  it.each([
    ["missing closing braces", "{{ inputs.url "],
    ["missing opening braces", " inputs.url }}"],
    ["no braces at all", "inputs.url"],
    ["empty expression", "{{ }}"],
    ["single braces", "{ inputs.url }"],
  ])("rejects: %s", (_label, source) => {
    expect(() => parseExpression(source)).toThrow(ExprSyntaxError);
  });

  it("rejects an identifier starting with a digit", () => {
    expect(() => parseExpression("{{ inputs.2url }}")).toThrow(ExprSyntaxError);
  });

  it("rejects a non-numeric bracket index", () => {
    expect(() => parseExpression('{{ steps.list.outputs.items["x"] }}')).toThrow(ExprSyntaxError);
  });

  it("rejects a missing closing bracket", () => {
    expect(() => parseExpression("{{ steps.list.outputs.items[0 }}")).toThrow(ExprSyntaxError);
  });

  it("rejects a trailing dot with nothing after it", () => {
    expect(() => parseExpression("{{ inputs. }}")).toThrow(ExprSyntaxError);
  });
});

describe("parseExpression — operator-token rejection (architecture §3.1, hard grammar boundary)", () => {
  it.each([
    ["addition", "{{ inputs.a + inputs.b }}"],
    ["subtraction", "{{ inputs.a - inputs.b }}"],
    ["multiplication", "{{ inputs.a * inputs.b }}"],
    ["division", "{{ inputs.a / inputs.b }}"],
    ["modulo", "{{ inputs.a % inputs.b }}"],
    ["strict equality", "{{ inputs.a === inputs.b }}"],
    ["loose equality", "{{ inputs.a == inputs.b }}"],
    ["inequality", "{{ inputs.a != inputs.b }}"],
    ["less-than", "{{ inputs.a < inputs.b }}"],
    ["less-than-or-equal", "{{ inputs.a <= inputs.b }}"],
    ["greater-than", "{{ inputs.a > inputs.b }}"],
    ["greater-than-or-equal", "{{ inputs.a >= inputs.b }}"],
    ["logical and", "{{ inputs.a && inputs.b }}"],
    ["logical or", "{{ inputs.a || inputs.b }}"],
    ["logical not", "{{ !inputs.a }}"],
    ["function call", "{{ inputs.a() }}"],
    ["ternary", "{{ inputs.a ? inputs.b : inputs.c }}"],
    ["assignment", "{{ inputs.a = inputs.b }}"],
  ])("rejects %s", (_label, source) => {
    expect(() => parseExpression(source)).toThrow(ExprSyntaxError);
  });

  it("names the offending operator in the error message, pointing at computing it in a step instead", () => {
    try {
      parseExpression("{{ inputs.a + inputs.b }}");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ExprSyntaxError);
      expect((err as Error).message).toContain("+");
      expect((err as Error).message).toContain("step");
    }
  });
});

describe("findExpressionTokens", () => {
  it("finds a single token", () => {
    expect(findExpressionTokens("{{ inputs.url }}").map((m) => m[0])).toEqual(["{{ inputs.url }}"]);
  });

  it("finds two adjacent tokens as two separate matches, not one greedy span (no backtracking-across-}}  bug)", () => {
    const matches = findExpressionTokens("{{ inputs.a }}{{ inputs.b }}");
    expect(matches.map((m) => m[0])).toEqual(["{{ inputs.a }}", "{{ inputs.b }}"]);
  });

  it("finds tokens separated by literal text", () => {
    const matches = findExpressionTokens("Found {{ steps.list.outputs.length }} items");
    expect(matches.map((m) => m[0])).toEqual(["{{ steps.list.outputs.length }}"]);
  });

  it("returns an empty array for a string with no expression", () => {
    expect(findExpressionTokens("just literal text")).toEqual([]);
  });
});

describe("expression delimiter validation", () => {
  it("reports unmatched opening and closing delimiters outside complete tokens", () => {
    expect(findUnmatchedExpressionDelimiters("{{ inputs.a }} then {{ inputs.b")).toEqual(["{{"]);
    expect(findUnmatchedExpressionDelimiters("prefix }} {{ inputs.a }}")).toEqual(["}}"]);
  });

  it("rejects incomplete expression-looking text", () => {
    expect(() => assertExpressionDelimiters("{{ inputs.a")).toThrow(ExprSyntaxError);
    expect(() => assertExpressionDelimiters("inputs.a }}")).toThrow(/unmatched expression delimiter/i);
  });

  it("accepts literals and any number of complete expression tokens", () => {
    expect(() => assertExpressionDelimiters("literal {{ inputs.a }} and {{ inputs.b }}")).not.toThrow();
  });
});
