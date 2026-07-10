import { describe, expect, it } from "vitest";
import { parseExpression } from "./parser.js";
import {
  ExprResolutionError,
  resolveExpression,
  resolvePath,
  type ExprContext,
  type SecretResolver,
} from "./resolver.js";

const context: ExprContext = {
  inputs: { url: "http://localhost:3000", count: 3, active: true },
  steps: {
    list: { outputs: { length: 3, items: [{ name: "a" }, { name: "b" }, { name: "c" }] } },
    read: { outputs: { text: "Checkout" } },
  },
  trigger: { id: "trig_1", payload: { file_url: "https://x/bill.pdf", broker_id: "broker_123" } },
  run: { id: "run_1", workflowId: "checkout-smoke", version: "0.1.0" },
};

const fakeSecretResolver: SecretResolver = (name) => `secret-value-for-${name}`;

describe("resolvePath — all 5 roots resolve (architecture §3.2)", () => {
  it("resolves inputs.*", async () => {
    await expect(resolvePath(parseExpression("{{ inputs.url }}"), context)).resolves.toBe("http://localhost:3000");
  });

  it("resolves steps.<id>.outputs.<field>", async () => {
    await expect(resolvePath(parseExpression("{{ steps.read.outputs.text }}"), context)).resolves.toBe("Checkout");
  });

  it("resolves trigger.* including trigger.payload.*", async () => {
    await expect(resolvePath(parseExpression("{{ trigger.payload.file_url }}"), context)).resolves.toBe("https://x/bill.pdf");
    await expect(resolvePath(parseExpression("{{ trigger.id }}"), context)).resolves.toBe("trig_1");
  });

  it("resolves run.*", async () => {
    await expect(resolvePath(parseExpression("{{ run.id }}"), context)).resolves.toBe("run_1");
    await expect(resolvePath(parseExpression("{{ run.workflowId }}"), context)).resolves.toBe("checkout-smoke");
    await expect(resolvePath(parseExpression("{{ run.version }}"), context)).resolves.toBe("0.1.0");
  });

  it("resolves secrets.<NAME> via an injected resolver, never touching a real secret adapter", async () => {
    await expect(resolvePath(parseExpression("{{ secrets.GITHUB_TOKEN }}"), context, { secretResolver: fakeSecretResolver })).resolves.toBe(
      "secret-value-for-GITHUB_TOKEN",
    );
  });

  it("resolves an array index", async () => {
    await expect(resolvePath(parseExpression("{{ steps.list.outputs.items[1].name }}"), context)).resolves.toBe("b");
  });
});

describe("resolvePath — resolution-time failures (architecture §3.2: fails loudly, not silently undefined)", () => {
  it("throws when secrets.* has no resolver supplied", async () => {
    await expect(resolvePath(parseExpression("{{ secrets.GITHUB_TOKEN }}"), context)).rejects.toThrow(ExprResolutionError);
  });

  it("throws when a step referenced by steps.<id> hasn't completed (not present in context)", async () => {
    await expect(resolvePath(parseExpression("{{ steps.never_ran.outputs.text }}"), context)).rejects.toThrow(ExprResolutionError);
  });

  it("throws when a deeper property in the path is missing, rather than returning undefined", async () => {
    await expect(resolvePath(parseExpression("{{ steps.read.outputs.nonexistent }}"), context)).rejects.toThrow(ExprResolutionError);
  });

  it("throws when indexing past an array's bounds", async () => {
    await expect(resolvePath(parseExpression("{{ steps.list.outputs.items[99] }}"), context)).rejects.toThrow(ExprResolutionError);
  });

  it("throws when indexing into a non-array", async () => {
    await expect(resolvePath(parseExpression("{{ steps.read.outputs.text[0] }}"), context)).rejects.toThrow(ExprResolutionError);
  });

  it("throws when property-accessing into a non-object (a string leaf)", async () => {
    await expect(resolvePath(parseExpression("{{ steps.read.outputs.text.nested }}"), context)).rejects.toThrow(ExprResolutionError);
  });

  it("throws on a multi-segment secrets.* path (secrets.<NAME> must be a single property access)", async () => {
    await expect(
      resolvePath(parseExpression("{{ secrets.GITHUB.TOKEN }}"), context, { secretResolver: fakeSecretResolver }),
    ).rejects.toThrow(ExprResolutionError);
  });
});

describe("resolveExpression — exactly-one-expression-preserves-type rule (architecture §3.3), typed-passthrough position", () => {
  it("preserves string type", async () => {
    await expect(resolveExpression("{{ inputs.url }}", context)).resolves.toBe("http://localhost:3000");
  });
  it("preserves number type", async () => {
    const result = await resolveExpression("{{ inputs.count }}", context);
    expect(result).toBe(3);
    expect(typeof result).toBe("number");
  });
  it("preserves boolean type", async () => {
    const result = await resolveExpression("{{ inputs.active }}", context);
    expect(result).toBe(true);
    expect(typeof result).toBe("boolean");
  });
  it("preserves object type", async () => {
    const result = await resolveExpression("{{ steps.list.outputs.items[0] }}", context);
    expect(result).toEqual({ name: "a" });
    expect(typeof result).toBe("object");
  });
  it("preserves array type", async () => {
    const result = await resolveExpression("{{ steps.list.outputs.items }}", context);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual([{ name: "a" }, { name: "b" }, { name: "c" }]);
  });
  it("tolerates surrounding whitespace around the sole expression (still typed passthrough, not interpolation)", async () => {
    const result = await resolveExpression("  {{ inputs.count }}  ", context);
    expect(result).toBe(3);
  });
});

describe("resolveExpression — exactly-one-expression-preserves-type rule (architecture §3.3), string-interpolation position", () => {
  it("string-coerces string type (trivial — already a string)", async () => {
    await expect(resolveExpression("Value: {{ inputs.url }}", context)).resolves.toBe("Value: http://localhost:3000");
  });
  it("string-coerces number type (spec's own example: 'Found {{ }}' -> 'Found 3')", async () => {
    await expect(resolveExpression("Found {{ steps.list.outputs.length }}", context)).resolves.toBe("Found 3");
  });
  it("string-coerces boolean type", async () => {
    await expect(resolveExpression("Active: {{ inputs.active }}", context)).resolves.toBe("Active: true");
  });
  it("string-coerces object type (via JSON.stringify)", async () => {
    await expect(resolveExpression("Item: {{ steps.list.outputs.items[0] }}", context)).resolves.toBe('Item: {"name":"a"}');
  });
  it("string-coerces array type (via JSON.stringify)", async () => {
    await expect(resolveExpression("Items: {{ steps.list.outputs.items }}", context)).resolves.toBe(
      'Items: [{"name":"a"},{"name":"b"},{"name":"c"}]',
    );
  });
});

describe("resolveExpression — non-expression and structural passthrough", () => {
  it("passes a plain literal string through unchanged", async () => {
    await expect(resolveExpression("just literal text", context)).resolves.toBe("just literal text");
  });
  it("passes a non-string value through unchanged regardless of type (no {{ }} syntax possible)", async () => {
    await expect(resolveExpression(42, context)).resolves.toBe(42);
    await expect(resolveExpression(true, context)).resolves.toBe(true);
    const obj = { a: 1 };
    await expect(resolveExpression(obj, context)).resolves.toBe(obj);
    await expect(resolveExpression(null, context)).resolves.toBe(null);
  });
  it("interpolates two expressions with literal text between them", async () => {
    await expect(resolveExpression("{{ run.workflowId }} v{{ run.version }}", context)).resolves.toBe("checkout-smoke v0.1.0");
  });
  it("interpolates two adjacent expressions with nothing between them (not typed passthrough — more than one match)", async () => {
    await expect(resolveExpression("{{ run.workflowId }}{{ run.version }}", context)).resolves.toBe("checkout-smoke0.1.0");
  });
  it("null-coerces to empty string during interpolation", async () => {
    const ctxWithNull: ExprContext = { inputs: { maybe: null } };
    // Accessing a present-but-null leaf as the final segment resolves to null (not "missing"); interpolated, it renders as "".
    await expect(resolveExpression("value=[{{ inputs.maybe }}]", ctxWithNull)).resolves.toBe("value=[]");
  });
});

describe("resolveExpression — secret-resolver dependency-injection point (architecture §3.2)", () => {
  it("threads a fake secretResolver through end-to-end in typed-passthrough position", async () => {
    await expect(resolveExpression("{{ secrets.GITHUB_TOKEN }}", context, { secretResolver: fakeSecretResolver })).resolves.toBe(
      "secret-value-for-GITHUB_TOKEN",
    );
  });

  it("threads a fake secretResolver through end-to-end in string-interpolation position", async () => {
    await expect(resolveExpression("token={{ secrets.GITHUB_TOKEN }}", context, { secretResolver: fakeSecretResolver })).resolves.toBe(
      "token=secret-value-for-GITHUB_TOKEN",
    );
  });

  it("supports an async secretResolver (real adapters are network-backed)", async () => {
    const asyncResolver: SecretResolver = async (name) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return `async-${name}`;
    };
    await expect(resolveExpression("{{ secrets.API_KEY }}", context, { secretResolver: asyncResolver })).resolves.toBe("async-API_KEY");
  });

  it("rejects secrets.* with no resolver supplied even in string-interpolation position", async () => {
    await expect(resolveExpression("token={{ secrets.GITHUB_TOKEN }}", context)).rejects.toThrow(ExprResolutionError);
  });
});

describe("resolveExpression — operator-token rejection surfaces through the full entry point too", () => {
  it("propagates ExprSyntaxError for an operator inside an otherwise-typed-passthrough position", async () => {
    await expect(resolveExpression("{{ inputs.a + inputs.b }}", context)).rejects.toThrow();
  });

  it("propagates ExprSyntaxError for an operator inside string-interpolation position", async () => {
    await expect(resolveExpression("total={{ inputs.a + inputs.b }}", context)).rejects.toThrow();
  });
});
