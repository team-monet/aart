// resolveDataPath — property-path navigation for the `data.*` block group
// (pick/map/filter), reusing `@aart/expr`'s own PropertyPath grammar
// (architecture §3.1) rather than hand-rolling a second dot/bracket parser.
//
// `@aart/expr`'s `parseExpression`/`resolvePath` are gated to the 5 wire
// roots (inputs/steps/trigger/run/secrets, architecture §3.2) and require
// the `{{ }}` wrapper — neither fits a block that wants to navigate an
// arbitrary caller-supplied object by a bare path like `"user.address[0]"`.
// This module bridges the two: it synthesizes a `{{ data.<path> }}`
// expression and resolves it against a one-off `{ data: <value> }` context,
// so a `data.*` block's path string reuses @aart/expr's exact segment
// grammar (dot property / bracket numeric index, operator-token rejection)
// instead of a parallel implementation that could drift from it.
import { parseExpression, resolvePath, type ExprContext } from "@aart/expr";

/** Thrown when a path string isn't valid PropertyPath grammar, or doesn't resolve against `value` (missing key, index past an array's end, etc). Wraps the underlying `@aart/expr` error with the caller's own bare path (not the synthetic `inputs.<path>` wrapper) for a clearer message. */
export class DataPathError extends Error {
  constructor(
    public readonly path: string,
    cause: unknown,
  ) {
    super(`data path "${path}" could not be resolved — ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "DataPathError";
    this.cause = cause;
  }
}

/** Resolves a bare dot/bracket path (e.g. `"a.b[0].c"`, `"[0].b"`, or `""` for the value itself — no `{{ }}`/root prefix) against `value`, via `@aart/expr`'s PropertyPath grammar. Reuses `inputs` as the synthetic carrier root: `@aart/expr`'s `ExprContext` has no `data` root, and `inputs` is otherwise unused in this one-off context, so `resolveDataPath(value, "a.b")` is exactly `resolvePath` on `{{ inputs.a.b }}` against `{ inputs: value }`. */
export async function resolveDataPath(value: unknown, path: string): Promise<unknown> {
  const trimmed = path.trim();
  const wireForm =
    trimmed.length === 0 ? "{{ inputs }}" : trimmed.startsWith("[") ? `{{ inputs${trimmed} }}` : `{{ inputs.${trimmed} }}`;
  const context: ExprContext = { inputs: value };
  try {
    const parsed = parseExpression(wireForm);
    return await resolvePath(parsed, context);
  } catch (cause) {
    throw new DataPathError(path, cause);
  }
}

/** Same as `resolveDataPath`, but returns `undefined` instead of throwing when the path doesn't resolve (used by `data.filter`'s `exists` predicate, where a missing path is a meaningful, non-exceptional outcome). */
export async function tryResolveDataPath(value: unknown, path: string): Promise<{ found: true; value: unknown } | { found: false }> {
  try {
    return { found: true, value: await resolveDataPath(value, path) };
  } catch {
    return { found: false };
  }
}
