// human.correct — spec §15.3 Human group.
//
// S9 integration fix (found while authoring the flagship example
// workflow's full flow — domain content since removed, A70; see root
// AMENDMENTS.md's dedicated entry on this):
// this block's ORIGINAL shape/doc comment claimed it was "wait-shaped,
// reusing the SAME WaitCondition{type:'approval'} mechanism human.approval
// uses... this block genuinely pauses the run" — that claim was FALSE in
// the real, merged system. The engine's wait-dispatch mechanism
// (@aart/engine's wait/wait-blocks.ts, WAIT_BLOCK_IDS) recognizes exactly
// 7 block ids as wait-triggering, an exhaustive, VERBATIM enumeration from
// architecture §4.4's own wait-lifecycle diagram ("Step dispatches to a
// wait-type block (wait.for_signal / wait.until / wait.for_webhook /
// wait.for_external_job / wait.for_queue / wait.manual / human.approval)")
// — "human.correct" is not, and was never, among them; @aart/engine
// faithfully implements the frozen architecture here, confirmed directly
// against the architecture document, not just against @aart/engine's own
// (also correct) test. This block's prior WaitCondition-mimicking output
// shape (`{type:"approval", taskId, timeout, ...}`) was therefore actively
// misleading: dispatched through the engine's NORMAL (non-wait) execution
// path, it ran to completion immediately and the workflow continued past
// it without ever pausing, despite the block's own manifest/doc comment
// promising a pause — an advertised-contract violation a workflow author
// relying on this block's own documentation would have no way to detect
// short of reading @aart/engine's source directly.
//
// Fixed by making this block's actual (synchronous) behavior match its
// actual (synchronous) capability, mirroring human.review's honest
// pattern exactly (human/review.ts) rather than perpetuating a
// wait-condition-shaped output nothing in the engine ever interprets as
// one: this block flags a value for human correction/confirmation without
// pausing the run — a structured marker (surfaced by a report/dashboard
// renderer later, spec §23.2's "Review UI" over a run's recorded trace),
// not a control-flow primitive. A workflow author who genuinely needs
// execution to PAUSE for a human decision must use human.approval (the
// one real Human-group wait primitive) — nothing else in the current
// architecture provides that.
import { z } from "zod";
import { defineBlock } from "../lib/define-block.js";

const inputSchema = z.object({
  title: z.string().describe('Short label for what needs correction, e.g. "Confirm extracted total".'),
  description: z.string().optional().describe("Fuller context for the human providing/approving the value."),
  currentValue: z.unknown().describe("The value being offered up for correction — typically a prior step's output."),
});
const outputSchema = z.object({
  correctionRequested: z.literal(true),
  title: z.string(),
  description: z.string().optional(),
  currentValue: z.unknown(),
});

export const humanCorrectBlock = defineBlock({
  id: "human.correct",
  capabilities: [],
  category: "human",
  description:
    'Flags a value for human correction/confirmation WITHOUT pausing the run (unlike human.approval, the only Human-group block that actually pauses execution — use that instead if the workflow must wait for a decision). Example: title: "Confirm extracted total", currentValue: "{{ steps.extract.outputs.total }}". Surfaced by report/dashboard renderers; does not block execution.',
  inputSchema,
  outputSchema,
  execute: async (input) => {
    return { correctionRequested: true as const, title: input.title, description: input.description, currentValue: input.currentValue };
  },
});
