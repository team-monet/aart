// flow.noop — spec §15.3 Flow group. A placeholder/passthrough step —
// useful for workflow scaffolding (e.g. a stand-in step to wire up
// transitions before its real logic is authored) or a step that only
// exists to give a name to a point in the graph.
import { z } from "zod";
import { defineBlock } from "../lib/define-block.js";

const inputSchema = z.object({
  value: z.unknown().optional().describe("Passed through unchanged; useful as a workflow placeholder step."),
});
const outputSchema = z.object({
  value: z.unknown(),
});

export const flowNoopBlock = defineBlock({
  id: "flow.noop",
  capabilities: [],
  category: "flow",
  description:
    'A no-op placeholder step that passes its input through unchanged. Example: value: {"stage": "before-review"} -> { value: {"stage": "before-review"} }.',
  inputSchema,
  outputSchema,
  execute: async (input) => {
    return { value: input.value ?? null };
  },
});
