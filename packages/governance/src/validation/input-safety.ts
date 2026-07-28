// Class 4 — Input safety validation (spec §18.4): "enum constraints, regex
// patterns, defaults valid, no unsafe interpolation into command binaries,
// secrets referenced correctly." Plus architecture §4.2/§7.7's
// effectful-capability-without-idempotencyKey WARNING (advisory, never
// blocking).
import {
  assertExpressionDelimiters,
  ExprSyntaxError,
  findExpressionTokens,
  parseExpression,
} from "@aart/expr";
import {
  analyzeWorkflowRegexSafety,
  isPatternCompatibleFieldType,
  type Field,
  type Workflow,
  type WorkflowStep,
} from "@aart/types";
import type { CapabilityClosureLookup } from "../capability.js";
import type { ValidationFinding } from "./types.js";

// ---------------------------------------------------------------------------
// (a) enum / regex / default consistency — spec §18.4
// ---------------------------------------------------------------------------

function validateFieldConsistency(field: Field, path: string, findings: ValidationFinding[], isOutput = false): void {
  if (field.enum && field.default !== undefined) {
    const inEnum = field.enum.some((v) => JSON.stringify(v) === JSON.stringify(field.default));
    if (!inEnum) {
      findings.push({
        class: "input-safety",
        path: `${path}.default`,
        message: `Field "${field.name}"'s default value ${JSON.stringify(field.default)} is not one of its declared enum values ${JSON.stringify(field.enum)}`,
        severity: "error",
      });
    }
  }
  if (field.pattern) {
    if (isOutput && !isPatternCompatibleFieldType(field.type)) {
      findings.push({
        class: "input-safety",
        path: `${path}.pattern`,
        message: `Output "${field.name}" declares a pattern but has non-string type "${field.type}"`,
        severity: "error",
      });
    }
    let regex: RegExp | undefined;
    const safety = analyzeWorkflowRegexSafety(field.pattern);
    if (!safety.safe) {
      findings.push({
        class: "input-safety",
        path: `${path}.pattern`,
        message: `Field "${field.name}"'s pattern is unsafe to evaluate: ${safety.reason ?? "unbounded backtracking risk"}`,
        severity: "error",
      });
    } else {
      try {
        regex = new RegExp(field.pattern);
      } catch {
        findings.push({
          class: "input-safety",
          path: `${path}.pattern`,
          message: `Field "${field.name}"'s pattern "${field.pattern}" is not a valid regular expression`,
          severity: "error",
        });
      }
    }
    if (regex && typeof field.default === "string" && !regex.test(field.default)) {
      findings.push({
        class: "input-safety",
        path: `${path}.default`,
        message: `Field "${field.name}"'s default value ${JSON.stringify(field.default)} does not match its declared pattern "${field.pattern}"`,
        severity: "error",
      });
    }
  }
}

// ---------------------------------------------------------------------------
// (b) no unsafe interpolation into command binaries — spec §18.4,
// implementation-plan S4 note: "applies to command.run specifically."
// ---------------------------------------------------------------------------

// ADR-08 spawns command.run without a shell at all — no shell metacharacter
// can ever be shell-interpreted, so this check is explicitly DEFENSE IN
// DEPTH (architecture §7.7's own framing: "moot in the strict sense... but
// validation still flags... as defense in depth"), not the primary defense.
const SHELL_METACHARACTERS = /[;&|`$(){}<>*?~!#]/;

// A `{{ }}`-expression's own inner content is safe by @aart/expr's grammar
// (§14.3: property paths only, operators are a hard parse-time rejection) —
// strip expression substrings before scanning literal remainder for
// metacharacters, so a legitimate `{{ steps.x.outputs.y }}` reference never
// self-flags.
const EXPRESSION_PATTERN = /\{\{[^}]*\}\}/g;

function stringsIn(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) stringsIn(v, out);
  } else if (value !== null && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) stringsIn(v, out);
  }
}

function validateCommandInterpolation(step: WorkflowStep, path: string, findings: ValidationFinding[]): void {
  if (step.uses !== "command.run" || !step.with) return;
  const strings: string[] = [];
  stringsIn(step.with, strings);
  for (const raw of strings) {
    const literalRemainder = raw.replace(EXPRESSION_PATTERN, "");
    if (SHELL_METACHARACTERS.test(literalRemainder)) {
      findings.push({
        class: "input-safety",
        path: `${path}.with`,
        message: `command.run step "${step.id}" has a literal argv value containing a shell metacharacter (${literalRemainder.match(SHELL_METACHARACTERS)?.[0]}) — inert under ADR-08's no-shell spawn, but flagged as defense in depth`,
        severity: "error",
      });
    }
  }
}

// ---------------------------------------------------------------------------
// (c) secrets referenced correctly — spec §18.4: "secrets referenced
// correctly; secrets referenced via secrets.<NAME> syntax correctly, never
// as literal strings." Inherently heuristic (this module cannot know for
// certain a literal string IS a secret) — flags a modest set of
// well-known secret-shaped literal patterns as a WARNING advisory, never a
// hard failure, since a false positive here (a coincidentally key-shaped
// but genuinely non-secret literal) shouldn't block validation outright.
// ---------------------------------------------------------------------------

const SECRET_SHAPED_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/, // OpenAI/Anthropic/Stripe-style secret keys
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/, // GitHub personal-access-token family
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, // Slack tokens
];

function validateSecretLiterals(step: WorkflowStep, path: string, findings: ValidationFinding[]): void {
  if (!step.with) return;
  const strings: string[] = [];
  stringsIn(step.with, strings);
  for (const raw of strings) {
    const literalRemainder = raw.replace(EXPRESSION_PATTERN, "");
    for (const pattern of SECRET_SHAPED_PATTERNS) {
      if (pattern.test(literalRemainder)) {
        findings.push({
          class: "input-safety",
          path: `${path}.with`,
          message: `Step "${step.id}" appears to reference a secret-shaped literal value directly in "with:" — secrets must be referenced via {{ secrets.<NAME> }}, never as a literal string`,
          severity: "warning", // heuristic, not certain — advisory rather than blocking
        });
        break;
      }
    }
  }
}

function validateOutputMappingExpressions(
  outputMapping: Readonly<Record<string, string>>,
  steps: readonly WorkflowStep[],
  findings: ValidationFinding[],
): void {
  const knownStepIds = new Set(steps.map((step) => step.id));

  for (const [outputName, candidate] of Object.entries(outputMapping)) {
    const path = `execution.outputMapping.${outputName}`;
    const addProblem = (message: string): void => {
      findings.push({
        class: "input-safety",
        path,
        message: `outputMapping "${outputName}": ${message}`,
        severity: "error",
      });
    };

    try {
      assertExpressionDelimiters(candidate);
    } catch (error) {
      if (error instanceof ExprSyntaxError) addProblem(error.message);
      else throw error;
    }

    for (const match of findExpressionTokens(candidate)) {
      try {
        const parsed = parseExpression(match[0]);
        if (parsed.root === "secrets") {
          addProblem("public workflow outputs may not reference secrets.*; expose a non-secret derived value instead");
        }
        if (parsed.root !== "steps") continue;

        const step = parsed.path[0];
        if (step?.kind === "property" && !knownStepIds.has(step.name)) {
          addProblem(`references unknown step "${step.name}"`);
        }
        const resultPath = parsed.path[1];
        const hasValidStepShape =
          resultPath?.kind === "property" &&
          (resultPath.name === "outputs" || (resultPath.name === "status" && parsed.path.length === 2));
        if (step?.kind !== "property" || !hasValidStepShape) {
          addProblem("step references must use steps.<id>.outputs[.<field>] or steps.<id>.status");
        }
      } catch (error) {
        if (error instanceof ExprSyntaxError) addProblem(error.message);
        else throw error;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// (d) effectful-capability-without-idempotencyKey WARNING — architecture
// §4.2/§7.7. Advisory, never blocking.
// ---------------------------------------------------------------------------

function isEffectfulCapability(capability: string): boolean {
  if (capability === "email.send" || capability === "command") return true;
  if (capability.startsWith("domain:")) return true; // "external write connector" — spec §31.1's own example row
  return /write/i.test(capability); // file.write, db.write, and forward-compatible with future write-shaped capabilities
}

export function findEffectfulStepsWithoutIdempotencyKey(
  steps: readonly WorkflowStep[],
  lookup: CapabilityClosureLookup,
): string[] {
  const flagged: string[] = [];
  for (const step of steps) {
    if (step.idempotencyKey) continue;
    const node = lookup.resolve(step.uses);
    if (!node || node.kind !== "block") continue; // nested workflow-blocks' own idempotency is their own concern, not this workflow's
    if (node.capabilities.some(isEffectfulCapability)) flagged.push(step.id);
  }
  return flagged;
}

// ---------------------------------------------------------------------------
// orchestrator
// ---------------------------------------------------------------------------

export function validateInputSafety(workflow: Pick<Workflow, "inputs" | "outputs" | "execution">, blockCatalog: CapabilityClosureLookup): ValidationFinding[] {
  const findings: ValidationFinding[] = [];

  workflow.inputs.forEach((field, i) => validateFieldConsistency(field, `inputs[${i}]`, findings));
  const outputNames = new Set<string>();
  workflow.outputs.forEach((field, i) => {
    validateFieldConsistency(field, `outputs[${i}]`, findings, true);
    if (outputNames.has(field.name)) {
      findings.push({
        class: "input-safety",
        path: `outputs[${i}].name`,
        message: `Output "${field.name}" is declared more than once`,
        severity: "error",
      });
    }
    outputNames.add(field.name);
  });

  const outputMapping = workflow.execution.outputMapping ?? {};
  validateOutputMappingExpressions(outputMapping, workflow.execution.steps, findings);
  const mappedOutputNames = new Set(Object.keys(outputMapping));
  workflow.outputs.forEach((field) => {
    if (field.required === true && !mappedOutputNames.has(field.name)) {
      findings.push({
        class: "input-safety",
        path: `execution.outputMapping.${field.name}`,
        message: `Required output "${field.name}" has no outputMapping entry`,
        severity: "error",
      });
    }
  });
  for (const mappedName of mappedOutputNames) {
    if (!outputNames.has(mappedName)) {
      findings.push({
        class: "input-safety",
        path: `execution.outputMapping.${mappedName}`,
        message: `outputMapping "${mappedName}" is not declared in outputs`,
        severity: "error",
      });
    }
  }

  workflow.execution.steps.forEach((step, i) => {
    const path = `steps[${i}]`;
    validateCommandInterpolation(step, path, findings);
    validateSecretLiterals(step, path, findings);
  });

  const effectfulWithoutKey = findEffectfulStepsWithoutIdempotencyKey(workflow.execution.steps, blockCatalog);
  for (const stepId of effectfulWithoutKey) {
    findings.push({
      class: "input-safety",
      path: `steps[?]`.replace("?", stepId),
      message: `Step "${stepId}" declares an effectful capability with no "idempotencyKey" — a crash-and-retry may repeat its side effect`,
      severity: "warning",
    });
  }

  return findings;
}
