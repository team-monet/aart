// wait.for_webhook — spec §15.3 Wait group. See wait/for-signal.ts's module
// doc comment for the group's shared design rationale. This member waits
// for an inbound webhook call correlated by id.
import { z } from "zod";
import { WaitConditionWebhookSchema } from "@aart/types";
import { defineBlock } from "../lib/define-block.js";

const inputSchema = z.object({
  event: z.string().describe('The webhook event name to wait for, e.g. "stripe.payment_intent.succeeded".'),
  correlationId: z.string().describe("Must match the correlationId the resolving webhook call is delivered with."),
  timeout: z.string().optional().describe("An ISO-8601 duration; the wait fails with a timeout error if no matching webhook arrives in time."),
});
const outputSchema = WaitConditionWebhookSchema.omit({ schemaVersion: true });

export const waitForWebhookBlock = defineBlock({
  id: "wait.for_webhook",
  capabilities: [],
  category: "wait",
  description:
    'Pauses the workflow until a named, correlated webhook call arrives. Example: event: "stripe.payment_intent.succeeded", correlationId: "{{ inputs.orderId }}". The engine persists this as a WaitCondition and resumes the run when a matching webhook is delivered.',
  inputSchema,
  outputSchema,
  execute: async (input) => {
    return { type: "webhook" as const, event: input.event, correlationId: input.correlationId, timeout: input.timeout };
  },
});
