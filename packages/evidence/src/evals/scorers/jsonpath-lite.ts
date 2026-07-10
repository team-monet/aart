// jsonpath-lite.ts — a deliberately scoped-down JSONPath evaluator backing
// the jsonpath_exact/jsonpath_contains scorer kinds (spec §24.3). Supports
// the common subset needed for eval-example assertions against known-shape
// JSON: root `$`, dot-properties (`$.foo.bar`), bracket-properties
// (`$['foo']`/`$["foo"]`), array indices incl. negative (`$.foo[0]`,
// `$.foo[-1]`), and the wildcard `[*]`/`.* ` (every element/value at that
// level).
//
// Deliberately does NOT implement the full RFC 9535 grammar — no filter
// expressions (`[?(@.x>5)]`), no recursive descent (`..`), no slices, no
// script expressions. This is a documented, deliberate scope decision (see
// this task's final report) for a scorer whose job is exact-match/contains
// checks against a known shape, not general-purpose JSON querying. Neither
// spec nor architecture specifies a JSONPath implementation/library, and
// adding a third-party dependency for this narrow a need was judged not
// worth it — a future consumer that needs the fuller grammar is a natural,
// separately-scoped extension point.
export class JsonPathSyntaxError extends Error {}

type Token = { kind: "prop"; name: string } | { kind: "index"; index: number } | { kind: "wildcard" };

function tokenize(path: string): Token[] {
  const trimmed = path.trim();
  if (trimmed === "$") return [];
  if (!trimmed.startsWith("$")) {
    throw new JsonPathSyntaxError(`JSONPath must start with "$": got "${path}"`);
  }
  const s = trimmed.slice(1);
  const tokens: Token[] = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === ".") {
      i++;
      if (s[i] === "*") {
        tokens.push({ kind: "wildcard" });
        i++;
        continue;
      }
      const match = /^[a-zA-Z0-9_-]+/.exec(s.slice(i));
      if (!match) throw new JsonPathSyntaxError(`Expected a property name after "." at index ${i} in "${path}"`);
      tokens.push({ kind: "prop", name: match[0] });
      i += match[0].length;
    } else if (ch === "[") {
      const close = s.indexOf("]", i);
      if (close === -1) throw new JsonPathSyntaxError(`Unterminated "[" in "${path}"`);
      const inner = s.slice(i + 1, close).trim();
      if (inner === "*") {
        tokens.push({ kind: "wildcard" });
      } else if (/^-?\d+$/.test(inner)) {
        tokens.push({ kind: "index", index: Number(inner) });
      } else if ((inner.startsWith("'") && inner.endsWith("'")) || (inner.startsWith('"') && inner.endsWith('"'))) {
        tokens.push({ kind: "prop", name: inner.slice(1, -1) });
      } else {
        throw new JsonPathSyntaxError(
          `Unsupported bracket expression "[${inner}]" in "${path}" — this is a deliberately scoped JSONPath subset (see module doc comment); filters/slices/scripts are not supported.`,
        );
      }
      i = close + 1;
    } else {
      throw new JsonPathSyntaxError(`Unexpected character "${ch}" at index ${i} in "${path}"`);
    }
  }
  return tokens;
}

/**
 * True iff `path`'s LAST token is a wildcard (`.*` or `[*]`) — used by
 * jsonpath_exact (jsonpath-exact.ts) to decide whether to compare a single
 * value or the full matched array against `expected`. Token-based rather
 * than a raw string-suffix check (`path.endsWith("*")` would miss the
 * bracket form `[*]`, whose last character is `]`, not `*`).
 */
export function pathEndsInWildcard(path: string): boolean {
  const tokens = tokenize(path);
  return tokens.length > 0 && tokens[tokens.length - 1]!.kind === "wildcard";
}

/**
 * Evaluates `path` against `value`, returning every match (0, 1, or many —
 * many only possible once a wildcard token is involved). A missing
 * property or an out-of-range index simply contributes no match rather
 * than throwing — a JSONPath query is inherently "does this exist," not a
 * hard resolution requirement the way `@aart/expr`'s `steps.*` paths are.
 */
export function jsonPathQuery(value: unknown, path: string): unknown[] {
  const tokens = tokenize(path);
  let current: unknown[] = [value];
  for (const token of tokens) {
    const next: unknown[] = [];
    for (const item of current) {
      if (item === null || item === undefined) continue;
      if (token.kind === "prop") {
        if (typeof item === "object" && !Array.isArray(item) && Object.hasOwn(item as object, token.name)) {
          next.push((item as Record<string, unknown>)[token.name]);
        }
      } else if (token.kind === "index") {
        if (Array.isArray(item)) {
          const idx = token.index < 0 ? item.length + token.index : token.index;
          if (idx >= 0 && idx < item.length) next.push(item[idx]);
        }
      } else {
        if (Array.isArray(item)) {
          next.push(...item);
        } else if (typeof item === "object") {
          next.push(...Object.values(item as Record<string, unknown>));
        }
      }
    }
    current = next;
  }
  return current;
}
