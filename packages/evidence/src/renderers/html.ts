// html.ts — spec §19.3 HTML report format; "dashboard view" (spec §19.3's
// 7th format) is served by this renderer's output, consumed by
// @aart/dashboard (architecture §9.1's reconciliation note), not a
// separately-implemented format.
import type { RunRecord } from "@aart/types";
import { applyRedaction, type RedactFn } from "../redact.js";
import { buildReportModel, type ReportModel } from "../report-model.js";

/** Minimal, dependency-free HTML escaping — every piece of run-derived text (step ids, error messages, trigger source, ...) flows through this before being embedded, since none of it is trusted-safe HTML. */
function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderStepsSummary(model: ReportModel): string {
  if (model.stepsSummary.length === 0) return "<p><em>No steps recorded.</em></p>";
  const rows = model.stepsSummary
    .map(
      (s) =>
        `<tr><td><code>${escapeHtml(s.stepId)}</code></td><td>${escapeHtml(s.block)}</td><td>${escapeHtml(s.status)}</td><td>${
          s.durationMs !== undefined ? `${s.durationMs}ms` : ""
        }</td></tr>`,
    )
    .join("");
  return `<table><thead><tr><th>Step</th><th>Block</th><th>Status</th><th>Duration</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/** Renders `run` as a self-contained HTML fragment. Section order matches spec §19.4's 9-element report UX (ReportModel's field order) — errors/failures render before the full-trace section. */
export function renderHtml(run: RunRecord, redact: RedactFn, resolvedSecretRefs: ReadonlySet<string> = new Set()): string {
  const clean = applyRedaction(run, redact, resolvedSecretRefs);
  const model = buildReportModel(clean);

  const sections: string[] = [];

  // 1. headline result
  sections.push(`<h1>${escapeHtml(model.headline.label)}: ${escapeHtml(model.workflowId)}@${escapeHtml(model.workflowVersion)}</h1>`);
  sections.push(`<p>Run <code>${escapeHtml(model.runId)}</code></p>`);

  // 2. approval/trust status
  sections.push(
    `<p><strong>Approval:</strong> ${model.approval.approved ? "approved" : "not approved"} (mode: <code>${escapeHtml(
      model.approval.mode,
    )}</code>)</p>`,
  );

  // 3. trigger/source
  sections.push(
    `<p><strong>Trigger:</strong> <code>${escapeHtml(model.trigger.type)}</code> (source: ${escapeHtml(model.trigger.source)}, received: ${escapeHtml(
      model.trigger.receivedAt,
    )})</p>`,
  );

  // 4. steps summary
  sections.push("<h2>Steps</h2>");
  sections.push(renderStepsSummary(model));

  // 5. errors/failures
  if (model.failures.length > 0) {
    sections.push("<h2>Failures</h2><ul>");
    for (const f of model.failures) {
      sections.push(`<li><code>${escapeHtml(f.stepId)}</code> (${escapeHtml(f.block)}): ${escapeHtml(f.error)}</li>`);
    }
    sections.push("</ul>");
  }

  // 6. artifacts
  if (model.artifacts.length > 0) {
    sections.push("<h2>Artifacts</h2><ul>");
    for (const a of model.artifacts) {
      sections.push(`<li>${escapeHtml(a.name)} (${escapeHtml(a.kind)}, ${escapeHtml(a.mime)}) — <code>${escapeHtml(a.path)}</code></li>`);
    }
    sections.push("</ul>");
  }

  // 7. screenshots
  if (model.screenshots.length > 0) {
    sections.push("<h2>Screenshots</h2>");
    for (const s of model.screenshots) {
      sections.push(`<figure><img src="${escapeHtml(s.path)}" alt="${escapeHtml(s.name)}"/><figcaption>${escapeHtml(s.name)}</figcaption></figure>`);
    }
  }

  // 8. eval/correction links
  sections.push("<h2>Eval / correction links</h2>");
  sections.push(`<p>Run id: <code>${escapeHtml(model.links.runId)}</code> — query @aart/store's evals/corrections members with this id.</p>`);

  // 9. full trace expandable
  sections.push("<h2>Full trace</h2>");
  sections.push(`<details><summary>Expand full trace</summary><pre>${escapeHtml(JSON.stringify(model.fullTrace, null, 2))}</pre></details>`);

  return `<article class="aart-report">${sections.join("\n")}</article>`;
}
