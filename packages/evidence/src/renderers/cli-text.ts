// cli-text.ts — spec §19.3 CLI text format. Also serves spec §19.3's "chat
// summary" format for CLI-invoked chat-style contexts (architecture §9.1's
// reconciliation note: "chat summary is served by the model-facing/cli-text
// renderers depending on the calling surface").
import type { RunRecord } from "@aart/types";
import { applyRedaction, type RedactFn } from "../redact.js";
import { buildReportModel } from "../report-model.js";

/** Renders `run` as a compact plain-text CLI summary. */
export function renderCliText(run: RunRecord, redact: RedactFn, resolvedSecretRefs: ReadonlySet<string> = new Set()): string {
  const clean = applyRedaction(run, redact, resolvedSecretRefs);
  const model = buildReportModel(clean);
  const lines: string[] = [];

  lines.push(`${model.headline.label.toUpperCase()} — ${model.workflowId}@${model.workflowVersion} (run ${model.runId})`);
  lines.push(
    `approval=${model.approval.approved ? "approved" : "not-approved"} mode=${model.approval.mode} trigger=${model.trigger.type}/${model.trigger.source}`,
  );
  lines.push(`steps: ${model.stepsSummary.length} total, ${model.failures.length} failed, ${model.artifacts.length} artifact(s)`);
  lines.push(`outputs: ${JSON.stringify(model.outputs)}`);

  if (model.failures.length > 0) {
    lines.push("failures:");
    for (const f of model.failures) {
      lines.push(`  - ${f.stepId} (${f.block}): ${f.error}`);
    }
  }

  return lines.join("\n");
}
