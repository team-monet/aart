// wait.for_signal — spec §15.3 Wait group. A "block-level wrapper that
// constructs a WaitCondition and hands off to the engine, not the resume
// logic itself" (this session's own DoD wording) — the actual wait/resume
// machine (architecture §4.4, all 7 WaitCondition members, 3-mechanism
// consolidation) is S1/@aart/engine's scope entirely. This block's
// `execute` is deliberately small: given the step's `with:` parameters, it
// returns the WaitCondition shape the engine constructs the real
// persisted wait record from (architecture §4.4 step 2 — "Engine
// constructs the WaitCondition ... from the block's `with:` parameters").
//
// The output omits `schemaVersion` (present on every *persisted*
// WaitCondition, packages/types/src/wait.ts) deliberately — stamping a
// schema-version tag is a property of the ENGINE's persistence boundary
// (architecture §4.7: which @aart/engine release is doing the persisting),
// not something a block can know or should fabricate. Reused directly from
// the frozen `WaitConditionSignalSchema` via `.omit()` rather than a
// hand-rolled parallel shape, so this can never silently drift from the
// frozen type.
import { z } from "zod";
import { WaitConditionSignalSchema } from "@aart/types";
import { defineBlock } from "../lib/define-block.js";

const inputSchema = z.object({
  name: z.string().describe('The Signal name to wait for, e.g. "quote.received".'),
  correlationId: z.string().describe("Must match the correlationId the resolving Signal is delivered with."),
  timeout: z.string().optional().describe("An ISO-8601 duration; the wait fails with a timeout error if no matching signal arrives in time."),
});
const outputSchema = WaitConditionSignalSchema.omit({ schemaVersion: true });

export const waitForSignalBlock = defineBlock({
  id: "wait.for_signal",
  capabilities: [],
  category: "wait",
  description:
    'Pauses the workflow until a named, correlated Signal arrives. Example: name: "quote.received", correlationId: "{{ inputs.caseId }}". The engine persists this as a WaitCondition and resumes the run when a matching Signal is delivered.',
  inputSchema,
  outputSchema,
  execute: async (input) => {
    return { type: "signal" as const, name: input.name, correlationId: input.correlationId, timeout: input.timeout };
  },
});
