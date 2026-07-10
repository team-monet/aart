// assert.equals — spec §15.3 Assert group. An ASSERTION, not a sensor
// (boundary note, browser/text-visible.ts's doc comment has the fuller
// contrast): it fails the run outright (throws BlockAssertionError,
// lib/assertion.ts) when the check doesn't hold, rather than returning a
// boolean for the workflow to branch on. Deep-equal via Node's own
// `util.isDeepStrictEqual` — correct for objects/arrays/dates regardless
// of key order, no reason to hand-roll a second implementation.
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { defineBlock } from "../lib/define-block.js";
import { assertOrThrow } from "../lib/assertion.js";

const inputSchema = z.object({
  actual: z.unknown(),
  expected: z.unknown(),
});
const outputSchema = z.object({
  passed: z.literal(true),
});

export const assertEqualsBlock = defineBlock({
  id: "assert.equals",
  capabilities: [],
  category: "assert",
  description: 'Fails the run unless actual deep-equals expected. Example: actual: "{{ steps.compute.outputs.total }}", expected: 42.',
  inputSchema,
  outputSchema,
  execute: async (input) => {
    assertOrThrow("assert.equals", isDeepStrictEqual(input.actual, input.expected), `expected ${JSON.stringify(input.expected)}, got ${JSON.stringify(input.actual)}`, {
      actual: input.actual,
      expected: input.expected,
    });
    return { passed: true as const };
  },
});
