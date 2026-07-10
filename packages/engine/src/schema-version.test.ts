import { describe, expect, it } from "vitest";
import { assertSchemaVersionCompatible, CURRENT_ENGINE_SCHEMA_VERSION, isSchemaVersionCompatible, SchemaVersionMismatchError } from "./schema-version.js";

describe("isSchemaVersionCompatible", () => {
  it("is true when the record's version matches the engine's current version", () => {
    expect(isSchemaVersionCompatible(CURRENT_ENGINE_SCHEMA_VERSION)).toBe(true);
  });

  it("is false for any other version", () => {
    expect(isSchemaVersionCompatible(CURRENT_ENGINE_SCHEMA_VERSION + 1)).toBe(false);
    expect(isSchemaVersionCompatible(0)).toBe(false);
  });

  it("compares against an explicitly-supplied engine version, not just the current constant", () => {
    expect(isSchemaVersionCompatible(5, 5)).toBe(true);
    expect(isSchemaVersionCompatible(5, 6)).toBe(false);
  });
});

describe("assertSchemaVersionCompatible", () => {
  it("does not throw for a compatible version (a compatible-version resume proceeds normally)", () => {
    expect(() => assertSchemaVersionCompatible(CURRENT_ENGINE_SCHEMA_VERSION, { runId: "r1", recordKind: "RunRecord" })).not.toThrow();
  });

  it("throws SchemaVersionMismatchError for an incompatible RunRecord version — fails loudly rather than silently misinterpreting (architecture §4.7)", () => {
    expect(() => assertSchemaVersionCompatible(999, { runId: "r1", recordKind: "RunRecord" })).toThrow(SchemaVersionMismatchError);
  });

  it("throws SchemaVersionMismatchError for an incompatible WaitCondition version, including the stepId in the message", () => {
    try {
      assertSchemaVersionCompatible(999, { runId: "r1", stepId: "wait_step", recordKind: "WaitCondition" });
      expect.fail("expected assertSchemaVersionCompatible to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SchemaVersionMismatchError);
      expect((err as Error).message).toContain("wait_step");
      expect((err as Error).message).toContain("WaitCondition");
    }
  });

  it("carries a structured detail payload distinguishing recordKind/recordVersion/engineVersion", () => {
    try {
      assertSchemaVersionCompatible(42, { runId: "r1", recordKind: "RunRecord" });
      expect.fail("expected assertSchemaVersionCompatible to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SchemaVersionMismatchError);
      const detail = (err as SchemaVersionMismatchError).detail;
      expect(detail).toMatchObject({ kind: "schemaVersionMismatch", recordKind: "RunRecord", recordVersion: 42, engineVersion: CURRENT_ENGINE_SCHEMA_VERSION });
    }
  });

  it("SchemaVersionMismatchError reuses the frozen CorrelationError errorClass (no 11th AartError subclass minted)", () => {
    try {
      assertSchemaVersionCompatible(999, { runId: "r1", recordKind: "RunRecord" });
      expect.fail("expected assertSchemaVersionCompatible to throw");
    } catch (err) {
      expect((err as SchemaVersionMismatchError).errorClass).toBe("CorrelationError");
    }
  });
});
