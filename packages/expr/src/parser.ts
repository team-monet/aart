// Grammar (architecture §3.1):
//
//   Expression   := "{{" WS PropertyPath WS "}}"
//   PropertyPath := Root ("." Identifier | "[" Index "]")*
//   Root         := "inputs" | "steps" | "trigger" | "run" | "secrets"
//
// Single sigil form only — no alternate syntax anywhere in the system
// (spec §14.3). Deliberately excluded: operators, arithmetic, comparisons,
// function calls (spec §14.3 "Scope, deliberately"). The parser rejects
// (throws) any expression containing an operator token rather than
// silently truncating or best-effort-evaluating it — a hard grammar
// boundary, not a soft preference (architecture §3.1) — because it's what
// keeps every value in a run traceable to a producing step.

export const EXPR_ROOTS = ["inputs", "steps", "trigger", "run", "secrets"] as const;
export type ExprRoot = (typeof EXPR_ROOTS)[number];

export type PathSegment = { kind: "property"; name: string } | { kind: "index"; index: number };

export interface ParsedExpression {
  root: ExprRoot;
  path: PathSegment[];
  /** The exact `{{ ... }}` source text this was parsed from — useful for error messages and for `resolveExpression`'s per-match string coercion. */
  raw: string;
}

/**
 * Thrown for any `{{ }}` content that isn't a valid PropertyPath per
 * architecture §3.1 — including the operator-token-rejection case
 * (architecture §3.1/§3.4). Deliberately @aart/expr's own error type, not
 * `@aart/types`' `ValidationError`: this package has zero workspace
 * dependencies by design, so it can be built and tested in total isolation
 * (architecture §3.2). Governance's validation engine (§18.1, spec class 1,
 * owned by S4) is expected to catch this and re-shape it into the richer
 * errors-as-corrections `ValidationError` (didYouMean/correctedSnippet) at
 * the point it's surfaced to a workflow author — @aart/expr's job stops at
 * failing loudly with a specific, actionable message.
 */
export class ExprSyntaxError extends Error {
  constructor(
    message: string,
    public readonly source: string,
  ) {
    super(message);
    this.name = "ExprSyntaxError";
  }
}

const EXPRESSION_WRAPPER = /^\{\{\s*([\s\S]*?)\s*\}\}$/;
const IDENTIFIER_CHAR = /[A-Za-z0-9_]/;
const IDENTIFIER_START_CHAR = /[A-Za-z_]/;
const DIGIT = /[0-9]/;

// Operators/arithmetic/comparisons/function-calls are all out of grammar
// (spec §14.3). Longer tokens are listed before their prefixes so the
// substring-based `inner.includes(op)` scan in `assertNoOperatorTokens`
// reports the most specific token actually present (e.g. "===" rather than
// just "=").
const OPERATOR_TOKENS = [
  "===",
  "!==",
  "==",
  "!=",
  "<=",
  ">=",
  "&&",
  "||",
  "+",
  "-",
  "*",
  "/",
  "%",
  "<",
  ">",
  "!",
  "(",
  ")",
  ",",
  "?",
  ":",
  "=",
] as const;

function assertNoOperatorTokens(inner: string, source: string): void {
  for (const op of OPERATOR_TOKENS) {
    if (inner.includes(op)) {
      throw new ExprSyntaxError(
        `AART expressions are property paths only — operators are not supported ("${op}" found in "{{ ${inner} }}"). Compute this in a step and reference its output via steps.<id>.outputs.<field> instead (architecture §3.1/§3.4).`,
        source,
      );
    }
  }
}

function isValidRoot(value: string): value is ExprRoot {
  return (EXPR_ROOTS as readonly string[]).includes(value);
}

/**
 * Parses a single, already-isolated `{{ ... }}` token (whitespace around
 * the outer delimiters is tolerated and stripped; whitespace inside, per
 * the grammar's `WS`, is only meaningful immediately inside `{{`/`}}`, not
 * within the path itself). Throws `ExprSyntaxError` for anything that
 * isn't a well-formed PropertyPath over one of the 5 roots.
 */
export function parseExpression(source: string): ParsedExpression {
  const trimmedOuter = source.trim();
  const wrapperMatch = EXPRESSION_WRAPPER.exec(trimmedOuter);
  if (!wrapperMatch) {
    throw new ExprSyntaxError(`Not a valid {{ }} expression: ${JSON.stringify(source)}`, source);
  }
  const inner = wrapperMatch[1] ?? "";
  if (inner.length === 0) {
    throw new ExprSyntaxError(`Empty {{ }} expression: ${JSON.stringify(source)}`, source);
  }

  assertNoOperatorTokens(inner, source);

  let i = 0;
  const len = inner.length;

  function readIdentifier(label: string): string {
    const start = i;
    if (i < len && IDENTIFIER_START_CHAR.test(inner[i]!)) {
      i++;
      while (i < len && IDENTIFIER_CHAR.test(inner[i]!)) i++;
    }
    if (i === start) {
      throw new ExprSyntaxError(`Expected ${label} at position ${start} in "{{ ${inner} }}"`, source);
    }
    return inner.slice(start, i);
  }

  const root = readIdentifier("a root (inputs | steps | trigger | run | secrets)");
  if (!isValidRoot(root)) {
    throw new ExprSyntaxError(
      `Unknown expression root "${root}" — must be one of: ${EXPR_ROOTS.join(", ")} (architecture §3.2).`,
      source,
    );
  }

  const path: PathSegment[] = [];
  while (i < len) {
    const ch = inner[i];
    if (ch === ".") {
      i++;
      const name = readIdentifier("a property name after \".\"");
      path.push({ kind: "property", name });
    } else if (ch === "[") {
      i++;
      const start = i;
      while (i < len && DIGIT.test(inner[i]!)) i++;
      if (i === start) {
        throw new ExprSyntaxError(`Expected a numeric index inside "[ ]" at position ${start} in "{{ ${inner} }}"`, source);
      }
      const index = Number(inner.slice(start, i));
      if (inner[i] !== "]") {
        throw new ExprSyntaxError(`Expected closing "]" in "{{ ${inner} }}"`, source);
      }
      i++;
      path.push({ kind: "index", index });
    } else {
      throw new ExprSyntaxError(
        `Unexpected character "${ch}" at position ${i} in "{{ ${inner} }}" — AART expressions are property paths only (Root ("." Identifier | "[" Index "]")*, architecture §3.1).`,
        source,
      );
    }
  }

  return { root, path, raw: trimmedOuter };
}

/** Every non-overlapping `{{ ... }}` occurrence in `value`, using the same lazy match as `parseExpression`'s own wrapper so a run of several expressions in one string (e.g. string interpolation) is split correctly rather than one greedy match spanning from the first `{{` to the last `}}`. */
export function findExpressionTokens(value: string): RegExpMatchArray[] {
  return Array.from(value.matchAll(/\{\{[\s\S]*?\}\}/g));
}
