// flow.branch — spec §15.3 Flow group. A literal-equality, first-match
// switch: AART's expression language deliberately excludes comparison
// operators (architecture §3.1), so this block is the one place a workflow
// author gets multi-way branching without needing one. Deep-equal via
// Node's `util.isDeepStrictEqual` — same choice assert.equals makes, for
// the same reason: correct for objects/arrays regardless of key order.
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { defineBlock } from "../lib/define-block.js";

const inputSchema = z.object({
  value: z.unknown().describe("The value to match against each case's `when`."),
  cases: z.array(z.object({ when: z.unknown(), to: z.string() })).describe("Evaluated in order; the first case whose `when` deep-equals `value` wins."),
  default: z.string().optional().describe("Returned when no case matches. Omitted means no match reports `to: null`."),
});
const outputSchema = z.object({
  to: z.string().nullable(),
  matched: z.boolean(),
});

export const flowBranchBlock = defineBlock({
  id: "flow.branch",
  capabilities: [],
  category: "flow",
  description:
    'Multi-way branch on literal equality. Example: value: "{{ steps.check.outputs.status }}", cases: [{ when: "ok", to: "continue" }, { when: "retry", to: "retry_step" }], default: "handle_error" -> returns `to` from the first matching case, or `default` if none match.',
  inputSchema,
  outputSchema,
  execute: async (input) => {
    for (const c of input.cases) {
      if (isDeepStrictEqual(input.value, c.when)) {
        return { to: c.to, matched: true };
      }
    }
    return { to: input.default ?? null, matched: false };
  },
});
