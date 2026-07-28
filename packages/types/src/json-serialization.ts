const JSON_STRING_CHUNK_CHARS = 256;
const OMIT_FROM_JSON = Symbol("omit-from-json");

export interface JsonSerializationSummary {
  /** Compact JSON prefix, never longer than the requested preview budget. */
  preview: string;
  /** Exact compact JSON character count. */
  totalChars: number;
  /** Exact JSON character count with the requested indentation. */
  prettyChars: number;
}

interface JsonMetrics {
  totalChars: number;
  prettyChars: number;
}

interface SerializationState {
  preview: string;
  previewChars: number;
  indentChars: number;
  seen: Set<object>;
}

function appendPreview(state: SerializationState, value: string): void {
  const remaining = state.previewChars - state.preview.length;
  if (remaining > 0) state.preview += value.slice(0, remaining);
}

function writeJsonString(state: SerializationState, value: string): number {
  appendPreview(state, '"');
  let totalChars = 2;
  for (let offset = 0; offset < value.length; ) {
    let end = Math.min(value.length, offset + JSON_STRING_CHUNK_CHARS);
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
    appendPreview(state, encodedChunk);
    totalChars += encodedChunk.length;
    offset = end;
  }
  appendPreview(state, '"');
  return totalChars;
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
  depth: number,
  state: SerializationState,
): JsonMetrics {
  if (value === null) {
    appendPreview(state, "null");
    return { totalChars: 4, prettyChars: 4 };
  }
  if (typeof value === "string") {
    const chars = writeJsonString(state, value);
    return { totalChars: chars, prettyChars: chars };
  }
  if (typeof value === "number") {
    const serialized = Number.isFinite(value) ? JSON.stringify(value) : "null";
    appendPreview(state, serialized);
    return { totalChars: serialized.length, prettyChars: serialized.length };
  }
  if (typeof value === "boolean") {
    const serialized = value ? "true" : "false";
    appendPreview(state, serialized);
    return { totalChars: serialized.length, prettyChars: serialized.length };
  }
  if (typeof value !== "object") throw new TypeError(`Unsupported JSON value: ${typeof value}`);
  if (state.seen.has(value)) throw new TypeError("Converting circular structure to JSON");
  state.seen.add(value);

  try {
    if (Array.isArray(value)) {
      appendPreview(state, "[");
      let totalChars = 1;
      let prettyChars = value.length === 0 ? 1 : 2; // "[" or "[\n"
      for (let index = 0; index < value.length; index++) {
        if (index > 0) {
          appendPreview(state, ",");
          totalChars += 1;
          prettyChars += 1;
        }
        const normalized = normalizeJsonValue(value[index], String(index), true);
        const child = writeNormalizedJson(normalized, depth + 1, state);
        totalChars += child.totalChars;
        prettyChars += (depth + 1) * state.indentChars + child.prettyChars + 1;
      }
      appendPreview(state, "]");
      totalChars += 1;
      prettyChars += value.length === 0 ? 1 : depth * state.indentChars + 1;
      return {
        totalChars,
        prettyChars: state.indentChars === 0 ? totalChars : prettyChars,
      };
    }

    appendPreview(state, "{");
    let totalChars = 1;
    let prettyChars = 1;
    let writtenProperties = 0;
    for (const key of Object.keys(value)) {
      const normalized = normalizeJsonValue((value as Record<string, unknown>)[key], key, false);
      if (normalized === OMIT_FROM_JSON) continue;
      if (writtenProperties === 0) {
        prettyChars += 1; // first newline
      } else {
        appendPreview(state, ",");
        totalChars += 1;
        prettyChars += 1;
      }
      const keyChars = writeJsonString(state, key);
      appendPreview(state, ":");
      const child = writeNormalizedJson(normalized, depth + 1, state);
      totalChars += keyChars + 1 + child.totalChars;
      prettyChars +=
        (depth + 1) * state.indentChars +
        keyChars +
        2 + // ": "
        child.prettyChars +
        1; // newline
      writtenProperties += 1;
    }
    appendPreview(state, "}");
    totalChars += 1;
    prettyChars += writtenProperties === 0 ? 1 : depth * state.indentChars + 1;
    return {
      totalChars,
      prettyChars: state.indentChars === 0 ? totalChars : prettyChars,
    };
  } finally {
    state.seen.delete(value);
  }
}

/**
 * Measures JSON output and captures a bounded compact prefix without ever
 * materializing the full serialized string or a cloned object graph.
 */
export function summarizeJsonSerialization(
  value: unknown,
  previewChars = 512,
  indentChars = 2,
): JsonSerializationSummary | undefined {
  const normalized = normalizeJsonValue(value, "", false);
  if (normalized === OMIT_FROM_JSON) return undefined;
  const state: SerializationState = {
    preview: "",
    previewChars: Math.max(0, previewChars),
    indentChars: Math.min(10, Math.max(0, Math.trunc(indentChars))),
    seen: new Set(),
  };
  const metrics = writeNormalizedJson(normalized, 0, state);
  return { preview: state.preview, ...metrics };
}
