// Workflow output materialization — the single public-result projection used
// both when a run completes and when a post-hoc correction changes a mapped
// StepTrace field. Keeping this projection shared prevents RunRecord.outputs
// from drifting away from the trace it claims to summarize.
import {
  assertExpressionDelimiters,
  ExprResolutionError,
  findExpressionTokens,
  parseExpression,
  resolveExpression,
  type ResolveOptions,
} from "@aart/expr";
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

function isValidWorkflowStepSource(expression: string, declaredStepIds: ReadonlySet<string>): string | undefined {
  const parsed = parseExpression(expression);
  const first = parsed.path[0];
  const second = parsed.path[1];
  const hasValidStepShape =
    second?.kind === "property" &&
    (second.name === "outputs" || (second.name === "status" && parsed.path.length === 2));
  if (parsed.root !== "steps" || first?.kind !== "property" || !hasValidStepShape || !declaredStepIds.has(first.name)) {
    return undefined;
  }
  return first.name;
}

function assertValidWorkflowStepSources(expression: string, workflow: Pick<Workflow, "execution">): void {
  const declaredStepIds = new Set(workflow.execution.steps.map((step) => step.id));
  for (const token of findExpressionTokens(expression)) {
    const parsed = parseExpression(token[0]);
    if (parsed.root === "steps" && isValidWorkflowStepSource(token[0], declaredStepIds) === undefined) {
      throw new Error(
        `public output mapping step references must use a declared steps.<id>.outputs[.<field>] or steps.<id>.status source`,
      );
    }
  }
}

function resolutionFailedForSkippedWorkflowStep(
  error: ExprResolutionError,
  expression: string,
  workflow: Pick<Workflow, "execution">,
  run: RunRecord,
): boolean {
  const declaredStepIds = new Set(workflow.execution.steps.map((step) => step.id));
  // Confirm the failing token belongs to this mapping before using it to
  // decide optional omission.
  if (!findExpressionTokens(expression).some((token) => token[0] === error.expression)) return false;
  const stepId = isValidWorkflowStepSource(error.expression, declaredStepIds);
  if (stepId === undefined) return false;
  const latest = run.trace.filter((trace) => trace.stepId === stepId).at(-1);
  return latest === undefined || latest.status === "skipped";
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
    assertExpressionDelimiters(expression);
    assertValidWorkflowStepSources(expression, workflow);
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
        resolutionFailedForSkippedWorkflowStep(err, expression, workflow, run)
      ) {
        continue;
      }
      throw err;
    }
  }
  return outputs;
}
