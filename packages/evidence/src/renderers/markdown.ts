// markdown.ts — spec §19.3 Markdown report format.
import type { RunRecord } from "@aart/types";
import { applyRedaction, type RedactFn } from "../redact.js";
import { buildReportModel } from "../report-model.js";

/** Renders `run` as a Markdown report. Section order follows spec §19.4's report UX plus A74's first-class workflow Outputs section (enforced by ReportModel's field order, report-model.ts) — errors/failures still render before the full-trace section. */
export function renderMarkdown(run: RunRecord, redact: RedactFn, resolvedSecretRefs: ReadonlySet<string> = new Set()): string {
  const clean = applyRedaction(run, redact, resolvedSecretRefs);
  const model = buildReportModel(clean);
  const lines: string[] = [];

  // 1. headline result
  lines.push(`# ${model.headline.label}: ${model.workflowId}@${model.workflowVersion}`);
  lines.push("");
  lines.push(`Run \`${model.runId}\``);
  lines.push("");
  // 2. approval/trust status
  lines.push(`**Approval:** ${model.approval.approved ? "approved" : "not approved"} (mode: \`${model.approval.mode}\`)`);
  // 3. trigger/source
  lines.push(
    `**Trigger:** \`${model.trigger.type}\` (source: ${model.trigger.source}, received: ${model.trigger.receivedAt}${
      model.trigger.correlationId ? `, correlation: ${model.trigger.correlationId}` : ""
    })`,
  );
  lines.push("");

  // 4. steps summary
  lines.push("## Steps");
  if (model.stepsSummary.length === 0) {
    lines.push("_No steps recorded._");
  } else {
    for (const s of model.stepsSummary) {
      lines.push(`- \`${s.stepId}\` (${s.block}): **${s.status}**${s.durationMs !== undefined ? ` — ${s.durationMs}ms` : ""}`);
    }
  }

  // Public workflow result — outputMapping, not an internal step guess.
  lines.push("");
  lines.push("## Outputs");
  lines.push("```json");
  lines.push(JSON.stringify(model.outputs, null, 2));
  lines.push("```");

  // 5. errors/failures
  if (model.failures.length > 0) {
    lines.push("");
    lines.push("## Failures");
    for (const f of model.failures) {
      lines.push(`- \`${f.stepId}\` (${f.block}): ${f.error}`);
    }
  }

  // 6. artifacts
  if (model.artifacts.length > 0) {
    lines.push("");
    lines.push("## Artifacts");
    for (const a of model.artifacts) {
      lines.push(`- ${a.name} (${a.kind}, ${a.mime}) — \`${a.path}\``);
    }
  }

  // 7. screenshots
  if (model.screenshots.length > 0) {
    lines.push("");
    lines.push("## Screenshots");
    for (const s of model.screenshots) {
      lines.push(`- ![${s.name}](${s.path})`);
    }
  }

  // 8. eval/correction links
  lines.push("");
  lines.push("## Eval / correction links");
  lines.push(`See \`aart correction list --run ${model.links.runId}\` and \`aart eval runs --run ${model.links.runId}\`.`);

  // 9. full trace expandable
  lines.push("");
  lines.push("## Full trace");
  lines.push("<details><summary>Expand full trace</summary>");
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(model.fullTrace, null, 2));
  lines.push("```");
  lines.push("</details>");

  return lines.join("\n");
}
