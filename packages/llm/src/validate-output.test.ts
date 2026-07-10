import { describe, expect, it } from "vitest";
import { LlmOutputSchemaValidationError } from "./errors.js";
import { validateAgainstSchema } from "./validate-output.js";

const ctx = { model: "anthropic/claude-sonnet-5", ref: "schemas.energy_bill" };

describe("validateAgainstSchema — architecture §12.3's 'schema-validated wrapper, never free-form'", () => {
  it("passes silently when output conforms to the schema", () => {
    const schema = { type: "object", properties: { amount: { type: "number" } }, required: ["amount"] };
    expect(() => validateAgainstSchema({ amount: 42 }, schema, ctx)).not.toThrow();
  });

  it("throws LlmOutputSchemaValidationError when a required field is missing", () => {
    const schema = { type: "object", properties: { amount: { type: "number" } }, required: ["amount"] };
    expect(() => validateAgainstSchema({}, schema, ctx)).toThrow(LlmOutputSchemaValidationError);
  });

  it("throws when a field has the wrong type", () => {
    const schema = { type: "object", properties: { amount: { type: "number" } }, required: ["amount"] };
    expect(() => validateAgainstSchema({ amount: "not a number" }, schema, ctx)).toThrow(LlmOutputSchemaValidationError);
  });

  it("validates an enum-classification shape (llm.classify's convention)", () => {
    const schema = { type: "object", properties: { label: { enum: ["positive", "negative", "neutral"] } }, required: ["label"] };
    expect(() => validateAgainstSchema({ label: "positive" }, schema, ctx)).not.toThrow();
    expect(() => validateAgainstSchema({ label: "not-a-valid-label" }, schema, ctx)).toThrow(LlmOutputSchemaValidationError);
  });

  it("error detail carries the ajv errors array and the ref/model for traceability", () => {
    const schema = { type: "object", properties: { amount: { type: "number" } }, required: ["amount"] };
    try {
      validateAgainstSchema({}, schema, ctx);
      throw new Error("expected validateAgainstSchema to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(LlmOutputSchemaValidationError);
      const validationError = error as LlmOutputSchemaValidationError;
      expect(validationError.detail?.ref).toBe("schemas.energy_bill");
      expect(validationError.detail?.model).toBe("anthropic/claude-sonnet-5");
      expect(Array.isArray(validationError.detail?.errors)).toBe(true);
    }
  });

  it("validates a nested object schema", () => {
    const schema = {
      type: "object",
      properties: { customer: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
      required: ["customer"],
    };
    expect(() => validateAgainstSchema({ customer: { name: "Acme" } }, schema, ctx)).not.toThrow();
    expect(() => validateAgainstSchema({ customer: {} }, schema, ctx)).toThrow(LlmOutputSchemaValidationError);
  });

  it("does not mutate the output value", () => {
    const schema = { type: "object", properties: { amount: { type: "number" } } };
    const output = { amount: 5 };
    const snapshot = JSON.stringify(output);
    validateAgainstSchema(output, schema, ctx);
    expect(JSON.stringify(output)).toBe(snapshot);
  });
});
