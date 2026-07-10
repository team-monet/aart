import { describe, expect, it } from "vitest";
import { redactRecord, redactRecordWithNames } from "./redact.js";

const SECRET = "sk-live-9f8a7b6c5d4e3f2a1b0c";

describe("redactRecord — the RedactFn chokepoint (architecture §7.9, ADR-10)", () => {
  it("matches the frozen RedactFn 2-arg (record, resolvedSecretRefs) => record signature exactly", () => {
    expect(redactRecord.length).toBe(2);
  });

  it("redacts a secret value appearing directly in a step output", () => {
    const record = { stepId: "call_api", outputs: { token: SECRET } };
    const result = redactRecord(record, new Set([SECRET])) as typeof record;
    expect(result.outputs.token).not.toContain(SECRET);
    expect(result.outputs.token).toMatch(/^\[REDACTED:secret-1\]$/);
  });

  it("redacts a secret value EMBEDDED inside a longer LLM-echoed output string, not just a full-string match", () => {
    const record = {
      stepId: "llm_call",
      outputs: {
        text: `Sure! I used the API key ${SECRET} to authenticate, and it worked.`,
      },
    };
    const result = redactRecord(record, new Set([SECRET])) as typeof record;
    expect(result.outputs.text).not.toContain(SECRET);
    expect(result.outputs.text).toBe("Sure! I used the API key [REDACTED:secret-1] to authenticate, and it worked.");
  });

  it("redacts a secret value in a nested, deeply-embedded field (not just top-level)", () => {
    const record = {
      stepId: "deep",
      outputs: {
        a: { b: { c: { d: { secret: SECRET, note: `token=${SECRET}` } } } },
      },
    };
    const result = redactRecord(record, new Set([SECRET])) as typeof record;
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(result.outputs.a.b.c.d.secret).toBe("[REDACTED:secret-1]");
    expect(result.outputs.a.b.c.d.note).toBe("token=[REDACTED:secret-1]");
  });

  it("catches all three cases (direct output, LLM-echoed, deeply-nested) in a SINGLE record, proving this is real value-scan-and-replace over the whole tree, not a field-name allowlist", () => {
    const record = {
      outputs: { token: SECRET },
      llmCall: { rawResponse: `Here is your key: ${SECRET}` },
      nested: { a: { b: [{ c: SECRET }] } },
    };
    const result = redactRecord(record, new Set([SECRET])) as typeof record;
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(SECRET);
    expect(result.outputs.token).toBe("[REDACTED:secret-1]");
    expect(result.llmCall.rawResponse).toBe("Here is your key: [REDACTED:secret-1]");
    expect(result.nested.a.b[0]?.c).toBe("[REDACTED:secret-1]");
  });

  it("redacts the JSON-escaped form of a secret (e.g. embedded inside a JSON-stringified payload captured as an output)", () => {
    const secretWithQuote = 'sk-"weird"-key';
    const record = {
      // A raw HTTP response body captured verbatim as a step output — the
      // secret appears here in its JSON-STRING-ESCAPED form (quotes
      // backslash-escaped), not its literal form.
      outputs: { rawBody: JSON.stringify({ apiKey: secretWithQuote }) },
    };
    const result = redactRecord(record, new Set([secretWithQuote])) as typeof record;
    expect(result.outputs.rawBody).not.toContain(secretWithQuote);
    expect(result.outputs.rawBody).toContain("[REDACTED:secret-1]");
  });

  it("redacts the URL-encoded form of a secret (e.g. embedded in a query string)", () => {
    const secretWithSpecialChars = "sk live/token+value";
    const record = { outputs: { url: `https://api.example.com/x?key=${encodeURIComponent(secretWithSpecialChars)}` } };
    const result = redactRecord(record, new Set([secretWithSpecialChars])) as typeof record;
    expect(result.outputs.url).not.toContain(encodeURIComponent(secretWithSpecialChars));
    expect(result.outputs.url).toBe("https://api.example.com/x?key=[REDACTED:secret-1]");
  });

  it("redacts EVERY resolved secret in the set, each with a distinct positional marker, and gives the SAME secret the SAME marker wherever it repeats", () => {
    const secretA = "secret-value-aaaa";
    const secretB = "secret-value-bbbb";
    const record = { x: secretA, y: secretB, z: `${secretA} and ${secretA} again` };
    const result = redactRecord(record, new Set([secretA, secretB])) as typeof record;
    expect(result.x).toBe("[REDACTED:secret-1]");
    expect(result.y).toBe("[REDACTED:secret-2]");
    expect(result.z).toBe("[REDACTED:secret-1] and [REDACTED:secret-1] again");
  });

  it("never inspects or redacts based on KEY names — a field literally named 'secret' with a non-secret value passes through untouched", () => {
    const record = { secret: "not-actually-a-resolved-secret", token: "also-not-one" };
    const result = redactRecord(record, new Set([SECRET])) as typeof record;
    expect(result).toEqual(record);
  });

  it("is a no-op for an empty resolvedSecretRefs set", () => {
    const record = { outputs: { token: SECRET } };
    const result = redactRecord(record, new Set()) as typeof record;
    expect(result).toEqual(record);
  });

  it("ignores an empty-string secret ref rather than corrupting every string in the record", () => {
    const record = { a: "hello", b: "world" };
    const result = redactRecord(record, new Set([""])) as typeof record;
    expect(result).toEqual(record);
  });

  it("handles arrays, numbers, booleans, and null alongside strings", () => {
    const record = { list: [SECRET, 42, true, null], count: 3 };
    const result = redactRecord(record, new Set([SECRET])) as typeof record;
    expect(result.list[0]).toBe("[REDACTED:secret-1]");
    expect(result.list[1]).toBe(42);
    expect(result.list[2]).toBe(true);
    expect(result.list[3]).toBe(null);
    expect(result.count).toBe(3);
  });

  it("does not mutate the original record (returns a new tree)", () => {
    const record = { outputs: { token: SECRET } };
    const original = JSON.parse(JSON.stringify(record));
    redactRecord(record, new Set([SECRET]));
    expect(record).toEqual(original);
  });
});

describe("redactRecordWithNames — real [REDACTED:<NAME>] markers for callers with name info", () => {
  it("uses the symbolic secret NAME in the marker, matching architecture §7.9's illustrated format exactly", () => {
    const record = { outputs: { token: SECRET } };
    const result = redactRecordWithNames(record, new Map([[SECRET, "GITHUB_TOKEN"]])) as typeof record;
    expect(result.outputs.token).toBe("[REDACTED:GITHUB_TOKEN]");
  });

  it("still catches nested/embedded occurrences, same as the positional variant", () => {
    const record = { a: { b: `token is ${SECRET} embedded` } };
    const result = redactRecordWithNames(record, new Map([[SECRET, "API_KEY"]])) as typeof record;
    expect(result.a.b).toBe("token is [REDACTED:API_KEY] embedded");
  });
});
