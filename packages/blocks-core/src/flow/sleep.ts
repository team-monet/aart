// flow.sleep — spec §15.3 Flow group. Pure control flow: no capabilities,
// no I/O, no secrets — just a fixed-duration pause via setTimeout.
import { z } from "zod";
import { defineBlock } from "../lib/define-block.js";

const inputSchema = z.object({
  durationMs: z.number().describe("How long to sleep, in milliseconds."),
});
const outputSchema = z.object({
  sleptMs: z.number(),
});

export const flowSleepBlock = defineBlock({
  id: "flow.sleep",
  capabilities: [],
  category: "flow",
  description: "Pauses step execution for a fixed duration. Example: durationMs: 5000 waits 5 seconds before completing.",
  inputSchema,
  outputSchema,
  execute: async (input) => {
    await new Promise<void>((resolve) => setTimeout(resolve, input.durationMs));
    return { sleptMs: input.durationMs };
  },
});
