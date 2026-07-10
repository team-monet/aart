// human.correct — spec §15.3 Human group. Wait-shaped, reusing the SAME
// WaitCondition{type:"approval"} mechanism human.approval (human/approval.ts)
// uses — see that file's module doc comment for why an approval-flavored
// wait carries title/description through. There is no separate
// "correction" member in the frozen 7-member WaitCondition union
// (packages/types/src/wait.ts): the union was closed at S0 freeze time
// around a 3-mechanism consolidation (timer / signal-family / human-
// decision — architecture §4.4), not around one entry per spec-named human
// block. human.correct's distinct semantics — "pause until a human either
// supplies a corrected value or approves the current one as-is" — are
// still, mechanically, "pause until a human makes a decision on a task,"
// exactly what the approval mechanism already provides; it's the
// governance/dashboard layer resolving the ApprovalTask (spec §13.5) that
// actually offers the human a "keep" vs "replace" choice, not a different
// engine wait primitive. So this block extends the same
// omitted-schemaVersion approval shape with `currentValue` (the value
// being offered up for correction) alongside `title`/`description`, rather
// than inventing a new WaitCondition type this package has no authority to
// add to a frozen union.
import { z } from "zod";
import { WaitConditionApprovalSchema } from "@aart/types";
import { defineBlock } from "../lib/define-block.js";

const inputSchema = z.object({
  title: z.string().describe('Short label for what needs correction, e.g. "Confirm extracted total".'),
  description: z.string().optional().describe("Fuller context for the human providing/approving the value."),
  currentValue: z.unknown().describe("The value being offered up for correction — typically a prior step's output."),
  taskId: z.string().optional().describe("Defaults to `<runId>:<stepId>` when omitted."),
  timeout: z.string().optional().describe("An ISO-8601 duration; the wait fails with a timeout error if not resolved in time."),
});
const outputSchema = WaitConditionApprovalSchema.omit({ schemaVersion: true }).extend({
  title: z.string(),
  description: z.string().optional(),
  currentValue: z.unknown(),
});

export const humanCorrectBlock = defineBlock({
  id: "human.correct",
  capabilities: [],
  category: "human",
  description:
    'Pauses the workflow until a human supplies a corrected value or approves the current one as-is. Example: title: "Confirm extracted total", currentValue: "{{ steps.extract.outputs.total }}". The engine persists this as a WaitCondition{type:"approval"} carrying the current value for the approver to review.',
  inputSchema,
  outputSchema,
  execute: async (input, ctx) => {
    const taskId = input.taskId ?? `${ctx.runId}:${ctx.stepId}`;
    return {
      type: "approval" as const,
      taskId,
      timeout: input.timeout,
      title: input.title,
      description: input.description,
      currentValue: input.currentValue,
    };
  },
});
