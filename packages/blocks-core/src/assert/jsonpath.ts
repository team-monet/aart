// assert.jsonpath — spec §15.3 Assert group. Uses lib/jsonpath.ts's
// minimal JSONPath subset (not S6's eval scorer registry — this is a
// synchronous, dependency-free block-level check, distinct from
// eval.score's kind:"jsonpath_exact"/"jsonpath_contains" scorer kinds,
// which are S6-owned and used for batch eval suites, not single-step
// assertions).
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { defineBlock } from "../lib/define-block.js";
import { assertOrThrow } from "../lib/assertion.js";
import { queryJsonPath } from "../lib/jsonpath.js";

const inputSchema = z.object({
  data: z.unknown(),
  path: z.string().describe('A JSONPath expression, e.g. "$.store.items[0].id".'),
  expected: z.unknown().optional().describe("If given, at least one match must deep-equal this. If omitted, at least one match must simply exist."),
});
const outputSchema = z.object({
  passed: z.literal(true),
  matches: z.array(z.unknown()),
});

export const assertJsonpathBlock = defineBlock({
  id: "assert.jsonpath",
  capabilities: [],
  category: "assert",
  description: 'Fails the run unless a JSONPath query matches (optionally, matches a specific expected value). Example: data: "{{ steps.fetch.outputs.body }}", path: "$.status", expected: "ok".',
  inputSchema,
  outputSchema,
  execute: async (input) => {
    const matches = queryJsonPath(input.data, input.path);
    const condition = input.expected !== undefined ? matches.some((m) => isDeepStrictEqual(m, input.expected)) : matches.length > 0;
    assertOrThrow(
      "assert.jsonpath",
      condition,
      input.expected !== undefined
        ? `expected a match for ${JSON.stringify(input.expected)} at "${input.path}", got ${JSON.stringify(matches)}`
        : `expected at least one match at "${input.path}", got none`,
      { path: input.path, matches, expected: input.expected },
    );
    return { passed: true as const, matches };
  },
});
