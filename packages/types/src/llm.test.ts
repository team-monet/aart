import { describe, expect, it } from "vitest";
import { LlmCallMetadataSchema, LlmCallStepSchema } from "./llm.js";

describe("LlmCallStepSchema", () => {
  it("round-trips a minimal LlmCallStep", () => {
    const input = { model: "anthropic/claude-sonnet-5", input: { text: "hi" } };
    expect(LlmCallStepSchema.parse(input)).toEqual(input);
  });

  it("round-trips a full LlmCallStep with inline eval", () => {
    const input = {
      model: "openai/gpt-5.5-thinking",
      promptRef: "prompts.energy_bill_extraction",
      input: { text: "..." },
      outputSchema: { type: "object" },
      temperature: 0,
      maxTokens: 2048,
      eval: { suite: "bill-extraction", scorer: "field_level_accuracy" },
    };
    expect(LlmCallStepSchema.parse(input)).toEqual(input);
  });
});

describe("LlmCallMetadataSchema", () => {
  it("round-trips LlmCallMetadata", () => {
    const input = {
      provider: "anthropic",
      model: "claude-sonnet-5",
      promptRef: "prompts.energy_bill_extraction",
      promptVersion: "3",
      tokensIn: 512,
      tokensOut: 128,
      latencyMs: 900,
    };
    expect(LlmCallMetadataSchema.parse(input)).toEqual(input);
  });
});
