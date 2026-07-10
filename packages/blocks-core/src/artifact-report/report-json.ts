// report.json — spec §15.3 Artifact/report group. Renders a RunRecord as
// its full JSON serialization — the machine-readable counterpart to
// report.markdown's human-facing rendering. Same FACTORY / DI-with-
// real-fallback pattern as report-markdown.ts (see that file's module doc
// comment for the full injected -> real @aart/evidence -> local fallback
// resolution order).
import { z } from "zod";
import { RunRecordSchema } from "@aart/types";
import { defineBlock } from "../lib/define-block.js";
import { createFallbackReportRenderers, tryLoadEvidenceReportRenderers, type ReportRenderersPort } from "./report-renderers-port.js";

const inputSchema = z.object({
  run: RunRecordSchema,
});
const outputSchema = z.object({
  json: z.string(),
});

export function createReportJsonBlock(reportRenderers?: ReportRenderersPort) {
  return defineBlock({
    id: "report.json",
    capabilities: [],
    category: "report",
    description: 'Renders a RunRecord as its full JSON serialization. Example: run: "{{ steps.eval_suite.outputs.run }}".',
    inputSchema,
    outputSchema,
    execute: async (input) => {
      const renderers = reportRenderers ?? (await tryLoadEvidenceReportRenderers()) ?? createFallbackReportRenderers();
      return { json: renderers.json(input.run) };
    },
  });
}

export const reportJsonBlock = createReportJsonBlock();
