// human.approval — spec §15.3 Human group. The ONE human-decision member of
// the frozen 7-member WaitCondition union (packages/types/src/wait.ts's
// WaitConditionApprovalSchema, type: "approval") — unlike human.review
// (human/review.ts), which is a synchronous non-blocking marker because no
// WaitCondition member exists for it, this block genuinely pauses the run.
//
// Its output EXTENDS WaitConditionApprovalSchema.omit({schemaVersion:true})
// (which is just {type:"approval", taskId, timeout?}) with `title` and
// `description` echoed straight through from the input. The engine's own
// WaitCondition persistence doesn't need those two fields to resume the
// run, but the governance layer constructing the actual ApprovalTask record
// spec §13.5 describes DOES need a human-readable title/description to show
// an approver — and this block, holding the step's own `with:` parameters,
// is the natural point that data originates from. Carrying them through the
// WaitCondition-shaped output (rather than, say, a second side artifact)
// keeps the engine's "construct the WaitCondition from the block's `with:`
// parameters" handoff (architecture §4.4 step 2) a single value, matching
// every other Wait-group block's shape. See human/correct.ts's module doc
// comment for the sibling block that reuses this same mechanism.
import { z } from "zod";
import { WaitConditionApprovalSchema } from "@aart/types";
import { defineBlock } from "../lib/define-block.js";

const inputSchema = z.object({
  title: z.string().describe('Short label for what needs approval, e.g. "Approve refund of $450".'),
  description: z.string().describe("Fuller context for the approver."),
  taskId: z.string().optional().describe("Defaults to `<runId>:<stepId>` when omitted."),
  timeout: z.string().optional().describe("An ISO-8601 duration; the wait fails with a timeout error if not approved in time."),
});
const outputSchema = WaitConditionApprovalSchema.omit({ schemaVersion: true }).extend({
  title: z.string(),
  description: z.string(),
});

export const humanApprovalBlock = defineBlock({
  id: "human.approval",
  capabilities: [],
  category: "human",
  description:
    'Pauses the workflow until a human approves or rejects. Example: title: "Approve refund of $450", description: "Customer requested a refund outside policy; approve to proceed.". The engine persists this as a WaitCondition{type:"approval"} and constructs the governance-facing ApprovalTask from the title/description carried through here.',
  inputSchema,
  outputSchema,
  execute: async (input, ctx) => {
    const taskId = input.taskId ?? `${ctx.runId}:${ctx.stepId}`;
    return { type: "approval" as const, taskId, timeout: input.timeout, title: input.title, description: input.description };
  },
});
