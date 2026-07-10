// flow.fail — spec §15.3 Flow group. A workflow-AUTHORED intentional
// failure (a workflow author explicitly wants this step, and therefore the
// run, to fail) — distinct in kind from the engine/platform failures the
// 10 frozen AartError subclasses (packages/types/src/errors.ts) model. None
// of those fit this semantically, and that hierarchy is closed/S0-owned, so
// FlowFailError is a plain, locally-scoped Error subclass here — same
// reasoning as lib/assertion.ts's BlockAssertionError, kept local to this
// file (rather than promoted to a shared lib module) since flow.fail is its
// only caller.
import { z } from "zod";
import { defineBlock } from "../lib/define-block.js";

export class FlowFailError extends Error {
  constructor(
    message: string,
    public readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "FlowFailError";
  }
}

const inputSchema = z.object({
  message: z.string(),
  detail: z.record(z.string(), z.unknown()).optional(),
});
const outputSchema = z.object({});

export const flowFailBlock = defineBlock({
  id: "flow.fail",
  capabilities: [],
  category: "flow",
  description:
    'Always fails the step with the given message — a workflow-authored intentional failure. Example: message: "unsupported input shape" throws FlowFailError; this block never actually returns a value.',
  inputSchema,
  outputSchema,
  execute: async (input) => {
    throw new FlowFailError(input.message, input.detail);
  },
});
