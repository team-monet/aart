// wait.until — spec §15.3 Wait group. See wait/for-signal.ts's module doc
// comment for the group's shared design rationale (a thin block that only
// constructs a WaitCondition and hands off to the engine — the real
// wait/resume machinery is @aart/engine's scope entirely). This member
// waits for a fixed point in time rather than an external event.
import { z } from "zod";
import { WaitConditionTimerSchema } from "@aart/types";
import { defineBlock } from "../lib/define-block.js";

const inputSchema = z.object({
  resumeAt: z.string().describe('An ISO-8601 timestamp to resume at, e.g. "2026-08-01T09:00:00Z".'),
});
const outputSchema = WaitConditionTimerSchema.omit({ schemaVersion: true });

export const waitUntilBlock = defineBlock({
  id: "wait.until",
  capabilities: [],
  category: "wait",
  description:
    'Pauses the workflow until a fixed point in time. Example: resumeAt: "2026-08-01T09:00:00Z". The engine persists this as a WaitCondition and resumes the run once that time passes.',
  inputSchema,
  outputSchema,
  execute: async (input) => {
    return { type: "timer" as const, resumeAt: input.resumeAt };
  },
});
