// Workflow-level output contract validation. A block's own output schema is
// validated at dispatch, but outputMapping can reshape several step outputs
// into a different public Workflow.outputs contract. Validate that final
// boundary independently so a block-version or mapping change cannot persist
// a completed run whose advertised result shape is false.
import { isDeepStrictEqual } from "node:util";
import type { Field, Workflow } from "@aart/types";

export class WorkflowOutputValidationError extends Error {
  constructor(public readonly problems: readonly string[]) {
    super(`Workflow output validation failed: ${problems.join("; ")}`);
    this.name = "WorkflowOutputValidationError";
  }
}

function actualType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number" && Number.isInteger(value)) return "integer";
  return typeof value;
}

function matchesDeclaredType(value: unknown, declaredType: string): boolean {
  switch (declaredType.toLowerCase()) {
    case "any":
    case "json":
    case "unknown":
      return true;
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    case "integer":
      return typeof value === "number" && Number.isSafeInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "string":
    case "boolean":
      return typeof value === declaredType.toLowerCase();
    default:
      return false;
  }
}

function validateValue(field: Field, value: unknown, problems: string[]): void {
  if (!matchesDeclaredType(value, field.type)) {
    problems.push(`output "${field.name}" expected type "${field.type}" but received "${actualType(value)}"`);
    return;
  }

  if (field.enum && !field.enum.some((candidate) => isDeepStrictEqual(candidate, value))) {
    problems.push(`output "${field.name}" value ${JSON.stringify(value)} is not one of its declared enum values ${JSON.stringify(field.enum)}`);
  }

  if (field.pattern) {
    if (typeof value !== "string") {
      problems.push(`output "${field.name}" declares pattern "${field.pattern}" but its value is not a string`);
      return;
    }
    let pattern: RegExp;
    try {
      pattern = new RegExp(field.pattern);
    } catch {
      problems.push(`output "${field.name}" declares invalid pattern "${field.pattern}"`);
      return;
    }
    if (!pattern.test(value)) {
      problems.push(`output "${field.name}" value ${JSON.stringify(value)} does not match declared pattern "${field.pattern}"`);
    }
  }
}

export function validateWorkflowOutputs(workflow: Pick<Workflow, "outputs">, outputs: Record<string, unknown>): void {
  const problems: string[] = [];
  const fieldsByName = new Map(workflow.outputs.map((field) => [field.name, field]));

  for (const field of workflow.outputs) {
    if (field.required === true && !Object.prototype.hasOwnProperty.call(outputs, field.name)) {
      problems.push(`required output "${field.name}" is missing`);
    }
  }

  for (const [name, value] of Object.entries(outputs)) {
    const field = fieldsByName.get(name);
    if (!field) {
      problems.push(`output "${name}" is not declared in Workflow.outputs`);
      continue;
    }
    validateValue(field, value, problems);
  }

  if (problems.length > 0) throw new WorkflowOutputValidationError(problems);
}
