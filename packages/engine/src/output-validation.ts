// Workflow-level output contract validation. A block's own output schema is
// validated at dispatch, but outputMapping can reshape several step outputs
// into a different public Workflow.outputs contract. Validate that final
// boundary independently so a block-version or mapping change cannot persist
// a completed run whose advertised result shape is false.
import { isDeepStrictEqual } from "node:util";
import {
  analyzeWorkflowRegexSafety,
  isSupportedFieldType,
  summarizeJsonSerialization,
  type Field,
  type SupportedFieldType,
  type Workflow,
} from "@aart/types";

const MAX_DIAGNOSTIC_VALUE_CHARS = 512;

export class WorkflowOutputValidationError extends Error {
  constructor(public readonly problems: readonly string[]) {
    super(`Workflow output validation failed: ${problems.join("; ")}`);
    this.name = "WorkflowOutputValidationError";
  }
}

function diagnosticValue(value: unknown): string {
  try {
    const serialized = summarizeJsonSerialization(value, MAX_DIAGNOSTIC_VALUE_CHARS, 0);
    if (!serialized) return String(value);
    if (serialized.totalChars <= MAX_DIAGNOSTIC_VALUE_CHARS) return serialized.preview;
    return `${serialized.preview}… [truncated; ${serialized.totalChars} characters total]`;
  } catch {
    return `[unserializable ${actualType(value)}]`;
  }
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

function jsonCompatibilityProblem(
  value: unknown,
  path: string,
  ancestors: Set<object> = new Set(),
): string | undefined {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return undefined;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return `${path} contains a non-finite number, which JSON persistence would convert to null`;
    if (Object.is(value, -0)) return `${path} contains -0, which JSON persistence would convert to 0`;
    return undefined;
  }
  if (typeof value !== "object") {
    return `${path} contains non-JSON value of type "${typeof value}"`;
  }
  if (ancestors.has(value)) return `${path} contains a circular reference`;
  ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          return `${path}[${index}] is a sparse array entry, which JSON persistence would convert to null`;
        }
        const problem = jsonCompatibilityProblem(value[index], `${path}[${index}]`, ancestors);
        if (problem) return problem;
      }
      return undefined;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      const kind = value.constructor?.name ?? "non-plain object";
      return `${path} contains ${kind}; workflow outputs must use plain JSON objects`;
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      return `${path} contains symbol-keyed properties, which JSON persistence would discard`;
    }
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor?.get || descriptor?.set) {
        return `${path}.${key} is an accessor property; workflow outputs must contain stable JSON values`;
      }
      const problem = jsonCompatibilityProblem(
        (value as Record<string, unknown>)[key],
        `${path}.${key}`,
        ancestors,
      );
      if (problem) return problem;
    }
    return undefined;
  } finally {
    ancestors.delete(value);
  }
}

function validateValue(field: Field, value: unknown, problems: string[]): void {
  const compatibilityProblem = jsonCompatibilityProblem(value, `output "${field.name}"`);
  if (compatibilityProblem) {
    problems.push(compatibilityProblem);
    return;
  }

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
    const safety = analyzeWorkflowRegexSafety(field.pattern);
    if (!safety.safe) {
      problems.push(
        `output "${field.name}" declares unsafe pattern ${diagnosticValue(field.pattern)}: ${safety.reason ?? "unbounded backtracking risk"}`,
      );
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
