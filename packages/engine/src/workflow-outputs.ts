// Workflow output materialization — the single public-result projection used
// both when a run completes and when a post-hoc correction changes a mapped
// StepTrace field. Keeping this projection shared prevents RunRecord.outputs
// from drifting away from the trace it claims to summarize.
import { ExprResolutionError, findExpressionTokens, parseExpression, resolveExpression, type ResolveOptions } from "@aart/expr";
import type { RunRecord, Workflow } from "@aart/types";
import { buildExprContext } from "./expr-context.js";

function referencesSecret(expression: string): boolean {
  return findExpressionTokens(expression).some((token) => parseExpression(token[0]).root === "secrets");
}

function defineOutput(outputs: Record<string, unknown>, name: string, value: unknown): void {
  // Assignment to an ordinary object's "__proto__" key invokes the legacy
  // prototype setter. Define an own data property instead so every valid
  // declared output name is represented without mutating the output map.
  Object.defineProperty(outputs, name, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function referencesOnlyUnexecutedWorkflowStepSources(
  expression: string,
  workflow: Pick<Workflow, "execution">,
  run: RunRecord,
): boolean {
  const tokens = findExpressionTokens(expression);
  const stepIds: string[] = [];
  for (const token of tokens) {
    const parsed = parseExpression(token[0]);
    const first = parsed.path[0];
    const second = parsed.path[1];
    const hasValidStepShape =
      second?.kind === "property" &&
      (second.name === "outputs" || (second.name === "status" && parsed.path.length === 2));
    // Optional omission is only meaningful for a valid public step-output
    // source (or the step status exposed by buildExprContext). A misspelling
    // such as `steps.read.outptus.value` must fail consistently whether or
    // not that branch happened to execute.
    if (parsed.root !== "steps" || first?.kind !== "property" || !hasValidStepShape) {
      return false;
    }
    stepIds.push(first.name);
  }
  if (stepIds.length === 0) return false;

  const declaredStepIds = new Set(workflow.execution.steps.map((step) => step.id));
  return stepIds.every((stepId) => {
    if (!declaredStepIds.has(stepId)) return false;
    const traces = run.trace.filter((trace) => trace.stepId === stepId);
    const latest = traces.at(-1);
    return latest === undefined || latest.status === "skipped";
  });
}

/**
 * Projects a run's current trace/inputs into its declared public outputs.
 * Missing sources omit optional fields but fail required fields later in
 * validateWorkflowOutputs. Public mappings may not read secrets directly:
 * callers persist/report these values, so a secret-dependent public result
 * would either leak or become a redaction marker rather than the authored
 * contract.
 */
export async function materializeWorkflowOutputs(
  workflow: Pick<Workflow, "outputs" | "execution">,
  run: RunRecord,
  options: ResolveOptions = {},
): Promise<Record<string, unknown>> {
  if (!workflow.execution.outputMapping) return run.outputs ?? {};

  const context = buildExprContext(run);
  const fieldsByName = new Map(workflow.outputs.map((field) => [field.name, field]));
  const outputs: Record<string, unknown> = {};

  for (const [name, expression] of Object.entries(workflow.execution.outputMapping)) {
    if (referencesSecret(expression)) {
      throw new Error(`public outputMapping "${name}" may not reference secrets.*; expose a non-secret derived value instead`);
    }
    try {
      defineOutput(outputs, name, await resolveExpression(expression, context, options));
    } catch (err) {
      const field = fieldsByName.get(name);
      if (
        err instanceof ExprResolutionError &&
        field !== undefined &&
        field.required !== true &&
        referencesOnlyUnexecutedWorkflowStepSources(expression, workflow, run)
      ) {
        continue;
      }
      throw err;
    }
  }
  return outputs;
}
