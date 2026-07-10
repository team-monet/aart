// wait.for_queue — spec §15.3 Wait group. See wait/for-signal.ts's module
// doc comment for the group's shared design rationale. This member waits
// for a correlated message to arrive on a named queue.
import { z } from "zod";
import { WaitConditionQueueSchema } from "@aart/types";
import { defineBlock } from "../lib/define-block.js";

const inputSchema = z.object({
  queue: z.string().describe('The queue name to wait on, e.g. "orders.fulfillment".'),
  correlationId: z.string().describe("Must match the correlationId the resolving queue message is delivered with."),
  timeout: z.string().optional().describe("An ISO-8601 duration; the wait fails with a timeout error if no matching message arrives in time."),
});
const outputSchema = WaitConditionQueueSchema.omit({ schemaVersion: true });

export const waitForQueueBlock = defineBlock({
  id: "wait.for_queue",
  capabilities: [],
  category: "wait",
  description:
    'Pauses the workflow until a correlated message arrives on a named queue. Example: queue: "orders.fulfillment", correlationId: "{{ inputs.orderId }}". The engine persists this as a WaitCondition and resumes the run when a matching message is delivered.',
  inputSchema,
  outputSchema,
  execute: async (input) => {
    return { type: "queue" as const, queue: input.queue, correlationId: input.correlationId, timeout: input.timeout };
  },
});
