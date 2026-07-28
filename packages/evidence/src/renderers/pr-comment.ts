// pr-comment.ts — spec §26.3 PR comment report. This is the one renderer
// whose literal example includes a piece of data that architecturally lives
// on `Workflow` (the version-level 3-state `approval` — spec §17.1), not on
// `RunRecord` (which only carries a derived `approved: boolean` +
// `approvalMode`, spec §19.1) — see `workflowApprovalState` below: an
// OPTIONAL extra input, not a violation of architecture §9.1's
// RunRecord-only purity rule for the renderer's CORE behavior, which still
// works from RunRecord alone if the caller doesn't have that extra context.
import { compactModelFacingOutputs, type RunRecord } from "@aart/types";
import { applyRedaction, type RedactFn } from "../redact.js";
import { buildReportModel } from "../report-model.js";

export interface PrCommentEvalSummary {
  suiteName: string;
  passed: number;
  total: number;
}

export interface PrCommentOptions {
  /** The workflow VERSION's own 3-state approval (spec §17.1) — not on RunRecord itself; pass it when the caller (e.g. the PR-posting integration, which has the Workflow record too) has it. Falls back to RunRecord's own `approved` boolean when omitted. */
  workflowApprovalState?: "draft" | "approved" | "deprecated";
  evalSummary?: PrCommentEvalSummary;
  /** Semantic risk diff lines (architecture §7.6, S4's scope) — evidence doesn't compute these; a caller that has already run governance's risk diff passes the rendered lines through. */
  riskDiffLines?: string[];
}

function statusWord(status: RunRecord["status"]): string {
  switch (status) {
    case "completed":
      return "PASSED";
    case "failed":
      return "FAILED";
    default:
      return status.toUpperCase();
  }
}

/** Renders `run` in spec §26.3's PR comment format. */
export function renderPrComment(
  run: RunRecord,
  redact: RedactFn,
  resolvedSecretRefs: ReadonlySet<string> = new Set(),
  options: PrCommentOptions = {},
): string {
  const clean = applyRedaction(run, redact, resolvedSecretRefs);
  const model = buildReportModel(clean);
  const lines: string[] = ["AART Verification Report", ""];

  lines.push(`Workflow: ${model.workflowId}@${model.workflowVersion}`);
  lines.push(`Status: ${statusWord(clean.status)}`);
  lines.push(`Approval: ${options.workflowApprovalState ?? (clean.approved ? "approved" : "not approved")}`);
  if (options.evalSummary) {
    lines.push(`Eval suite: ${options.evalSummary.suiteName}`);
    lines.push(`Score: ${options.evalSummary.passed}/${options.evalSummary.total}`);
  }

  lines.push("");
  lines.push("Outputs:");
  lines.push("```json");
  lines.push(JSON.stringify(compactModelFacingOutputs(clean.runId, model.outputs), null, 2));
  lines.push("```");

  if (model.artifacts.length > 0) {
    lines.push("");
    lines.push("Artifacts:");
    for (const a of model.artifacts) lines.push(`- ${a.name}`);
  }

  if (model.failures.length > 0) {
    lines.push("");
    lines.push("Failures:");
    for (const f of model.failures) lines.push(`- \`${f.stepId}\` (${f.block}): ${f.error}`);
  }

  if (options.riskDiffLines && options.riskDiffLines.length > 0) {
    lines.push("");
    lines.push("Risk diff:");
    for (const l of options.riskDiffLines) lines.push(`- ${l}`);
  }

  return lines.join("\n");
}
