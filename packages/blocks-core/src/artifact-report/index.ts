// The Artifact/report group's composition entrypoint — a FACTORY, not a
// plain BLOCKS array (contrast wait/index.ts, human/index.ts), because 3 of
// the 4 blocks here (report.summarize, report.markdown, report.json) need a
// ReportRenderersPort injected at construction time; only artifact.write is
// dependency-free. See report-markdown.ts's module doc comment for the
// injected -> real @aart/evidence -> local fallback resolution order each
// of those three follows independently when no `deps.reportRenderers` is
// passed here.
import type { BlockImplementation } from "@aart/types";
import { artifactWriteBlock } from "./artifact-write.js";
import { createReportSummarizeBlock } from "./report-summarize.js";
import { createReportMarkdownBlock } from "./report-markdown.js";
import { createReportJsonBlock } from "./report-json.js";
import type { ReportRenderersPort } from "./report-renderers-port.js";

export function createArtifactReportBlocks(deps: { reportRenderers?: ReportRenderersPort } = {}): BlockImplementation[] {
  return [
    artifactWriteBlock,
    createReportSummarizeBlock(deps.reportRenderers),
    createReportMarkdownBlock(deps.reportRenderers),
    createReportJsonBlock(deps.reportRenderers),
  ];
}
