// wait.manual — spec §15.3 Wait group. See wait/for-signal.ts's module doc
// comment for the group's shared design rationale. This member waits for
// an unconditional manual resume — no correlation id or external event to
// match, just an operator (or another system) explicitly resuming the run.
import { z } from "zod";
import { WaitConditionManualSchema } from "@aart/types";
import { defineBlock } from "../lib/define-block.js";

const inputSchema = z.object({
  timeout: z.string().optional().describe("An ISO-8601 duration; the wait fails with a timeout error if not manually resumed in time."),
});
const outputSchema = WaitConditionManualSchema.omit({ schemaVersion: true });

export const waitManualBlock = defineBlock({
  id: "wait.manual",
  capabilities: [],
  category: "wait",
  description:
    'Pauses the workflow until manually resumed, with no correlation id or external event to match. Example: timeout: "P3D". The engine persists this as a WaitCondition and resumes the run when an operator (or another system) explicitly resumes it.',
  inputSchema,
  outputSchema,
  execute: async (input) => {
    return { type: "manual" as const, timeout: input.timeout };
  },
});
