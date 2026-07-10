// Roots and resolution (architecture §3.2) + the exactly-one-expression-
// preserves-type rule (architecture §3.3, spec §14.3).
import { parseExpression, type ParsedExpression, type PathSegment } from "./parser.js";
import { findExpressionTokens } from "./parser.js";

/**
 * The four data roots resolve against plain values the caller supplies —
 * `@aart/expr` does not know or care about `@aart/types`' shapes, it just
 * walks whatever object graph it's handed. `secrets` is deliberately absent
 * here: architecture §3.2 treats it as "an opaque root it hands to a
 * resolver callback injected by the caller" — @aart/expr never itself
 * touches a secret adapter (this is what lets ADR-10's single-chokepoint
 * rule hold).
 */
export interface ExprContext {
  inputs?: unknown;
  steps?: unknown;
  trigger?: unknown;
  run?: unknown;
}

/** Dependency-injected secret lookup (architecture §3.2's `[DECISION]`) — resolves a bare `secrets.<NAME>` reference's `<NAME>` to its value. May be sync or async; `resolveExpression`/`resolvePath` always return a Promise so either works transparently. */
export type SecretResolver = (name: string) => unknown | Promise<unknown>;

export interface ResolveOptions {
  secretResolver?: SecretResolver;
}

/** Thrown when a syntactically-valid path can't actually be resolved against the supplied context (a missing root, an absent step output, indexing past an array's end, indexing into a non-array, or a `secrets.*` reference with no resolver supplied). Kept distinct from `ExprSyntaxError` (parser.ts): this is a resolution-time failure, not a grammar failure. */
export class ExprResolutionError extends Error {
  constructor(
    message: string,
    public readonly expression: string,
  ) {
    super(message);
    this.name = "ExprResolutionError";
  }
}

function renderPath(root: string, path: PathSegment[], upTo: number): string {
  let rendered = root;
  for (let i = 0; i < upTo; i++) {
    const segment = path[i]!;
    rendered += segment.kind === "property" ? `.${segment.name}` : `[${segment.index}]`;
  }
  return rendered;
}

/**
 * Resolves one already-parsed `{{ }}` expression against `context`,
 * returning its raw (typed) value. `steps.<id>.outputs.<field>`
 * intentionally fails loudly rather than returning `undefined` if `<id>`
 * hasn't completed (or any other segment along the path is missing) —
 * architecture §3.2: "Resolution fails (not silently undefined) if `<id>`
 * hasn't completed yet." The *primary* guarantee of that is a validation-
 * time reachability check owned by governance (spec §18.2); this is
 * @aart/expr's own runtime backstop, so a resolution never silently
 * degrades to `undefined` even if that static check didn't run.
 */
export async function resolvePath(parsed: ParsedExpression, context: ExprContext, options: ResolveOptions = {}): Promise<unknown> {
  if (parsed.root === "secrets") {
    if (parsed.path.length !== 1 || parsed.path[0]?.kind !== "property") {
      throw new ExprResolutionError(
        `secrets.<NAME> must be a single property access; got "{{ ${parsed.raw} }}"`,
        parsed.raw,
      );
    }
    if (!options.secretResolver) {
      throw new ExprResolutionError(
        `"{{ ${parsed.raw} }}" references a secret, but no secretResolver was supplied — @aart/expr never resolves secrets.* itself (architecture §3.2/ADR-10).`,
        parsed.raw,
      );
    }
    return await options.secretResolver(parsed.path[0].name);
  }

  let current: unknown = (context as Record<string, unknown>)[parsed.root];
  for (let i = 0; i < parsed.path.length; i++) {
    if (current === undefined || current === null) {
      throw new ExprResolutionError(
        `Cannot resolve "{{ ${parsed.raw} }}" — "${renderPath(parsed.root, parsed.path, i)}" is ${current === null ? "null" : "undefined"}.`,
        parsed.raw,
      );
    }
    const segment = parsed.path[i]!;
    if (segment.kind === "property") {
      if (typeof current !== "object" || Array.isArray(current)) {
        throw new ExprResolutionError(
          `Cannot resolve "{{ ${parsed.raw} }}" — "${renderPath(parsed.root, parsed.path, i)}" is not an object.`,
          parsed.raw,
        );
      }
      current = (current as Record<string, unknown>)[segment.name];
    } else {
      if (!Array.isArray(current)) {
        throw new ExprResolutionError(
          `Cannot resolve "{{ ${parsed.raw} }}" — "${renderPath(parsed.root, parsed.path, i)}" is not an array, cannot index [${segment.index}].`,
          parsed.raw,
        );
      }
      current = current[segment.index];
    }
  }
  if (current === undefined) {
    throw new ExprResolutionError(`"{{ ${parsed.raw} }}" resolved to undefined.`, parsed.raw);
  }
  return current;
}

function stringifyResolved(value: unknown): string {
  if (value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/**
 * The main entry point (architecture §3.2's `[DECISION]`:
 * `resolveExpression(expr, context, { secretResolver })`). Implements the
 * exactly-one-expression-preserves-type rule (architecture §3.3, spec
 * §14.3):
 *
 * - Non-string `value` (already a number/boolean/object/array/null) passes
 *   through unchanged — `{{ }}` syntax only exists inside strings.
 * - A string with no `{{ }}` token at all passes through unchanged.
 * - A string that, once trimmed, is **exactly** one `{{ expr }}` (nothing
 *   else) resolves and returns the raw value — number/boolean/object/array
 *   preserved as-is, no `String()` coercion (typed passthrough).
 * - Any other placement — embedded in a longer string, or multiple
 *   expressions — resolves every `{{ expr }}` occurrence and replaces it
 *   with its string-coerced value, leaving surrounding literal text
 *   untouched (string interpolation).
 */
export async function resolveExpression(value: unknown, context: ExprContext, options: ResolveOptions = {}): Promise<unknown> {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  const trimmedMatches = findExpressionTokens(trimmed);
  if (trimmedMatches.length === 0) {
    return value;
  }

  const soleMatch = trimmedMatches[0]!;
  const isExactlyOneFullMatch =
    trimmedMatches.length === 1 && soleMatch.index === 0 && soleMatch.index + soleMatch[0].length === trimmed.length;

  if (isExactlyOneFullMatch) {
    const parsed = parseExpression(soleMatch[0]);
    return await resolvePath(parsed, context, options);
  }

  // String interpolation — resolve against the ORIGINAL (untrimmed) value
  // so literal leading/trailing whitespace the author wrote is preserved;
  // trimming above was only ever for the exactly-one-expression detection.
  const matches = findExpressionTokens(value);
  let result = "";
  let cursor = 0;
  for (const match of matches) {
    const index = match.index!;
    result += value.slice(cursor, index);
    const parsed = parseExpression(match[0]);
    const resolved = await resolvePath(parsed, context, options);
    result += stringifyResolved(resolved);
    cursor = index + match[0].length;
  }
  result += value.slice(cursor);
  return result;
}
