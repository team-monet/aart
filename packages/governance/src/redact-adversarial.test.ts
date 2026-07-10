// ADVERSARIAL redaction pass (S9 Phase 3 security review — the explicit
// re-verification AMENDMENTS.md A27 recommends: "re-verify this exact
// mechanism adversarially, not just via this regression test, given its
// severity"). This file probes the REAL `redactRecord` value-scan-and-replace
// algorithm (@aart/governance's only real RedactFn implementation) for ways a
// resolved secret VALUE could still survive into a persisted record.
//
// Test-design note: this suite must keep `pnpm run test` GREEN, so every case
// asserts redactRecord's ACTUAL current behavior. Cases that document a
// genuine GAP or inherent LIMITATION are named "[GAP: Fn]" / "[LIMIT]" and
// assert that the secret survives — a green assertion here is EVIDENCE of the
// gap, cross-referenced to the security-pass report's finding of the same id.
// Cases named "[SAFE]" assert the secret is correctly scrubbed.
import { describe, expect, it } from "vitest";
import { redactRecord } from "./redact.js";

const SECRET = "sk-live-9f8a7b6c5d4e3f2a1b0c";

describe("redactRecord adversarial — confirmed-SAFE behaviors under pressure", () => {
  it("[SAFE] scrubs a secret that appears simultaneously as a value, inside a template string, in an array element, and deeply nested", () => {
    const record = {
      direct: SECRET,
      inString: `bearer ${SECRET} end`,
      arr: ["a", SECRET, { deep: [{ deeper: SECRET }] }],
      nested: { a: { b: { c: SECRET } } },
    };
    const result = redactRecord(record, new Set([SECRET]));
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("[SAFE] a secret full of regex metacharacters is redacted literally (escapeForRegex holds; no ReDoS, no accidental over-match)", () => {
    const regexSecret = "a.*+?^${}()|[]\\b-secret";
    const record = { outputs: { token: `x${regexSecret}y`, unrelated: "aXXXXXXb" } };
    const result = redactRecord(record, new Set([regexSecret])) as typeof record;
    expect(result.outputs.token).toBe("x[REDACTED:secret-1]y");
    // Proves the pattern was treated as a LITERAL, not a live regex: a string
    // that a live `a.*b` regex would greedily match is left untouched.
    expect(result.outputs.unrelated).toBe("aXXXXXXb");
  });

  it("[SAFE] a secret containing a double-quote and backslash is caught in BOTH its literal and its JSON-escaped form", () => {
    const weird = 'sk-"a\\b"-key';
    const record = {
      literal: weird,
      jsonEmbedded: JSON.stringify({ apiKey: weird }), // secret appears backslash-escaped here
    };
    const result = redactRecord(record, new Set([weird])) as typeof record;
    expect(result.literal).toBe("[REDACTED:secret-1]");
    expect(result.jsonEmbedded).not.toContain('sk-\\"a'); // the JSON-escaped form is gone too
    expect(JSON.stringify(result)).not.toContain(weird);
  });

  it("[SAFE] two overlapping secrets where the LONGER is resolved (inserted) first — both fully scrubbed, no fragment", () => {
    const long = "sk-live-ABCDEF-GHIJKL";
    const short = "ABCDEF-GHIJKL"; // a substring of `long`
    const record = { a: long, b: short, c: `use ${long} then ${short}` };
    // Insertion order: long first.
    const result = redactRecord(record, new Set([long, short])) as typeof record;
    expect(JSON.stringify(result)).not.toContain("ABCDEF"); // neither fragment survives
    expect(result.a).toBe("[REDACTED:secret-1]");
  });

  it("[SAFE] a secret repeated many times in one string is fully scrubbed at every occurrence (global flag)", () => {
    const record = { blob: Array(50).fill(SECRET).join(" | ") };
    const result = redactRecord(record, new Set([SECRET])) as typeof record;
    expect(result.blob).not.toContain(SECRET);
    expect(result.blob.split("[REDACTED:secret-1]")).toHaveLength(51);
  });
});

describe("redactRecord adversarial — GENUINE GAPS (secret survives; flagged for triage)", () => {
  // ---- FINDING F1: a resolved secret value used as an OBJECT KEY is NOT
  // redacted. `applyReplacements` recurses into object VALUES only
  // (redact.ts:63 `out[key] = applyReplacements(v, ...)`), copying keys
  // verbatim. Realistic trigger: a group-by / index-by aggregation keyed on a
  // field whose value is a resolved secret.
  it("[GAP: F1] a secret value appearing as an OBJECT KEY survives redaction (keys are never scanned)", () => {
    const record = { groupedByToken: { [SECRET]: ["row1", "row2"] } };
    const result = redactRecord(record, new Set([SECRET])) as typeof record;
    // The secret is STILL present as a key — this is the leak.
    expect(Object.keys(result.groupedByToken)).toContain(SECRET);
    expect(JSON.stringify(result)).toContain(SECRET);
  });

  it("[GAP: F1] the SAME secret is scrubbed from a value but survives as a key in the same record (asymmetry proof)", () => {
    const record = { asValue: SECRET, asKey: { [SECRET]: 1 } };
    const result = redactRecord(record, new Set([SECRET])) as typeof record;
    expect(result.asValue).toBe("[REDACTED:secret-1]"); // value: scrubbed
    expect(Object.keys(result.asKey)).toContain(SECRET); // key: leaked
  });

  // ---- FINDING F2: redaction is string-only. A resolved secret whose value
  // coincides with a NUMBER in the record is not scrubbed — `applyReplacements`
  // passes numbers/booleans/null through untouched, and the regex only runs on
  // strings. (Compounded at the engine layer: createTrackingSecretResolver
  // only adds `typeof value === "string"` values to the set, and SecretResolver
  // is typed `=> unknown`, so a non-string secret never even enters the set.)
  it("[GAP: F2] a numeric secret value is not redacted when it appears as a NUMBER (only its string form would be)", () => {
    const numericSecret = "782341"; // e.g. a resolved OTP/PIN secret, tracked as a string
    const record = { asNumber: 782341, asString: "782341" };
    const result = redactRecord(record, new Set([numericSecret])) as typeof record;
    expect(result.asString).toBe("[REDACTED:secret-1]"); // string form: scrubbed
    expect(result.asNumber).toBe(782341); // number form: leaked (unchanged)
  });

  // ---- FINDING F4: overlapping secrets are applied in insertion order with no
  // longest-match-first sort, so if a SHORTER secret that is a substring of a
  // LONGER secret is resolved first, redacting the short one first prevents the
  // long one's pattern from matching, leaving the long secret's non-overlapping
  // fragment in place.
  it("[GAP: F4] overlapping secrets, SHORTER resolved first — the LONGER secret's non-overlapping fragment leaks", () => {
    const long = "prefix-SHAREDBODY";
    const short = "SHAREDBODY"; // substring of `long`
    const record = { blob: `value=${long}` };
    // Insertion order: short first (it was resolved earlier in the run).
    const result = redactRecord(record, new Set([short, long])) as typeof record;
    // The "prefix-" fragment of the longer secret survives, revealing part of it.
    expect(result.blob).toBe("value=prefix-[REDACTED:secret-1]");
    expect(result.blob).toContain("prefix-"); // <-- the leaked fragment
    expect(result.blob).not.toContain(long); // the FULL long value is gone, but its prefix is not
  });

  it("[GAP: F4] control: the very same pair with the LONGER resolved first has NO fragment leak (proves it is purely order-dependent)", () => {
    const long = "prefix-SHAREDBODY";
    const short = "SHAREDBODY";
    const record = { blob: `value=${long}` };
    const result = redactRecord(record, new Set([long, short])) as typeof record;
    expect(result.blob).toBe("value=[REDACTED:secret-1]");
    expect(result.blob).not.toContain("prefix-");
  });
});

describe("redactRecord adversarial — INHERENT LIMITATIONS of value-scan redaction (document, not necessarily fix)", () => {
  it("[LIMIT] a base64-encoded form of a secret is NOT redacted (value-scan cannot catch derived/transformed representations)", () => {
    const raw = "super-secret-value";
    const b64 = Buffer.from(raw).toString("base64"); // c3VwZXItc2VjcmV0LXZhbHVl
    const record = { rawForm: raw, base64Form: b64, hexForm: Buffer.from(raw).toString("hex") };
    const result = redactRecord(record, new Set([raw])) as typeof record;
    expect(result.rawForm).toBe("[REDACTED:secret-1]"); // raw: scrubbed
    expect(result.base64Form).toBe(b64); // base64: leaked (not a form redact.ts builds)
    expect(result.hexForm).toBe(Buffer.from(raw).toString("hex")); // hex: leaked
  });

  it("[LIMIT] redaction is case-sensitive and exact-byte — a case-folded copy of a secret is not redacted", () => {
    const record = { exact: SECRET, upper: SECRET.toUpperCase() };
    const result = redactRecord(record, new Set([SECRET])) as typeof record;
    expect(result.exact).toBe("[REDACTED:secret-1]");
    expect(result.upper).toBe(SECRET.toUpperCase()); // a differently-cased copy survives
  });
});
