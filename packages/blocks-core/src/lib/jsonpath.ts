// A minimal JSONPath subset for `assert.jsonpath` (spec §15.3). Deliberately
// NOT a full JSONPath implementation (no filter expressions `[?(...)]`, no
// recursive descent `..`, no slices) — this package takes a zero-new-
// npm-dependency approach for this block rather than pulling in a
// third-party JSONPath library, matching the "most blocks are thin,
// mechanical wrappers" sizing this session's plan calls for. Supported
// grammar:
//
//   JsonPath := "$" Step*
//   Step     := "." Identifier | "." "*" | "[" Index "]" | "[" "*" "]"
//             | "[" QuotedKey "]"
//   Identifier := [A-Za-z0-9_$-]+
//   Index    := [0-9]+
//   QuotedKey := "'" ... "'" | '"' ... '"'
//
// `queryJsonPath` always returns an array of every matching node (standard
// JSONPath semantics — a query can match zero, one, or many nodes), even
// for a path with no wildcard, so callers don't need two different return
// shapes depending on whether a `*` was used.

export type JsonPathToken =
  | { type: "root" }
  | { type: "prop"; name: string }
  | { type: "index"; index: number }
  | { type: "wildcard" };

export class JsonPathSyntaxError extends Error {
  constructor(
    message: string,
    public readonly source: string,
  ) {
    super(message);
    this.name = "JsonPathSyntaxError";
  }
}

const IDENTIFIER_CHAR = /[A-Za-z0-9_$-]/;
const DIGIT = /[0-9]/;

export function parseJsonPath(path: string): JsonPathToken[] {
  const trimmed = path.trim();
  if (!trimmed.startsWith("$")) {
    throw new JsonPathSyntaxError(`JSONPath must start with "$" — got ${JSON.stringify(path)}`, path);
  }

  const tokens: JsonPathToken[] = [{ type: "root" }];
  let i = 1;
  const len = trimmed.length;

  while (i < len) {
    const ch = trimmed[i];
    if (ch === ".") {
      i++;
      if (trimmed[i] === "*") {
        tokens.push({ type: "wildcard" });
        i++;
        continue;
      }
      const start = i;
      while (i < len && IDENTIFIER_CHAR.test(trimmed[i]!)) i++;
      if (i === start) {
        throw new JsonPathSyntaxError(`Expected a property name after "." at position ${start} in ${JSON.stringify(path)}`, path);
      }
      tokens.push({ type: "prop", name: trimmed.slice(start, i) });
    } else if (ch === "[") {
      i++;
      if (trimmed[i] === "*") {
        i++;
        if (trimmed[i] !== "]") {
          throw new JsonPathSyntaxError(`Expected closing "]" in ${JSON.stringify(path)}`, path);
        }
        i++;
        tokens.push({ type: "wildcard" });
        continue;
      }
      if (trimmed[i] === "'" || trimmed[i] === '"') {
        const quote = trimmed[i];
        i++;
        const start = i;
        while (i < len && trimmed[i] !== quote) i++;
        if (i >= len) {
          throw new JsonPathSyntaxError(`Unterminated string literal in ${JSON.stringify(path)}`, path);
        }
        const name = trimmed.slice(start, i);
        i++; // closing quote
        if (trimmed[i] !== "]") {
          throw new JsonPathSyntaxError(`Expected closing "]" in ${JSON.stringify(path)}`, path);
        }
        i++;
        tokens.push({ type: "prop", name });
        continue;
      }
      const start = i;
      while (i < len && DIGIT.test(trimmed[i]!)) i++;
      if (i === start) {
        throw new JsonPathSyntaxError(
          `Expected a numeric index, quoted key, or "*" inside "[ ]" at position ${start} in ${JSON.stringify(path)}`,
          path,
        );
      }
      const index = Number(trimmed.slice(start, i));
      if (trimmed[i] !== "]") {
        throw new JsonPathSyntaxError(`Expected closing "]" in ${JSON.stringify(path)}`, path);
      }
      i++;
      tokens.push({ type: "index", index });
    } else {
      throw new JsonPathSyntaxError(
        `Unexpected character ${JSON.stringify(ch)} at position ${i} in ${JSON.stringify(path)} — supported grammar is "$" (root), ".prop", "[n]", "['key']"/["\\"key\\""], and "*" wildcards only (no filters/recursive-descent/slices).`,
        path,
      );
    }
  }

  return tokens;
}

/** Every node matching `path` against `data` — always an array (0, 1, or many matches), standard JSONPath convention. */
export function queryJsonPath(data: unknown, path: string): unknown[] {
  const tokens = parseJsonPath(path);
  let current: unknown[] = [data];

  for (const token of tokens.slice(1)) {
    const next: unknown[] = [];
    for (const item of current) {
      if (token.type === "prop") {
        if (item !== null && typeof item === "object" && !Array.isArray(item) && token.name in (item as Record<string, unknown>)) {
          next.push((item as Record<string, unknown>)[token.name]);
        }
      } else if (token.type === "index") {
        if (Array.isArray(item) && token.index >= 0 && token.index < item.length) {
          next.push(item[token.index]);
        }
      } else if (token.type === "wildcard") {
        if (Array.isArray(item)) {
          next.push(...item);
        } else if (item !== null && typeof item === "object") {
          next.push(...Object.values(item as Record<string, unknown>));
        }
      }
    }
    current = next;
  }

  return current;
}
