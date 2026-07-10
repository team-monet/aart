// Approval summary renderer (spec §17.3) — and the explicit, source-visible
// "covered fields" registry ADR-17's trust-surface-completeness test
// (trust-surface-completeness.ts) statically inspects. Architecture §7.8:
// "walk every field of Workflow/WorkflowStep via the Zod schema's shape
// introspection ... then statically inspect ... the approval-summary
// renderer's covered-field list, and fail the test on any gap." These two
// exported constants ARE that covered-field list — every field named here
// is rendered somewhere below for a workflow/step that populates it.
import type { Workflow, WorkflowStep } from "@aart/types";
import type { CapabilityClosureResult } from "./capability.js";

export const COVERED_WORKFLOW_FIELDS = [
  "id",
  "name",
  "version",
  "inputs",
  "outputs",
  "execution",
  "approval",
  "gates",
  "category",
  "keywords",
  "examples",
  "generatedByModel",
  "needsReview",
  "promotionBlocked",
] as const satisfies readonly (keyof Workflow)[];

export const COVERED_WORKFLOW_STEP_FIELDS = [
  "id",
  "uses",
  "with",
  "if",
  "then",
  "else",
  "next",
  "forEach",
  "as",
  "maxIterations",
  "until",
  "retry",
  "timeout",
  "idempotencyKey",
] as const satisfies readonly (keyof WorkflowStep)[];

export interface ApprovalSummaryInput {
  readonly workflow: Workflow;
  readonly capabilityClosure: CapabilityClosureResult;
  /** External domains this workflow calls (spec §31.3) — not always statically derivable from a capability string alone (many are resolved at runtime from a `{{ }}`-expression URL), so callers that know them supply them; falls back to any `domain:<pattern>` capabilities present in the closure. */
  readonly domains?: readonly string[];
  readonly writes?: readonly string[];
  readonly riskNotes?: readonly string[];
  /** Step ids flagged by validation class 4's idempotencyKey WARNING (architecture §4.2/§7.7) — surfaced in the summary, never blocking. */
  readonly effectfulWithoutIdempotencyKey?: readonly string[];
}

function describeStep(step: WorkflowStep): string {
  const parts: string[] = [`Run ${step.uses}`];
  if (step.with && Object.keys(step.with).length > 0) parts.push(`with ${JSON.stringify(step.with)}`);
  if (step.if) parts.push(`if ${step.if}`);
  if (step.then) parts.push(`then -> ${step.then}`);
  if (step.else) parts.push(`else -> ${step.else}`);
  if (step.next) parts.push(`next -> ${step.next}`);
  if (step.forEach) parts.push(`for each ${step.as ?? "item"} in ${step.forEach}`);
  if (step.maxIterations !== undefined) parts.push(`max ${step.maxIterations} iterations`);
  if (step.until) parts.push(`until ${step.until}`);
  if (step.retry) parts.push(`retry up to ${step.retry.maxAttempts}x (${step.retry.backoff})`);
  if (step.timeout) parts.push(`timeout ${step.timeout}`);
  if (step.idempotencyKey) parts.push(`idempotencyKey ${step.idempotencyKey}`);
  return `- [${step.id}] ${parts.join(", ")}`;
}

function describeField(name: string, type: string, opts: { required?: boolean; default?: unknown; enum?: unknown[]; pattern?: string }): string {
  let line = `- ${name}: ${type}`;
  if (opts.required) line += " (required)";
  if (opts.default !== undefined) line += ` = ${JSON.stringify(opts.default)}`;
  if (opts.enum) line += ` in ${JSON.stringify(opts.enum)}`;
  if (opts.pattern) line += ` matching ${opts.pattern}`;
  return line;
}

/**
 * Renders spec §17.3's human-readable approval summary. Covers every field
 * named in COVERED_WORKFLOW_FIELDS/COVERED_WORKFLOW_STEP_FIELDS above —
 * verified by trust-surface-completeness.ts's CI-enforced gate (ADR-17).
 */
export function renderApprovalSummary(input: ApprovalSummaryInput): string {
  const { workflow, capabilityClosure } = input;
  const lines: string[] = [];

  lines.push(`Workflow: ${workflow.id}@${workflow.version}`, `(${workflow.name})`, "");

  if (workflow.needsReview || workflow.promotionBlocked) {
    if (workflow.needsReview) lines.push("[WARNING] Needs review");
    if (workflow.promotionBlocked) lines.push("[WARNING] Promotion blocked");
    lines.push("");
  }

  lines.push("This workflow will:");
  for (const step of workflow.execution.steps) lines.push(describeStep(step));
  lines.push("");

  lines.push("Inputs:");
  if (workflow.inputs.length === 0) lines.push("- none");
  for (const f of workflow.inputs) lines.push(describeField(f.name, f.type, f));
  lines.push("");

  lines.push("Outputs:");
  if (workflow.outputs.length === 0) lines.push("- none");
  for (const f of workflow.outputs) lines.push(describeField(f.name, f.type, f));
  lines.push("");

  // Section order matches spec §17.3's own worked examples exactly:
  // Capabilities / External systems / Secrets / Writes / Risk[ notes].
  const plainCapabilities = capabilityClosure.capabilities.filter((c) => !c.startsWith("secrets:") && !c.startsWith("domain:"));
  lines.push("Capabilities:");
  if (plainCapabilities.length === 0) lines.push("- none");
  for (const c of plainCapabilities) lines.push(`- ${c}`);
  lines.push("");

  const domains =
    input.domains ?? capabilityClosure.capabilities.filter((c) => c.startsWith("domain:")).map((c) => c.slice("domain:".length));
  lines.push("External systems:");
  if (domains.length === 0) lines.push("- none declared");
  for (const d of domains) lines.push(`- ${d}`);
  lines.push("");

  const secrets = capabilityClosure.capabilities.filter((c) => c.startsWith("secrets:")).map((c) => c.slice("secrets:".length));
  lines.push("Secrets:");
  if (secrets.length === 0) lines.push("- none");
  for (const s of secrets) lines.push(`- ${s}`);
  lines.push("");

  const writes = input.writes ?? [];
  lines.push("Writes:");
  if (writes.length === 0) lines.push("- none");
  for (const w of writes) lines.push(`- ${w}`);
  lines.push("");

  lines.push(`Risk: ${capabilityClosure.riskTier}`);
  const riskNotes = input.riskNotes ?? [];
  if (riskNotes.length > 0) {
    lines.push("", "Risk notes:");
    for (const n of riskNotes) lines.push(`- ${n}`);
  }

  if (input.effectfulWithoutIdempotencyKey && input.effectfulWithoutIdempotencyKey.length > 0) {
    lines.push("", "Warnings:");
    for (const stepId of input.effectfulWithoutIdempotencyKey) {
      lines.push(`- step "${stepId}" declares an effectful capability with no idempotencyKey — a crash-and-retry may repeat its side effect`);
    }
  }

  lines.push("", `Approval: ${workflow.approval}`, "Gates:");
  for (const [gate, status] of Object.entries(workflow.gates)) lines.push(`- ${gate}: ${status}`);

  if (workflow.category) lines.push(`Category: ${workflow.category}`);
  if (workflow.keywords && workflow.keywords.length > 0) lines.push(`Keywords: ${workflow.keywords.join(", ")}`);
  if (workflow.examples && workflow.examples.length > 0) lines.push(`Examples: ${workflow.examples.length} provided`);
  if (workflow.generatedByModel) lines.push(`Generated by: ${workflow.generatedByModel}`);

  return lines.join("\n");
}
