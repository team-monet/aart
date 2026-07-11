// Execution handlers — aart_run_workflow, aart_get_report, aart_verify.
//
// These three necessarily depend on StubEngine/StubEvidence (stubs/engine.ts,
// stubs/evidence.ts) — real step dispatch is S1's exclusive scope
// (architecture §4.2), real report rendering is S6's (architecture §9.1) —
// so the RunRecord these produce is real and store-persisted, but the
// "execution" itself is the documented simulation described in
// stubs/engine.ts's module comment, not genuine block dispatch.
import type { RunRecord, Trigger, Workflow } from "@aart/types";
import type { AartContext } from "../context.js";
import type { HandlerResult } from "../response.js";
import { newId } from "../stubs/engine.js";
import { compileWorkflowInput, YamlCompileError } from "../yaml-compiler.js";
import { applyGateResult } from "./governance.js";

async function resolveWorkflow(ctx: AartContext, workflowId: string, workflowVersion?: string): Promise<Workflow | undefined> {
  return workflowVersion ? ctx.store.workflows.get(workflowId, workflowVersion) : ctx.store.workflows.getLatest(workflowId);
}

function summarizeTrace(run: RunRecord) {
  return run.trace.map((t) => ({ stepId: t.stepId, block: t.block, status: t.status, error: t.error }));
}

export interface RunWorkflowInput {
  workflowId: string;
  workflowVersion?: string;
  input?: Record<string, unknown>;
  dryRun?: boolean;
}

export async function runWorkflowHandler(ctx: AartContext, input: RunWorkflowInput): Promise<HandlerResult> {
  const workflow = await resolveWorkflow(ctx, input.workflowId, input.workflowVersion);
  if (!workflow) return { ok: false, error: `Workflow ${input.workflowId}${input.workflowVersion ? `@${input.workflowVersion}` : ""} not found. Call aart_register_block first.` };

  const trigger: Trigger = {
    id: newId("trig"),
    type: "mcp",
    source: "aart_run_workflow",
    payload: input.input ?? {},
    receivedAt: ctx.now().toISOString(),
  };
  const created = await ctx.engine.triggerRun({
    workflow,
    trigger,
    inputs: input.input ?? {},
    params: input.dryRun ? { dryRun: true } : undefined,
    approved: workflow.approval === "approved",
    approvalMode: ctx.trustMode,
  });
  const finished = await ctx.engine.executeRun(created.runId);

  // Readiness gate (S14 "gate write paths"): a genuinely-completed, non-dry
  // real run of THIS EXACT registered version satisfies spec §17.1's
  // readiness gate — "this version has actually been run for real."
  // `workflow` above is always resolved from the store (resolveWorkflow),
  // never an ad-hoc/unregistered source — there is no "run a local file
  // directly" path anywhere in this handler (or `aart run`, which only ever
  // takes a workflowId) — so "a local file-based run doesn't count" holds
  // by construction, not by an extra check here. A dry run
  // (params.dryRun) fakes every capability-gated block's dispatch (S1's
  // documented semantics, engine/step-executor.ts's isDryRun branch) and so
  // proves nothing real; excluded explicitly, since "completed" alone
  // doesn't distinguish a dry run from a genuine one. Every caller of this
  // shared handler goes through this same check — aart run / aart_run_workflow
  // directly, and aart_verify indirectly (verifyHandler below calls this
  // function) — matching the brief's "via aart run ... or aart_verify
  // against it." No waived-guard: kept consistent with the pre-existing
  // humanReview writer (applyVersionReviewDecision), which has never
  // special-cased a prior "waived" state either, and "waived"/"passed" are
  // behaviorally identical for computeApprovalState/promotion purposes —
  // only the descriptive label differs.
  let gates = workflow.gates;
  let approval = workflow.approval;
  if (finished.status === "completed" && !input.dryRun) {
    const gateWrite = await applyGateResult(ctx, workflow.id, workflow.version, "readiness", "passed");
    if (gateWrite.ok) {
      gates = gateWrite.gates as typeof gates;
      approval = gateWrite.approval as typeof approval;
    }
  }

  return {
    ok: finished.status === "completed" || finished.status === "waiting",
    runId: finished.runId,
    status: finished.status,
    outputs: finished.outputs,
    error: finished.error,
    trace: summarizeTrace(finished),
    gates,
    approval,
  };
}

export interface GetReportInput {
  runId: string;
  format?: "model" | "markdown";
}

export async function getReportHandler(ctx: AartContext, input: GetReportInput): Promise<HandlerResult> {
  const run = await ctx.store.runs.get(input.runId);
  if (!run) return { ok: false, error: `Run "${input.runId}" not found.` };
  const report = ctx.evidence.modelFacingReport(run);
  const result: HandlerResult = { ok: true, report };
  if (input.format === "markdown") result.markdown = ctx.evidence.markdownReport(run);
  return result;
}

export interface VerifyInput {
  url: string;
  expect?: string;
}

const VERIFY_WORKFLOW_ID = "__aart_verify__";

/** Builds (and, if not already present, registers) a tiny synthetic workflow so aart_verify -> aart_run_workflow -> aart_get_report reuses the SAME run pipeline every other tool call goes through, rather than a bespoke one-off code path (architecture's three-clients / one-function principle applied even to this "easiest success path" tool). */
async function ensureVerifyWorkflow(ctx: AartContext, expect: string | undefined): Promise<Workflow> {
  const version = expect ? "0.1.0-with-expect" : "0.1.0-no-expect";
  const existing = await ctx.store.workflows.get(VERIFY_WORKFLOW_ID, version);
  if (existing) return existing;

  const steps = expect
    ? [
        { id: "open", uses: "browser.goto", with: { url: "{{ inputs.url }}" } },
        { id: "read", uses: "web.read" },
        { id: "assert", uses: "assert.contains", with: { actual: "{{ steps.read.outputs.text }}", expected: "{{ inputs.expect }}" } },
        { id: "screenshot", uses: "browser.screenshot", with: { name: "verify" } },
      ]
    : [
        { id: "open", uses: "browser.goto", with: { url: "{{ inputs.url }}" } },
        { id: "read", uses: "web.read" },
        { id: "screenshot", uses: "browser.screenshot", with: { name: "verify" } },
      ];

  const compiled = compileWorkflowInput({
    id: VERIFY_WORKFLOW_ID,
    name: "AART Verify (synthetic, aart_verify)",
    version,
    inputs: expect ? { url: { type: "string", required: true }, expect: { type: "string", required: true } } : { url: { type: "string", required: true } },
    steps,
    approval: "approved",
    gates: { validate: "waived", readiness: "waived", evals: "waived", riskReview: "waived", humanReview: "waived" },
  });
  await ctx.store.workflows.put(compiled);
  return compiled;
}

/** aart_verify — the "agent's easiest success path" (spec §32.6): one call, url + optional expect, evidence report back. */
export async function verifyHandler(ctx: AartContext, input: VerifyInput): Promise<HandlerResult> {
  let workflow: Workflow;
  try {
    workflow = await ensureVerifyWorkflow(ctx, input.expect);
  } catch (err) {
    if (err instanceof YamlCompileError) return { ok: false, error: err.message };
    throw err;
  }
  const runResult = await runWorkflowHandler(ctx, {
    workflowId: workflow.id,
    workflowVersion: workflow.version,
    input: input.expect ? { url: input.url, expect: input.expect } : { url: input.url },
  });
  if (!runResult.runId || typeof runResult.runId !== "string") return { ok: false, error: "aart_verify: run did not produce a runId." };
  const run = await ctx.store.runs.get(runResult.runId);
  if (!run) return { ok: false, error: "aart_verify: run vanished immediately after execution." };
  const report = ctx.evidence.modelFacingReport(run);
  return { ok: report.headline === "passed", report, runId: run.runId };
}
