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
  return { ok: evalRun.failed === 0, evalRun };
}
