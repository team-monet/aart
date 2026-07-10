// assert.range — spec §15.3 Assert group. At least one of min/max must be
// given — a range assertion with neither is meaningless (always passes),
// so it's rejected at the input-schema level via .refine() rather than
// silently accepted as a no-op.
import { z } from "zod";
import { defineBlock } from "../lib/define-block.js";
import { assertOrThrow } from "../lib/assertion.js";

const inputSchema = z
  .object({
    value: z.number(),
    min: z.number().optional(),
    max: z.number().optional(),
  })
  .refine((v) => v.min !== undefined || v.max !== undefined, { message: "assert.range: at least one of min/max must be provided" });
const outputSchema = z.object({
  passed: z.literal(true),
});

export const assertRangeBlock = defineBlock({
  id: "assert.range",
  capabilities: [],
  category: "assert",
  description: 'Fails the run unless value is within [min, max] (either bound optional, but not both). Example: value: "{{ steps.compute.outputs.total }}", min: 0, max: 1000.',
  inputSchema,
  outputSchema,
  execute: async (input) => {
    const withinMin = input.min === undefined || input.value >= input.min;
    const withinMax = input.max === undefined || input.value <= input.max;
    assertOrThrow("assert.range", withinMin && withinMax, `expected ${input.value} to be within [${input.min ?? "-inf"}, ${input.max ?? "+inf"}]`, {
      value: input.value,
      min: input.min,
      max: input.max,
    });
    return { passed: true as const };
  },
});
