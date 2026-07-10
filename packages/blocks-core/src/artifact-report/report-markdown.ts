// report.markdown — spec §15.3 Artifact/report group. Renders a RunRecord
// as a Markdown report. Unlike eval.score (which has NO local fallback —
// see eval/scorer-registry-port.ts for why), this block DOES fall back to
// a real, working local renderer (report-renderers-port.ts's
// `createFallbackReportRenderers`) when no `ReportRenderersPort` was
// injected and `@aart/evidence`'s real `createReportRenderers` isn't yet
// resolvable — rendering a run as markdown is mechanical formatting, not
// correctness-sensitive scoring logic, so this block stays useful and
// testable standalone.
//
// A FACTORY like eval.score, for the same reason: `createReportMarkdownBlock
// (reportRenderers?)` accepts an explicit override; the default catalog
// member (`reportMarkdownBlock`, no argument) resolves lazily at call time
// (injected -> real @aart/evidence -> local fallback, in that order).
//
// `run`'s input schema is the REAL frozen `RunRecordSchema` (@aart/types),
// not `z.unknown()` — this block's whole job is rendering that exact
// shape, so validating it strictly at the boundary catches a malformed
// caller (e.g. a hand-built fixture missing a required RunRecord field)
// with a clear Zod error rather than a confusing failure deep inside a
// renderer.
import { z } from "zod";
import { RunRecordSchema } from "@aart/types";
import { defineBlock } from "../lib/define-block.js";
import { createFallbackReportRenderers, tryLoadEvidenceReportRenderers, type ReportRenderersPort } from "./report-renderers-port.js";

const inputSchema = z.object({
  run: RunRecordSchema,
});
const outputSchema = z.object({
  markdown: z.string(),
});

export function createReportMarkdownBlock(reportRenderers?: ReportRenderersPort) {
  return defineBlock({
    id: "report.markdown",
    capabilities: [],
    category: "report",
    description: 'Renders a RunRecord as a Markdown report. Example: run: "{{ steps.eval_suite.outputs.run }}".',
    inputSchema,
    outputSchema,
    execute: async (input) => {
      const renderers = reportRenderers ?? (await tryLoadEvidenceReportRenderers()) ?? createFallbackReportRenderers();
      return { markdown: renderers.markdown(input.run) };
    },
  });
}

export const reportMarkdownBlock = createReportMarkdownBlock();
