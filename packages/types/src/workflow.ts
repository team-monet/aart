// Workflow, WorkflowStep, Field, Example — spec §14.1.
import { z } from "zod";
import { ApprovalStateSchema, ConcurrencyPolicySchema, GatesSchema, RetryPolicySchema } from "./governance.js";

/** Built-in field types whose runtime semantics AART understands directly. */
export const SUPPORTED_FIELD_TYPES = ["any", "array", "boolean", "integer", "json", "null", "number", "object", "string", "unknown"] as const;
export type SupportedFieldType = (typeof SUPPORTED_FIELD_TYPES)[number];

export function isSupportedFieldType(type: string): type is SupportedFieldType {
  return (SUPPORTED_FIELD_TYPES as readonly string[]).includes(type);
}

/** Whether a regex pattern can meaningfully refine this field type. */
export function isPatternCompatibleFieldType(type: string): boolean {
  // Custom types are opaque and may be string-like (for example, "date").
  // `any`/`json`/`unknown` can also validly carry a string; the runtime
  // pattern check remains the authority for the mapped value.
  return !isSupportedFieldType(type) || type === "string" || type === "any" || type === "json" || type === "unknown";
}

export interface RegexSafetyAnalysis {
  safe: boolean;
  reason?: string;
}

const MAX_WORKFLOW_REGEX_CHARS = 1_024;

function quantifierEnd(pattern: string, index: number): number | undefined {
  const char = pattern[index];
  if (char === "*" || char === "+" || char === "?") return index + 1;
  if (char !== "{") return undefined;
  const match = /^\{\d+(?:,\d*)?\}/.exec(pattern.slice(index));
  return match ? index + match[0].length : undefined;
}

interface QuantifiedAtom {
  source: string;
  asciiDecidable: boolean;
}

function atomsMayOverlap(left: QuantifiedAtom, right: QuantifiedAtom): boolean {
  if (left.source === "." || right.source === "." || left.source === right.source) return true;

  // A single atom cannot itself cause catastrophic evaluation, so testing
  // their intersection over ASCII is bounded. Non-ASCII/property escapes
  // remain conservatively overlapping when ASCII cannot decide the result.
  try {
    const leftRegex = new RegExp(`^(?:${left.source})$`, "u");
    const rightRegex = new RegExp(`^(?:${right.source})$`, "u");
    for (let code = 0; code <= 0x7f; code++) {
      const candidate = String.fromCharCode(code);
      if (leftRegex.test(candidate) && rightRegex.test(candidate)) return true;
    }
  } catch {
    return true;
  }
  return !(left.asciiDecidable && right.asciiDecidable);
}

function matchingGroupEnd(source: string, groupStart: number): number | undefined {
  let depth = 0;
  let inCharacterClass = false;
  for (let index = groupStart; index < source.length; index++) {
    const char = source[index]!;
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "[") {
      inCharacterClass = true;
      continue;
    }
    if (char === "]" && inCharacterClass) {
      inCharacterClass = false;
      continue;
    }
    if (inCharacterClass) continue;
    if (char === "(") depth += 1;
    if (char === ")" && --depth === 0) return index;
  }
  return undefined;
}

function isZeroWidthFragment(source: string): boolean {
  for (let index = 0; index < source.length; ) {
    const char = source[index]!;
    if (char === "^" || char === "$" || char === "|") {
      index += 1;
      continue;
    }
    if (char === "\\" && (source[index + 1] === "b" || source[index + 1] === "B")) {
      index += 2;
      continue;
    }
    if (char === "(") {
      const groupEnd = matchingGroupEnd(source, index);
      if (groupEnd === undefined || !isZeroWidthGroup(source, index, groupEnd)) return false;
      index = groupEnd + 1;
      continue;
    }
    return false;
  }
  return true;
}

function isZeroWidthGroup(pattern: string, groupStart: number, groupEnd: number): boolean {
  const source = pattern.slice(groupStart, groupEnd + 1);
  if (
    source.startsWith("(?=") ||
    source.startsWith("(?!") ||
    source.startsWith("(?<=") ||
    source.startsWith("(?<!")
  ) {
    return true;
  }
  let contentStart: number | undefined;
  if (source.startsWith("(?:")) {
    contentStart = 3;
  } else if (source.startsWith("(?<")) {
    const nameEnd = source.indexOf(">", 3);
    contentStart = nameEnd === -1 ? undefined : nameEnd + 1;
  } else {
    contentStart = source.startsWith("(?") ? undefined : 1;
  }
  return contentStart !== undefined && isZeroWidthFragment(source.slice(contentStart, -1));
}

function sequentialQuantifierProblem(pattern: string): string | undefined {
  const previousByDepth: Array<QuantifiedAtom | undefined> = [undefined];
  const groupStartByDepth: Array<number | undefined> = [undefined];
  let depth = 0;

  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === "(") {
      depth += 1;
      previousByDepth[depth] = undefined;
      groupStartByDepth[depth] = i;
      continue;
    }
    if (char === ")") {
      const groupStart = groupStartByDepth[depth];
      previousByDepth[depth] = undefined;
      depth = Math.max(0, depth - 1);
      const end = quantifierEnd(pattern, i + 1);
      const zeroWidthGroup = groupStart !== undefined && isZeroWidthGroup(pattern, groupStart, i);
      if (zeroWidthGroup) {
        if (end !== undefined) {
          i = end - 1;
          if (pattern[i + 1] === "?") i += 1;
        }
      } else if (groupStart !== undefined && end !== undefined) {
        const source = pattern.slice(groupStart, i + 1);
        const atom = {
          source,
          asciiDecidable: /^[\x00-\x7f]*$/.test(source) && !/\\(?:[pP]\{|u|x)/.test(source),
        };
        const previous = previousByDepth[depth];
        if (previous && atomsMayOverlap(previous, atom)) {
          return "overlapping sequential quantifiers are not allowed";
        }
        previousByDepth[depth] = atom;
        i = end - 1;
        if (pattern[i + 1] === "?") i += 1;
      } else {
        previousByDepth[depth] = undefined;
      }
      continue;
    }
    if (char === "|") {
      previousByDepth[depth] = undefined;
      continue;
    }
    if (char === "^" || char === "$") continue;

    let atomEnd = i + 1;
    let atom: QuantifiedAtom;
    const zeroWidthEscape = char === "\\" && (pattern[i + 1] === "b" || pattern[i + 1] === "B");
    if (char === "\\") {
      if ((pattern[i + 1] === "p" || pattern[i + 1] === "P") && pattern[i + 2] === "{") {
        const propertyEnd = pattern.indexOf("}", i + 3);
        atomEnd = propertyEnd === -1 ? pattern.length : propertyEnd + 1;
      } else {
        atomEnd = Math.min(pattern.length, i + 2);
      }
      const source = pattern.slice(i, atomEnd);
      atom = {
        source,
        asciiDecidable: !/^\\(?:[pP]\{|u|x)/.test(source),
      };
    } else if (char === "[") {
      let escaped = false;
      let classEnd = i + 1;
      for (; classEnd < pattern.length; classEnd++) {
        const classChar = pattern[classEnd]!;
        if (!escaped && classChar === "]") {
          classEnd += 1;
          break;
        }
        escaped = !escaped && classChar === "\\";
        if (classChar !== "\\") escaped = false;
      }
      atomEnd = classEnd;
      const source = pattern.slice(i, atomEnd);
      atom = {
        source,
        asciiDecidable: /^[\x00-\x7f]*$/.test(source) && !/\\(?:[pP]\{|u|x)/.test(source),
      };
    } else {
      atom = { source: char, asciiDecidable: char.charCodeAt(0) <= 0x7f };
    }

    const end = quantifierEnd(pattern, atomEnd);
    if (end !== undefined) {
      const previous = previousByDepth[depth];
      if (previous && atomsMayOverlap(previous, atom)) {
        return "overlapping sequential quantifiers are not allowed";
      }
      previousByDepth[depth] = atom;
      i = end - 1;
      if (pattern[i + 1] === "?") i += 1;
    } else {
      if (!zeroWidthEscape) previousByDepth[depth] = undefined;
      i = atomEnd - 1;
    }
  }
  return undefined;
}

/**
 * Conservative ReDoS guard for workflow-authored patterns.
 *
 * AART accepts the JavaScript RegExp vocabulary, but rejects constructs
 * whose backtracking cost cannot be safely bounded at terminal run
 * finalization: oversized patterns, backreferences, and repeated groups
 * that themselves contain repetition or alternation. This intentionally
 * favors a smaller predictable subset over synchronously evaluating a
 * potentially hostile expression on the worker event loop.
 */
export function analyzeWorkflowRegexSafety(pattern: string): RegexSafetyAnalysis {
  if (pattern.length > MAX_WORKFLOW_REGEX_CHARS) {
    return { safe: false, reason: `pattern exceeds ${MAX_WORKFLOW_REGEX_CHARS} characters` };
  }

  const sequentialProblem = sequentialQuantifierProblem(pattern);
  if (sequentialProblem) return { safe: false, reason: sequentialProblem };

  const groups: Array<{ containsQuantifier: boolean; containsAlternation: boolean }> = [];
  let inCharacterClass = false;

  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === "\\") {
      const escaped = pattern[i + 1];
      if (
        !inCharacterClass &&
        escaped !== undefined &&
        (/[1-9]/.test(escaped) || (escaped === "k" && pattern[i + 2] === "<"))
      ) {
        return { safe: false, reason: "backreferences are not allowed" };
      }
      i += 1;
      continue;
    }
    if (char === "[") {
      inCharacterClass = true;
      continue;
    }
    if (char === "]" && inCharacterClass) {
      inCharacterClass = false;
      continue;
    }
    if (inCharacterClass) continue;

    if (char === "(") {
      groups.push({ containsQuantifier: false, containsAlternation: false });
      continue;
    }
    if (char === "|") {
      const current = groups.at(-1);
      if (current) current.containsAlternation = true;
      continue;
    }
    if (char === ")") {
      const closed = groups.pop();
      if (!closed) continue;
      const repeated = quantifierEnd(pattern, i + 1) !== undefined;
      if (repeated && closed.containsQuantifier) {
        return { safe: false, reason: "nested quantified groups are not allowed" };
      }
      if (repeated && closed.containsAlternation) {
        return { safe: false, reason: "repeated alternation groups are not allowed" };
      }
      const parent = groups.at(-1);
      if (parent) {
        parent.containsQuantifier ||= closed.containsQuantifier || repeated;
        parent.containsAlternation ||= closed.containsAlternation;
      }
      continue;
    }

    if (
      quantifierEnd(pattern, i) !== undefined &&
      !(char === "?" && pattern[i - 1] === "(") &&
      !(char === "?" && (pattern[i - 1] === "*" || pattern[i - 1] === "+" || pattern[i - 1] === "?" || pattern[i - 1] === "}"))
    ) {
      const current = groups.at(-1);
      if (current) current.containsQuantifier = true;
    }
  }

  return { safe: true };
}

export const FieldSchema = z.object({
  name: z.string(),
  // Field types were intentionally extensible before workflow-output
  // validation existed. Keep that wire/store compatibility: integrations
  // may attach semantics to custom values such as "date". The engine
  // validates the built-in vocabulary and treats custom types as opaque.
  type: z.string(),
  description: z.string().optional(),
  required: z.boolean().optional(),
  default: z.unknown().optional(),
  enum: z.array(z.unknown()).optional(),
  pattern: z.string().optional(),
});
export type Field = z.infer<typeof FieldSchema>;

export const ExampleSchema = z.object({
  description: z.string(),
  inputs: z.record(z.string(), z.unknown()),
});
export type Example = z.infer<typeof ExampleSchema>;

export const WorkflowStepSchema = z.object({
  id: z.string(),
  uses: z.string(),
  with: z.record(z.string(), z.unknown()).optional(),
  if: z.string().optional(),
  then: z.string().optional(),
  else: z.string().optional(),
  next: z.string().optional(),
  forEach: z.string().optional(),
  as: z.string().optional(),
  maxIterations: z.number().optional(),
  until: z.string().optional(),
  retry: RetryPolicySchema.optional(),
  timeout: z.string().optional(),
  idempotencyKey: z.string().optional(),
});
export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;

export const WorkflowSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  inputs: z.array(FieldSchema),
  outputs: z.array(FieldSchema),
  execution: z.object({
    type: z.literal("workflow"),
    steps: z.array(WorkflowStepSchema),
    outputMapping: z.record(z.string(), z.string()).optional(),
  }),
  approval: ApprovalStateSchema,
  gates: GatesSchema,
  category: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  examples: z.array(ExampleSchema).optional(),
  generatedByModel: z.string().optional(),
  // Architecture-introduced, beyond spec §14.1's literal Workflow shape
  // (architecture §5.3's `workflows` table: `needs_review`, `promotion_blocked`
  // columns; A21/A30 fixes; spec §23.4 correction-outcome list). Added here,
  // on the canonical type, following the same flag-and-add pattern this
  // architecture already uses for RunRecord.flag (run.ts) and
  // Trigger.dedupeKey (trigger.ts), rather than inventing a parallel
  // store-only query surface for two booleans consumed at promotion-check
  // time. See AMENDMENTS.md.
  needsReview: z.boolean().optional(),
  promotionBlocked: z.boolean().optional(),
  // Architecture-introduced (S1/Wave-1 amendment — see AMENDMENTS.md A16),
  // same flag-and-add pattern as needsReview/promotionBlocked immediately
  // above and RunRecord.flag (run.ts)/Trigger.dedupeKey (trigger.ts): spec
  // §30.1 shows `concurrency: { key, policy }` as a "per workflow" YAML
  // example, and architecture §4.3 fully designs the enforcement semantics
  // for all four ConcurrencyPolicy values against this exact shape, but
  // neither document ever adds a field for it to spec §14.1's literal
  // Workflow TS block — without a home on the canonical type, the engine's
  // trigger-intake path (architecture §4.3) has no way to read a workflow's
  // declared concurrency policy at all. `key` is a `{{ }}` expression
  // resolved against `inputs.*` at trigger time (architecture §4.3).
  concurrency: z
    .object({
      key: z.string(),
      policy: ConcurrencyPolicySchema,
    })
    .optional(),
});
export type Workflow = z.infer<typeof WorkflowSchema>;
