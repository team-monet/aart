// human.review — spec §15.3 Human group. Deliberately NON-blocking, unlike
// human.approval (wait/../human-approval.ts, which pauses via
// WaitCondition{type:"approval"}): the WaitCondition union (packages/types
// /src/wait.ts) has exactly one human-decision member ("approval"), no
// separate "review" variant — so there is no engine wait mechanism this
// block could hand off to even if it wanted to. Spec §23.2 ("Review UI")
// describes review as a dashboard-surfaced concern over a run's already-
// recorded trace/artifacts, not an in-run pause. This block's job is
// therefore synchronous: it flags a point in the run (and the value at
// that point) as review-worthy, for a report renderer/dashboard to
// surface later — a structured marker, not a control-flow primitive. See
// this session's final report for the fuller reasoning (human.review and
// human.correct are both underspecified beyond their names in spec
// §15.3 — no per-block schema is given there for either).
import { z } from "zod";
import { defineBlock } from "../lib/define-block.js";

const inputSchema = z.object({
  title: z.string().describe('Short label for what needs review, e.g. "Extracted contract terms".'),
  description: z.string().optional(),
  data: z.unknown().describe("The value being flagged for review — typically a prior step's output."),
});
const outputSchema = z.object({
  reviewRequested: z.literal(true),
  title: z.string(),
  description: z.string().optional(),
  data: z.unknown(),
});

export const humanReviewBlock = defineBlock({
  id: "human.review",
  capabilities: [],
  category: "human",
  description:
    'Flags a value for human review without pausing the run (contrast human.approval, which does pause). Example: title: "Extracted contract terms", data: "{{ steps.extract.outputs.terms }}". Surfaced by report/dashboard renderers; does not block execution.',
  inputSchema,
  outputSchema,
  execute: async (input) => {
    return { reviewRequested: true as const, title: input.title, description: input.description, data: input.data };
  },
});
