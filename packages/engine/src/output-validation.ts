// Workflow-level output contract validation. A block's own output schema is
// validated at dispatch, but outputMapping can reshape several step outputs
// into a different public Workflow.outputs contract. Validate that final
// boundary independently so a block-version or mapping change cannot persist
// a completed run whose advertised result shape is false.
import { isDeepStrictEqual } from "node:util";
import {
  analyzeWorkflowRegexSafety,
  isSupportedFieldType,
  type Field,
  type SupportedFieldType,
  type Workflow,
} from "@aart/types";

const MAX_DIAGNOSTIC_VALUE_CHARS = 512;
const DIAGNOSTIC_STRING_CHUNK_CHARS = 256;
const OMIT_FROM_JSON = Symbol("omit-from-json");

interface BoundedJsonSerialization {
  preview: string;
  totalChars: number;
}

interface JsonAccumulator {
  preview: string;
  totalChars: number;
}

export class WorkflowOutputValidationError extends Error {
  constructor(public readonly problems: readonly string[]) {
    super(`Workflow output validation failed: ${problems.join("; ")}`);
    this.name = "WorkflowOutputValidationError";
  }
}

function appendJson(accumulator: JsonAccumulator, value: string): void {
  accumulator.totalChars += value.length;
  const remaining = MAX_DIAGNOSTIC_VALUE_CHARS - accumulator.preview.length;
  if (remaining > 0) accumulator.preview += value.slice(0, remaining);
}

function appendJsonString(accumulator: JsonAccumulator, value: string): void {
  appendJson(accumulator, '"');
  for (let offset = 0; offset < value.length; ) {
    let end = Math.min(value.length, offset + DIAGNOSTIC_STRING_CHUNK_CHARS);
    const lastCodeUnit = value.charCodeAt(end - 1);
    const nextCodeUnit = value.charCodeAt(end);
    if (
      end < value.length &&
      lastCodeUnit >= 0xd800 &&
      lastCodeUnit <= 0xdbff &&
      nextCodeUnit >= 0xdc00 &&
      nextCodeUnit <= 0xdfff
    ) {
      end -= 1;
    }
    const encodedChunk = JSON.stringify(value.slice(offset, end)).slice(1, -1);
    appendJson(accumulator, encodedChunk);
    offset = end;
  }
  appendJson(accumulator, '"');
}

function normalizeJsonValue(value: unknown, key: string, inArray: boolean): unknown | typeof OMIT_FROM_JSON {
  if (value !== null && typeof value === "object") {
    const toJSON = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === "function") value = toJSON.call(value, key);
    if (value instanceof Number || value instanceof String || value instanceof Boolean) value = value.valueOf();
  }

  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    return inArray ? null : OMIT_FROM_JSON;
  }
  if (typeof value === "bigint") throw new TypeError("BigInt cannot be serialized to JSON");
  return value;
}

function writeNormalizedJson(
  value: unknown,
  accumulator: JsonAccumulator,
  seen: Set<object>,
): void {
  if (value === null) {
    appendJson(accumulator, "null");
    return;
  }
  if (typeof value === "string") {
    appendJsonString(accumulator, value);
    return;
  }
  if (typeof value === "number") {
    appendJson(accumulator, Number.isFinite(value) ? JSON.stringify(value) : "null");
    return;
  }
  if (typeof value === "boolean") {
    appendJson(accumulator, value ? "true" : "false");
    return;
  }
  if (typeof value !== "object") {
    throw new TypeError(`Unsupported JSON value: ${typeof value}`);
  }
  if (seen.has(value)) throw new TypeError("Converting circular structure to JSON");
  seen.add(value);

  try {
    if (Array.isArray(value)) {
      appendJson(accumulator, "[");
      for (let index = 0; index < value.length; index++) {
        if (index > 0) appendJson(accumulator, ",");
        const normalized = normalizeJsonValue(value[index], String(index), true);
        writeNormalizedJson(normalized, accumulator, seen);
      }
      appendJson(accumulator, "]");
      return;
    }

    appendJson(accumulator, "{");
    let writtenProperties = 0;
    for (const key of Object.keys(value)) {
      const normalized = normalizeJsonValue((value as Record<string, unknown>)[key], key, false);
      if (normalized === OMIT_FROM_JSON) continue;
      if (writtenProperties > 0) appendJson(accumulator, ",");
      appendJsonString(accumulator, key);
      appendJson(accumulator, ":");
      writeNormalizedJson(normalized, accumulator, seen);
      writtenProperties += 1;
    }
    appendJson(accumulator, "}");
  } finally {
    seen.delete(value);
  }
}

function boundedJsonSerialization(value: unknown): BoundedJsonSerialization | undefined {
  const normalized = normalizeJsonValue(value, "", false);
  if (normalized === OMIT_FROM_JSON) return undefined;
  const accumulator: JsonAccumulator = { preview: "", totalChars: 0 };
  writeNormalizedJson(normalized, accumulator, new Set());
  return accumulator;
}

function diagnosticValue(value: unknown): string {
  try {
    const serialized = boundedJsonSerialization(value);
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
