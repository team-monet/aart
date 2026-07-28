// Workflow-level output contract validation. A block's own output schema is
// validated at dispatch, but outputMapping can reshape several step outputs
// into a different public Workflow.outputs contract. Validate that final
// boundary independently so a block-version or mapping change cannot persist
// a completed run whose advertised result shape is false.
import { isDeepStrictEqual } from "node:util";
import { isSupportedFieldType, type Field, type SupportedFieldType, type Workflow } from "@aart/types";

const MAX_DIAGNOSTIC_VALUE_CHARS = 512;

export class WorkflowOutputValidationError extends Error {
  constructor(public readonly problems: readonly string[]) {
    super(`Workflow output validation failed: ${problems.join("; ")}`);
    this.name = "WorkflowOutputValidationError";
  }
}

function diagnosticValue(value: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? String(value);
  } catch {
    serialized = `[unserializable ${actualType(value)}]`;
  }
  if (serialized.length <= MAX_DIAGNOSTIC_VALUE_CHARS) return serialized;
  return `${serialized.slice(0, MAX_DIAGNOSTIC_VALUE_CHARS)}… [truncated; ${serialized.length} characters total]`;
}

function actualType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number" && Number.isInteger(value)) return "integer";
  return typeof value;
}

function matchesDeclaredType(value: unknown, declaredType: SupportedFieldType): boolean {
  switch (declaredType) {
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
      return typeof value === declaredType;
    default: {
      const exhaustive: never = declaredType;
      return exhaustive;
    }
  }
}

function validateValue(field: Field, value: unknown, problems: string[]): void {
  // Custom field types predate this validator and may be interpreted by a
  // Pack/integration outside the engine. Preserve those workflows by
  // enforcing only the built-in vocabulary AART can evaluate faithfully.
  if (isSupportedFieldType(field.type) && !matchesDeclaredType(value, field.type)) {
    problems.push(`output "${field.name}" expected type "${field.type}" but received "${actualType(value)}"`);
    return;
  }

  if (field.enum && !field.enum.some((candidate) => isDeepStrictEqual(candidate, value))) {
    problems.push(
      `output "${field.name}" value ${diagnosticValue(value)} is not one of its declared enum values ${diagnosticValue(field.enum)}`,
    );
  }

  if (field.pattern) {
    if (typeof value !== "string") {
      problems.push(`output "${field.name}" declares pattern ${diagnosticValue(field.pattern)} but its value is not a string`);
      return;
    }
    let pattern: RegExp;
    try {
      pattern = new RegExp(field.pattern);
    } catch {
      problems.push(`output "${field.name}" declares invalid pattern ${diagnosticValue(field.pattern)}`);
      return;
    }
    if (!pattern.test(value)) {
      problems.push(
        `output "${field.name}" value ${diagnosticValue(value)} does not match declared pattern ${diagnosticValue(field.pattern)}`,
      );
    }
  }
}

export function validateWorkflowOutputs(workflow: Pick<Workflow, "outputs">, outputs: Record<string, unknown>): void {
  const problems: string[] = [];
  const fieldsByName = new Map<string, Field>();

  for (const field of workflow.outputs) {
    if (fieldsByName.has(field.name)) {
      problems.push(`output "${field.name}" is declared more than once`);
      continue;
    }
    fieldsByName.set(field.name, field);
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
