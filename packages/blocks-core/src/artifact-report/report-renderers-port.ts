// ReportRenderersPort — the exact shape S6's landed `@aart/evidence`
// exposes (root SEAMS.md, "E3 — Report renderers — consumed by
// @aart/dashboard (S8) and @aart/blocks-core's report.* blocks (S3)"):
//
//   packages/evidence/src/renderers/index.ts
//   export function createReportRenderers(redact: RedactFn): {
//     modelFacing(run, resolvedSecretRefs?): ModelFacingReport;
//     markdown(run, resolvedSecretRefs?): string;
//     html(run, resolvedSecretRefs?): string;
//     prComment(run, resolvedSecretRefs?, options?): string;
//     json(run, resolvedSecretRefs?): string;
//     cliText(run, resolvedSecretRefs?): string;
//   };
//
// Unlike eval/scorer-registry-port.ts (which deliberately does NOT
// reimplement scorer logic locally, since scoring correctness is real
// S6-owned business logic a local copy could drift from), this port DOES
// ship a real, working fallback (`createFallbackReportRenderers`, below):
// rendering a RunRecord as markdown/JSON/a model-facing summary is
// mechanical formatting, not a correctness-sensitive algorithm, so
// `report.*` blocks (report-summarize.ts, report-markdown.ts,
// report-json.ts) stay genuinely useful and testable standalone rather
// than hard-failing whenever no renderer has been injected. The fallback
// does NOT redact (`resolvedSecretRefs` is accepted for shape parity but
// unused) — a composition root that wants real redaction must inject the
// real `@aart/evidence` renderers (wired to S4's real `redactRecord`)
// via `createBlockCatalog({ reportRenderers })`.
import { compactModelFacingOutputs, type ModelFacingReport, type RunRecord, type RunStatus, type StepStatus } from "@aart/types";

export interface ReportRenderersPort {
  modelFacing(run: RunRecord, resolvedSecretRefs?: ReadonlySet<string>): ModelFacingReport;
  markdown(run: RunRecord, resolvedSecretRefs?: ReadonlySet<string>): string;
  html(run: RunRecord, resolvedSecretRefs?: ReadonlySet<string>): string;
  prComment(run: RunRecord, resolvedSecretRefs?: ReadonlySet<string>, options?: unknown): string;
  json(run: RunRecord, resolvedSecretRefs?: ReadonlySet<string>): string;
  cliText(run: RunRecord, resolvedSecretRefs?: ReadonlySet<string>): string;
}

/** `ModelFacingReport.headline` (report.ts) is the 3-value `"passed"|"failed"|"waiting"` enum — narrower than `RunRecord.status`'s 6-value `RunStatus`. `pending`/`running` map to `"waiting"` as the least-wrong fit (the run hasn't concluded either way); `cancelled` maps to `"failed"` (it didn't reach a successful terminal state) — both are this fallback's own documented judgment call, not a frozen-type mapping. */
function headlineFor(status: RunStatus): ModelFacingReport["headline"] {
  if (status === "completed") return "passed";
  if (status === "failed" || status === "cancelled") return "failed";
  return "waiting"; // pending | running | waiting
}

function isFailedStep(status: StepStatus): boolean {
  return status === "failed";
}

function workflowFailureBlock(error: string): string {
  return error.startsWith("Workflow output mapping failed:") || error.startsWith("Workflow output validation failed:")
    ? "workflow.outputMapping"
    : "workflow";
}

function failuresFor(run: RunRecord): ModelFacingReport["failures"] {
  const failures = run.trace
    .filter((step) => isFailedStep(step.status))
    .map((step) => ({ stepId: step.stepId, block: step.block, error: step.error ?? "unknown error" }));

  if (
    run.status === "failed" &&
    run.error &&
    (failures.length === 0 || workflowFailureBlock(run.error) === "workflow.outputMapping")
  ) {
    failures.push({ stepId: "$workflow", block: workflowFailureBlock(run.error), error: run.error });
  }
  return failures;
}

function buildModelFacing(run: RunRecord): ModelFacingReport {
  const failures = failuresFor(run);

  return {
    headline: headlineFor(run.status),
    workflowId: run.workflowId,
    workflowVersion: run.workflowVersion,
    failures,
    outputs: compactModelFacingOutputs(run.runId, run.outputs ?? {}),
    artifactRefs: run.artifacts.map((artifact) => ({ id: artifact.id, kind: artifact.kind, uri: artifact.path })),
    next: failures.length > 0 ? `Review ${failures.length} failed step(s): ${failures.map((f) => f.stepId).join(", ")}` : "No action needed.",
  };
}

function buildMarkdown(run: RunRecord): string {
  const lines: string[] = [
    `# Run ${run.runId}`,
    "",
    `**Workflow:** ${run.workflowId} @ ${run.workflowVersion}`,
    `**Status:** ${run.status}${run.flag ? ` (flagged: ${run.flag.kind})` : ""}`,
    `**Started:** ${run.startedAt}${run.endedAt ? `  **Ended:** ${run.endedAt}` : ""}`,
    "",
    "## Outputs",
    "```json",
    JSON.stringify(run.outputs ?? {}, null, 2),
    "```",
    "",
    "## Steps",
  ];
  for (const step of run.trace) {
    lines.push(`- [${step.status}] \`${step.stepId}\` (${step.block})${step.error ? ` — ${step.error}` : ""}`);
  }
  if (run.artifacts.length > 0) {
    lines.push("", "## Artifacts");
    for (const artifact of run.artifacts) {
      lines.push(`- ${artifact.name} (${artifact.kind}, ${artifact.mime}) — ${artifact.path}`);
    }
  }
  const failures = failuresFor(run);
  if (failures.length > 0) {
    lines.push("", "## Failures");
    for (const failure of failures) {
      lines.push(`- \`${failure.stepId}\` (${failure.block}) — ${failure.error}`);
    }
  }
  return lines.join("\n");
}

function buildCliText(run: RunRecord): string {
  const summary = buildModelFacing(run);
  const header = `[${summary.headline.toUpperCase()}] ${run.workflowId}@${run.workflowVersion} (${run.runId})`;
  const outputLine = `outputs: ${JSON.stringify(run.outputs ?? {})}`;
  if (summary.failures.length === 0) return `${header}\n${outputLine}\n${summary.next}`;
  const failureLines = summary.failures.map((f) => `  - ${f.stepId} (${f.block}): ${f.error}`);
  return [header, outputLine, ...failureLines].join("\n");
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function buildHtml(run: RunRecord): string {
  const summary = buildModelFacing(run);
  const stepRows = run.trace
    .map(
      (step) =>
        `<tr><td>${escapeHtml(step.stepId)}</td><td>${escapeHtml(step.block)}</td><td>${escapeHtml(step.status)}</td><td>${escapeHtml(step.error ?? "")}</td></tr>`,
    )
    .join("");
  const failures =
    summary.failures.length > 0
      ? `<h2>Failures</h2><ul>${summary.failures
          .map((failure) => `<li>${escapeHtml(`${failure.stepId} (${failure.block}): ${failure.error}`)}</li>`)
          .join("")}</ul>`
      : "";
  return (
    `<section data-run-id="${escapeHtml(run.runId)}"><h1>Run ${escapeHtml(run.runId)}</h1>` +
    `<p>Headline: ${escapeHtml(summary.headline)}</p>` +
    `<h2>Outputs</h2><pre>${escapeHtml(JSON.stringify(run.outputs ?? {}, null, 2))}</pre>` +
    `<table><thead><tr><th>Step</th><th>Block</th><th>Status</th><th>Error</th></tr></thead><tbody>${stepRows}</tbody></table>` +
    failures +
    `</section>`
  );
}

function buildPrComment(run: RunRecord): string {
  const summary = buildModelFacing(run);
  const badge = summary.headline === "passed" ? "✅" : summary.headline === "failed" ? "❌" : "⏳";
  const sections = [
    `${badge} **${run.workflowId}@${run.workflowVersion}** — ${summary.headline}`,
    `**Outputs**\n\n\`\`\`json\n${JSON.stringify(summary.outputs, null, 2)}\n\`\`\``,
  ];
  if (summary.failures.length > 0) {
    sections.push(`**Failures**\n\n${summary.failures.map((failure) => `- \`${failure.stepId}\` (${failure.block}): ${failure.error}`).join("\n")}`);
  }
  sections.push(summary.next);
  return sections.join("\n\n");
}

/** A real, working, non-redacting fallback — used by `report.*` blocks whenever no `ReportRenderersPort` was injected. See module doc comment above for why this differs from eval/scorer-registry-port.ts's deliberately-no-fallback stance. */
export function createFallbackReportRenderers(): ReportRenderersPort {
  return {
    modelFacing: (run) => buildModelFacing(run),
    markdown: (run) => buildMarkdown(run),
    html: (run) => buildHtml(run),
    prComment: (run) => buildPrComment(run),
    json: (run) => JSON.stringify(run, null, 2),
    cliText: (run) => buildCliText(run),
  };
}

/** Lazy resolution mirroring eval/scorer-registry-port.ts's `tryLoadEvidenceScorerRegistry`: dynamic-imports `@aart/evidence` and calls its `createReportRenderers` if present. Returns `undefined` (never throws) when it isn't — callers fall back to `createFallbackReportRenderers()` rather than erroring, per this module's fallback-first stance. */
export async function tryLoadEvidenceReportRenderers(): Promise<ReportRenderersPort | undefined> {
  try {
    const evidenceModule: unknown = await import("@aart/evidence");
    const candidate = (evidenceModule as Record<string, unknown>)["createReportRenderers"];
    if (typeof candidate !== "function") return undefined;
    // Real signature is `createReportRenderers(redact: RedactFn)` — an
    // identity redactor here (matching this architecture's own documented
    // engine-test default, architecture §4.6/§4.2) since blocks-core has
    // no access to S4's real `redactRecord` either.
    const identityRedact = (record: unknown) => record;
    return (candidate as (redact: unknown) => ReportRenderersPort)(identityRedact);
  } catch {
    return undefined;
  }
}
