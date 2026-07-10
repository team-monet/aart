// assert.contains — spec §15.3 Assert group boundary note: an ASSERTION
// (fails the run outright), not a sensor. Supports both a string
// substring check and an array membership (deep-equal) check.
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { defineBlock } from "../lib/define-block.js";
import { assertOrThrow } from "../lib/assertion.js";

const inputSchema = z.object({
  actual: z.union([z.string(), z.array(z.unknown())]),
  expected: z.unknown(),
});
const outputSchema = z.object({
  passed: z.literal(true),
});

export const assertContainsBlock = defineBlock({
  id: "assert.contains",
  capabilities: [],
  category: "assert",
  description: 'Fails the run unless actual contains expected — substring check for a string actual, deep-equal membership check for an array actual. Example: actual: "{{ steps.read.outputs.text }}", expected: "Success".',
  inputSchema,
  outputSchema,
  execute: async (input) => {
    const condition =
      typeof input.actual === "string" ? input.actual.includes(String(input.expected)) : input.actual.some((item) => isDeepStrictEqual(item, input.expected));
    assertOrThrow("assert.contains", condition, `expected ${JSON.stringify(input.actual)} to contain ${JSON.stringify(input.expected)}`, {
      actual: input.actual,
      expected: input.expected,
    });
    return { passed: true as const };
  },
});
