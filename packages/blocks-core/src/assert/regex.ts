// assert.regex — spec §15.3 Assert group.
import { z } from "zod";
import { defineBlock } from "../lib/define-block.js";
import { assertOrThrow } from "../lib/assertion.js";

const inputSchema = z.object({
  value: z.string(),
  pattern: z.string(),
  flags: z.string().optional(),
});
const outputSchema = z.object({
  passed: z.literal(true),
  match: z.string().nullable(),
});

export const assertRegexBlock = defineBlock({
  id: "assert.regex",
  capabilities: [],
  category: "assert",
  description: 'Fails the run unless value matches pattern. Example: value: "{{ steps.read.outputs.text }}", pattern: "^Order #\\\\d+$".',
  inputSchema,
  outputSchema,
  execute: async (input) => {
    const re = new RegExp(input.pattern, input.flags);
    const result = re.exec(input.value);
    assertOrThrow("assert.regex", result !== null, `expected "${input.value}" to match /${input.pattern}/${input.flags ?? ""}`, {
      value: input.value,
      pattern: input.pattern,
    });
    return { passed: true as const, match: result?.[0] ?? null };
  },
});
