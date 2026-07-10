import { describe, expect, it } from "vitest";
import { toJsonSchema } from "./json-schema.js";
import { TriggerSchema, TRIGGER_TYPES } from "./trigger.js";
import { WaitConditionSchema, WAIT_CONDITION_TYPES } from "./wait.js";
import { ArtifactSchema } from "./artifact.js";

// This package's DoD requires JSON Schema derivation "wired and tested for
// at least the discriminated unions" — WaitCondition and Trigger are the
// two load-bearing ones (architecture §2.2).

describe("JSON Schema derivation — WaitCondition (discriminated union)", () => {
  const schema = toJsonSchema(WaitConditionSchema);

  it("emits a oneOf with exactly 7 members", () => {
    const oneOf = (schema as { oneOf?: unknown[] }).oneOf;
    expect(Array.isArray(oneOf)).toBe(true);
    expect(oneOf).toHaveLength(WAIT_CONDITION_TYPES.length);
  });

  it("gives every member a const literal on the `type` discriminant, covering all 7 spec §13.3 members", () => {
    const oneOf = (schema as { oneOf: Array<{ properties?: { type?: { const?: string } } }> }).oneOf;
    const discriminants = oneOf.map((member) => member.properties?.type?.const).sort();
    expect(discriminants).toEqual([...WAIT_CONDITION_TYPES].sort());
  });
});

describe("JSON Schema derivation — Trigger (discriminated union)", () => {
  const schema = toJsonSchema(TriggerSchema);

  it("emits a oneOf with exactly 13 members", () => {
    const oneOf = (schema as { oneOf?: unknown[] }).oneOf;
    expect(Array.isArray(oneOf)).toBe(true);
    expect(oneOf).toHaveLength(TRIGGER_TYPES.length);
  });

  it("gives every member a const literal on the `type` discriminant, covering all 13 spec §13.1 members", () => {
    const oneOf = (schema as { oneOf: Array<{ properties?: { type?: { const?: string } } }> }).oneOf;
    const discriminants = oneOf.map((member) => member.properties?.type?.const).sort();
    expect(discriminants).toEqual([...TRIGGER_TYPES].sort());
  });
});

describe("JSON Schema derivation — plain object schema smoke test", () => {
  it("derives a conventional object schema for a non-union type (Artifact)", () => {
    const schema = toJsonSchema(ArtifactSchema) as { type?: string; required?: string[]; properties?: Record<string, unknown> };
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(expect.arrayContaining(["id", "runId", "name", "kind", "mime", "path", "bytes", "createdAt"]));
    expect(schema.properties?.bytes).toEqual({ type: "number" });
  });

  it("does not throw on z.unknown()-bearing schemas (e.g. RunRecord.inputs/outputs)", () => {
    expect(() => toJsonSchema(ArtifactSchema)).not.toThrow();
  });
});
