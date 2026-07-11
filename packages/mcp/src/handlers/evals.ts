// Eval handlers — aart_create_eval_from_correction, aart_run_eval.
//
// Store-shape note: `EvalSuite.examples` (embedded array, @aart/types) and
// `AartStore.evals.putExample`/`listExamples` (a separate, independently
// queryable collection keyed by `suiteId`) are two ways to reach a suite's
// examples that neither source document reconciles. This module treats
// `listExamples(suiteId)` as authoritative at RUN time (falling back to the
// suite's own embedded `examples` only if the separate collection is empty
// — covering a suite authored with inline examples and never grown via
// `aart_create_eval_from_correction`), so a suite's examples never need to
// be kept in sync in two places by every writer.
import type { EvalExample, EvalSuite } from "@aart/types";
import type { AartContext } from "../context.js";
import type { HandlerResult } from "../response.js";
import { applyGateResult } from "./governance.js";

export interface CreateEvalFromCorrectionInput {
  runId: string;
  stepId: string;
  /** Disambiguates when a step has more than one correction on file; omit to take the most recent. */
  fieldPath?: string;
  suiteId: string;
}

export async function createEvalFromCorrectionHandler(ctx: AartContext, input: CreateEvalFromCorrectionInput): Promise<HandlerResult> {
  const suite = await ctx.store.evals.getSuite(input.suiteId);
  if (!suite) return { ok: false, error: `Eval suite "${input.suiteId}" not found. Create it first (aart eval create).` };

  const corrections = await ctx.store.corrections.list({ runId: input.runId, stepId: input.stepId });
  const candidates = input.fieldPath ? corrections.filter((c) => c.fieldPath === input.fieldPath) : corrections;
  if (candidates.length === 0) {
    return { ok: false, error: `No correction found for run "${input.runId}" step "${input.stepId}"${input.fieldPath ? ` field "${input.fieldPath}"` : ""}. Call aart_record_correction first.` };
  }
  const correction = [...candidates].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1)!;

  const example = await ctx.evidence.createEvalExampleFromCorrection(correction, input.suiteId);
  return { ok: true, example };
}

export interface RunEvalInput {
  suiteId: string;
  workflowId: string;
  workflowVersion?: string;
  /**
   * S14 "gate write paths": the `promotion.requires[].evals.minScore`
   * threshold (spec §24.5) this run is evaluated against. OMITTED (the
   * pre-S14 default): this run is purely informational and never touches
   * `gates.evals` — unchanged behavior for every existing caller. SUPPLIED:
   * `@aart/evidence`'s own promotion-gate threshold comparison
   * (`computeEvalsGateStatus`, architecture §9.6 — "the one gate whose
   * pass/fail isn't binary-by-nature") decides passed/failed from
   * `evalRun.score`, and that exact evidence-owned decision (not a
   * reimplementation of it) is what gets written.
   */
  minScore?: number;
}

export async function runEvalHandler(ctx: AartContext, input: RunEvalInput): Promise<HandlerResult> {
  const suite = await ctx.store.evals.getSuite(input.suiteId);
  if (!suite) return { ok: false, error: `Eval suite "${input.suiteId}" not found.` };

  const workflow = input.workflowVersion
    ? await ctx.store.workflows.get(input.workflowId, input.workflowVersion)
    : await ctx.store.workflows.getLatest(input.workflowId);
  if (!workflow) return { ok: false, error: `Workflow ${input.workflowId}${input.workflowVersion ? `@${input.workflowVersion}` : ""} not found.` };

  const storedExamples: EvalExample[] = await ctx.store.evals.listExamples(input.suiteId);
  const effectiveSuite: EvalSuite = { ...suite, examples: storedExamples.length > 0 ? storedExamples : suite.examples };

  const evalRun = await ctx.evidence.runEval(effectiveSuite, workflow.id, workflow.version);

  if (input.minScore !== undefined) {
    const gateStatus = ctx.evidence.computeEvalsGateStatus(evalRun, input.minScore);
    const gateWrite = await applyGateResult(ctx, workflow.id, workflow.version, "evals", gateStatus);
    if (gateWrite.ok) {
      return { ok: evalRun.failed === 0, evalRun, gates: gateWrite.gates, approval: gateWrite.approval };
    }
  }

  return { ok: evalRun.failed === 0, evalRun };
}
