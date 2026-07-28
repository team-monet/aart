// The YAML `uses`/`with` compiler — architecture §2.3 (elaborated in §10.3).
//
// "The §14.2 model-friendly uses/with/keyed-inputs YAML surface is NOT a
// second type system. It is a compile step ... that parses the sugar form
// and emits a Workflow (canonical, §14.1) via the same Zod schema every
// other producer uses. There is exactly one canonical Workflow shape in
// memory and in the store; YAML is a serialization/authoring convenience on
// the way in." Lives in @aart/mcp, shared by @aart/cli (both need to accept
// the sugar form) — architecture §10.3.
//
// `[DECISION]` (architecture §2.3): the keyed-object `inputs:` -> `Field[]`
// compilation — object key becomes `Field.name`; the value object's keys
// (`type`, `required`, `default`, `enum`, `pattern`, `description`) map 1:1
// onto `Field`'s optional members. Applied symmetrically to `outputs:` too
// (spec §14.2's own example has no `outputs:` block to confirm this against,
// but nothing about the keyed-object convention is inputs-specific, and
// `Field[]` — the compiled target — is the exact same type for both).
import { findExpressionTokens, parseExpression, ExprSyntaxError } from "@aart/expr";
import type { Field, Workflow } from "@aart/types";
import { WorkflowSchema } from "@aart/types";
import yaml from "js-yaml";

export class YamlCompileError extends Error {
  constructor(
    message: string,
    public readonly issues: readonly string[] = [],
  ) {
    super(message);
    this.name = "YamlCompileError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Compiles a keyed-object `{ name: { type, required, default, enum, pattern, description } }` block, or passes an already-array `Field[]` through unchanged (the canonical form fed back through this same compiler — e.g. a workflow round-tripped from the store). */
function compileFields(source: unknown, label: string): Field[] {
  if (source === undefined || source === null) return [];
  if (Array.isArray(source)) return source as Field[];
  if (isPlainObject(source)) {
    return Object.entries(source).map(([name, rawValue]) => {
      const v = isPlainObject(rawValue) ? rawValue : {};
      const field: Record<string, unknown> = { name, type: typeof v.type === "string" ? v.type : "string" };
      if (typeof v.description === "string") field.description = v.description;
      if (typeof v.required === "boolean") field.required = v.required;
      if ("default" in v) field.default = v.default;
      if (Array.isArray(v.enum)) field.enum = v.enum;
      if (typeof v.pattern === "string") field.pattern = v.pattern;
      return field as Field;
    });
  }
  throw new YamlCompileError(`"${label}" must be an array or a keyed object, got ${typeof source}`);
}

/** Every string value reachable inside a JSON-shaped tree (steps' `with:` blocks nest objects/arrays — e.g. `with: { headers: { Authorization: "{{ secrets.X }}" } }`). */
function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out);
  else if (isPlainObject(value)) for (const v of Object.values(value)) collectStrings(v, out);
  return out;
}

function validateExpressionCandidate(candidate: string, label: string, problems: string[]): void {
  const tokens = findExpressionTokens(candidate);
  const unmatchedRemainder = candidate.replace(/\{\{[\s\S]*?\}\}/g, "");
  const unmatchedOpen = unmatchedRemainder.includes("{{");
  const unmatchedClose = unmatchedRemainder.includes("}}");

  if (unmatchedOpen || unmatchedClose) {
    const delimiters = [unmatchedOpen ? '"{{"' : "", unmatchedClose ? '"}}"' : ""].filter(Boolean).join(" and ");
    problems.push(`${label}: unmatched expression delimiter ${delimiters}; every "{{" must have a matching "}}"`);
  }

  for (const match of tokens) {
    try {
      parseExpression(match[0]);
    } catch (err) {
      if (err instanceof ExprSyntaxError) {
        problems.push(`${label}: ${err.message}`);
      } else {
        throw err;
      }
    }
  }
}

/** Syntactically validates every `{{ }}` token found in compiled steps and the workflow's public outputMapping via @aart/expr's real parser (architecture §3.1) — including unmatched delimiters that cannot form a parser token — and fails loudly rather than registering an expression that can never resolve at run time. */
function validateExpressions(steps: readonly Record<string, unknown>[], outputMapping: unknown): void {
  const problems: string[] = [];
  for (const step of steps) {
    const candidates: string[] = [];
    for (const key of ["if", "then", "else", "next", "until", "forEach", "timeout", "idempotencyKey"] as const) {
      const v = step[key];
      if (typeof v === "string") candidates.push(v);
    }
    collectStrings(step.with, candidates);
    for (const candidate of candidates) {
      validateExpressionCandidate(candidate, `step "${String(step.id ?? "?")}"`, problems);
    }
  }
  if (isPlainObject(outputMapping)) {
    for (const [outputName, candidate] of Object.entries(outputMapping)) {
      if (typeof candidate !== "string") continue;
      validateExpressionCandidate(candidate, `outputMapping "${outputName}"`, problems);
    }
  }
  if (problems.length > 0) {
    throw new YamlCompileError(`Invalid {{ }} expression(s):\n${problems.map((p) => `- ${p}`).join("\n")}`, problems);
  }
}

/** Keeps the authored public result contract closed: every required output must be produced, and a mapping cannot silently publish undeclared fields. Optional declared outputs may be omitted. */
function validateOutputContract(workflow: Workflow): void {
  const mappingKeys = new Set(Object.keys(workflow.execution.outputMapping ?? {}));
  const declaredKeys = new Set(workflow.outputs.map((field) => field.name));
  const problems: string[] = [];

  for (const field of workflow.outputs) {
    if (field.required === true && !mappingKeys.has(field.name)) {
      problems.push(`required output "${field.name}" has no outputMapping entry`);
    }
  }
  for (const key of mappingKeys) {
    if (!declaredKeys.has(key)) {
      problems.push(`outputMapping "${key}" is not declared in outputs`);
    }
  }
  if (problems.length > 0) {
    throw new YamlCompileError(`Invalid workflow output contract:\n${problems.map((problem) => `- ${problem}`).join("\n")}`, problems);
  }
}

const DEFAULT_GATES = {
  validate: "pending",
  readiness: "pending",
  evals: "pending",
  riskReview: "pending",
  humanReview: "pending",
} as const;

/**
 * Compiles an already-parsed object (sugar OR canonical shape — both are
 * accepted since the sugar form's step-level fields, `uses`/`with`/`if`/
 * `then`/`else`/`next`/`forEach`/`as`/`maxIterations`/`until`/`retry`/
 * `timeout`/`idempotencyKey`, are already identical to `WorkflowStep`'s
 * canonical field names; only the top-level `inputs`/`outputs` keyed-object
 * sugar and the flat `steps:` (vs. nested `execution.steps`) need compiling)
 * into a canonical `Workflow`, then validates the result against the real,
 * frozen `WorkflowSchema` — a compiled result is validated exactly the same
 * way a hand-constructed `Workflow` object would be (architecture §10.3).
 */
export function compileWorkflowObject(obj: Record<string, unknown>): Workflow {
  const executionSource = isPlainObject(obj.execution) ? obj.execution : undefined;
  const stepsSource = Array.isArray(obj.steps) ? obj.steps : Array.isArray(executionSource?.steps) ? executionSource!.steps : undefined;
  if (!stepsSource) {
    throw new YamlCompileError('Workflow must declare a top-level "steps" array (sugar form) or "execution.steps" (canonical form).');
  }

  const outputMapping = executionSource?.outputMapping ?? obj.outputMapping;

  const compiled: Record<string, unknown> = {
    id: obj.id,
    name: obj.name,
    version: obj.version,
    inputs: compileFields(obj.inputs, "inputs"),
    outputs: compileFields(obj.outputs, "outputs"),
    execution: {
      type: "workflow",
      steps: stepsSource,
      ...(outputMapping !== undefined ? { outputMapping } : {}),
    },
    approval: obj.approval ?? "draft",
    gates: obj.gates ?? DEFAULT_GATES,
  };
  for (const passthroughKey of ["category", "keywords", "examples", "generatedByModel", "needsReview", "promotionBlocked"]) {
    if (obj[passthroughKey] !== undefined) compiled[passthroughKey] = obj[passthroughKey];
  }

  validateExpressions(stepsSource as Record<string, unknown>[], outputMapping);

  const parsed = WorkflowSchema.safeParse(compiled);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new YamlCompileError(`Compiled workflow does not match the canonical Workflow schema:\n${issues.map((i) => `- ${i}`).join("\n")}`, issues);
  }
  validateOutputContract(parsed.data);
  return parsed.data;
}

/** Parses YAML (or JSON — YAML is a superset) source text and compiles it (architecture §10.3's `compileYamlWorkflow(yamlSource) -> Workflow`). */
export function compileYamlWorkflow(yamlSource: string): Workflow {
  let raw: unknown;
  try {
    raw = yaml.load(yamlSource);
  } catch (err) {
    throw new YamlCompileError(`YAML parse error: ${(err as Error).message}`);
  }
  if (!isPlainObject(raw)) {
    throw new YamlCompileError("Workflow YAML must parse to a mapping (object) at the top level.");
  }
  return compileWorkflowObject(raw);
}

/** Accepts either YAML/JSON source text OR an already-parsed object (the common case for an MCP tool's JSON `workflow` argument) and compiles either the same way. */
export function compileWorkflowInput(source: unknown): Workflow {
  if (typeof source === "string") return compileYamlWorkflow(source);
  if (isPlainObject(source)) return compileWorkflowObject(source);
  throw new YamlCompileError(`Workflow input must be a YAML/JSON string or an object, got ${typeof source}`);
}
