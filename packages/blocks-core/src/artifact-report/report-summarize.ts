// report.summarize — spec §15.3 Artifact/report group. Renders a RunRecord
// as the compact, model-facing ModelFacingReport (spec §32.7,
// packages/types/src/report.ts) — the model-consuming counterpart to
// report.markdown's human-facing rendering. Same FACTORY / DI-with-
// real-fallback pattern as report-markdown.ts (see that file's module doc
// comment for the full injected -> real @aart/evidence -> local fallback
// resolution order, and for why report.* blocks fall back rather than
// throw, unlike eval.score/eval.run).
import { z } from "zod";
import { RunRecordSchema, ModelFacingReportSchema } from "@aart/types";
import { defineBlock } from "../lib/define-block.js";
import { createFallbackReportRenderers, tryLoadEvidenceReportRenderers, type ReportRenderersPort } from "./report-renderers-port.js";

const inputSchema = z.object({
  run: RunRecordSchema,
});
const outputSchema = z.object({
  report: ModelFacingReportSchema,
});

export function createReportSummarizeBlock(reportRenderers?: ReportRenderersPort) {
  return defineBlock({
    id: "report.summarize",
    capabilities: [],
    category: "report",
    description:
      'Renders a RunRecord as a compact, model-facing report (headline, workflow outputs, failures, artifact refs, next action). Example: run: "{{ steps.eval_suite.outputs.run }}".',
    inputSchema,
    outputSchema,
    execute: async (input) => {
      const renderers = reportRenderers ?? (await tryLoadEvidenceReportRenderers()) ?? createFallbackReportRenderers();
      return { report: renderers.modelFacing(input.run) };
    },
  });
}

export const reportSummarizeBlock = createReportSummarizeBlock();
