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
import type { RunRecord, StepTrace, Workflow } from "@aart/types";
import { buildExprContext } from "./expr-context.js";

function referencesSecret(expression: string): boolean {
  return findExpressionTokens(expression).some((token) => parseExpression(token[0]).root === "secrets");
}

function outputPointer(path: ReturnType<typeof parseExpression>["path"]): string {
  return path
    .slice(2)
    .map((segment) =>
      segment.kind === "property"
        ? `/${segment.name.replaceAll("~", "~0").replaceAll("/", "~1")}`
        : `/${segment.index}`,
    )
    .join("");
}

function rootPointer(path: ReturnType<typeof parseExpression>["path"]): string {
  return path
    .map((segment) =>
      segment.kind === "property"
        ? `/${segment.name.replaceAll("~", "~0").replaceAll("/", "~1")}`
        : `/${segment.index}`,
    )
    .join("");
}

function pathsOverlap(left: string, right: string): boolean {
  if (left === "*" || right === "") return true;
  return (
    left === right ||
    left.startsWith(`${right}/`) ||
    right.startsWith(`${left}/`)
  );
}

function traceDataTaintsPointer(trace: StepTrace, pointer: string): boolean {
  if (trace.secretTainted !== true) return false;
  const paths =
    trace.secretTaintedPaths ??
    // Records created before path-level provenance conservatively taint all
    // outputs. An explicit empty list denotes control-only provenance.
    ["*"];
  return paths.some((path) => pathsOverlap(path, pointer));
}

export function assertNoSecretTaintedOutputSources(
  workflow: Pick<Workflow, "execution">,
  run: RunRecord,
): void {
  if (!workflow.execution.outputMapping) return;
  for (const [outputName, expression] of Object.entries(workflow.execution.outputMapping)) {
    for (const token of findExpressionTokens(expression)) {
      const parsed = parseExpression(token[0]);
      if (parsed.root === "inputs" || parsed.root === "trigger") {
        const paths =
          parsed.root === "inputs"
            ? run.secretTaintedInputPaths
            : run.secretTaintedTriggerPaths;
        const pointer = rootPointer(parsed.path);
        if (paths?.some((path) => pathsOverlap(path, pointer))) {
          throw new Error(
            `public outputMapping "${outputName}" depends on secret-tainted ${parsed.root} path "${pointer || "/"}"; expose a non-secret derived value instead`,
          );
        }
        continue;
      }
      if (parsed.root !== "steps") continue;
      const first = parsed.path[0];
      if (first === undefined) {
        const latestByStepId = new Map<string, StepTrace>();
        for (const trace of run.trace) latestByStepId.set(trace.stepId, trace);
        if (
          [...latestByStepId.values()].some(
            (trace) =>
              trace.controlSecretTainted === true ||
              traceDataTaintsPointer(trace, ""),
          )
        ) {
          throw new Error(
            `public outputMapping "${outputName}" depends on the full steps context containing secret-tainted traces; expose a non-secret derived value instead`,
          );
        }
        continue;
      }
      if (first.kind !== "property") continue;
      const source = run.trace.filter((trace) => trace.stepId === first.name).at(-1);
      if (source?.controlSecretTainted === true) {
        throw new Error(
          `public outputMapping "${outputName}" depends on secret-tainted step "${first.name}" because its execution path was secret-controlled; expose a result whose selection does not depend on secret data`,
        );
      }
      const second = parsed.path[1];
      if (source && second?.kind === "property" && second.name === "outputs") {
        const pointer = outputPointer(parsed.path);
        if (traceDataTaintsPointer(source, pointer)) {
          throw new Error(
            `public outputMapping "${outputName}" depends on secret-tainted step "${first.name}" output path "${pointer || "/"}"; expose a non-secret derived value instead`,
          );
        }
      } else if (source && traceDataTaintsPointer(source, "")) {
        throw new Error(
          `public outputMapping "${outputName}" depends on secret-tainted step "${first.name}"; expose a non-secret derived value instead`,
        );
      }
    }
  }
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

  assertNoSecretTaintedOutputSources(workflow, run);
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
