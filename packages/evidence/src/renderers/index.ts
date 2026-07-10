// renderers/index.ts — architecture §9.1's trace/report pipeline: one
// RunRecord, six renderer files, reconciling spec §19.3's 8 named formats
// (chat summary, CLI text, Markdown, JSON, HTML, PR comment, dashboard
// view, artifact bundle) per architecture §9.1's mapping: "dashboard view"
// is served by the html renderer's output; "chat summary" is served by
// model-facing/cli-text depending on the calling surface; "artifact bundle"
// is not a RunRecord renderer at all (it's an artifact-store export
// concern, architecture §5.4, orthogonal to this pipeline).
import type { ModelFacingReport, RunRecord } from "@aart/types";
import type { RedactFn } from "../redact.js";
import { renderCliText } from "./cli-text.js";
import { renderHtml } from "./html.js";
import { renderJson } from "./json.js";
import { renderMarkdown } from "./markdown.js";
import { renderModelFacing } from "./model-facing.js";
import { renderPrComment, type PrCommentOptions } from "./pr-comment.js";

export * from "./cli-text.js";
export * from "./html.js";
export * from "./json.js";
export * from "./markdown.js";
export * from "./model-facing.js";
export * from "./pr-comment.js";

export interface ReportRenderers {
  modelFacing(run: RunRecord, resolvedSecretRefs?: ReadonlySet<string>): ModelFacingReport;
  markdown(run: RunRecord, resolvedSecretRefs?: ReadonlySet<string>): string;
  html(run: RunRecord, resolvedSecretRefs?: ReadonlySet<string>): string;
  prComment(run: RunRecord, resolvedSecretRefs?: ReadonlySet<string>, options?: PrCommentOptions): string;
  json(run: RunRecord, resolvedSecretRefs?: ReadonlySet<string>): string;
  cliText(run: RunRecord, resolvedSecretRefs?: ReadonlySet<string>): string;
}

/**
 * Composition-root convenience: binds every renderer to ONE injected
 * RedactFn (architecture §7.9's constructor-injection pattern), so call
 * sites (e.g. @aart/dashboard, @aart/blocks-core's report.* blocks) wire
 * `redact` in exactly once instead of threading it through every call.
 */
export function createReportRenderers(redact: RedactFn): ReportRenderers {
  return {
    modelFacing: (run, resolvedSecretRefs) => renderModelFacing(run, redact, resolvedSecretRefs),
    markdown: (run, resolvedSecretRefs) => renderMarkdown(run, redact, resolvedSecretRefs),
    html: (run, resolvedSecretRefs) => renderHtml(run, redact, resolvedSecretRefs),
    prComment: (run, resolvedSecretRefs, options) => renderPrComment(run, redact, resolvedSecretRefs, options),
    json: (run, resolvedSecretRefs) => renderJson(run, redact, resolvedSecretRefs),
    cliText: (run, resolvedSecretRefs) => renderCliText(run, redact, resolvedSecretRefs),
  };
}
