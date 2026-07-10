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
//
// S10 completion update: F1/F2/F4 (object-key scanning, non-string record
// fields, longest-secret-first ordering) are RESOLVED — their cases below
// are relabeled "[SAFE: Fn]" and now assert the fixed behavior. Only the
// genuinely inherent [LIMIT] cases (base64/hex/case-folded derived forms —
// value-scan-and-replace structurally cannot catch a TRANSFORMED
// representation of a secret it never searched for) remain as documented,
// accepted limitations, not gaps. See root AMENDMENTS.md (S10 completion
// entry) for the fix detail and F5 (artifact-bytes bypass, a different
// chokepoint entirely — packages/mcp/src/redaction-adversarial.test.ts).
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

describe("redactRecord adversarial — RESOLVED FINDINGS (S10 completion; formerly GENUINE GAPS)", () => {
  // ---- FINDING F1 (RESOLVED): a resolved secret value used as an OBJECT KEY
  // is now redacted. `applyReplacements`'s object branch scans the KEY
  // through the same applyStringReplacements core every string field gets,
  // then recurses into the value as before. Realistic trigger: a group-by /
  // index-by aggregation keyed on a field whose value is a resolved secret.
  it("[SAFE: F1] a secret value appearing as an OBJECT KEY is now redacted", () => {
    const record = { groupedByToken: { [SECRET]: ["row1", "row2"] } };
    const result = redactRecord(record, new Set([SECRET])) as typeof record;
    expect(Object.keys(result.groupedByToken)).toEqual(["[REDACTED:secret-1]"]);
    expect(Object.keys(result.groupedByToken)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("[SAFE: F1] the SAME secret is scrubbed from BOTH a value and a key in the same record (symmetry — the prior asymmetry is gone)", () => {
    const record = { asValue: SECRET, asKey: { [SECRET]: 1 } };
    const result = redactRecord(record, new Set([SECRET])) as typeof record;
    expect(result.asValue).toBe("[REDACTED:secret-1]"); // value: scrubbed (unchanged from before)
    expect(Object.keys(result.asKey)).toEqual(["[REDACTED:secret-1]"]); // key: now ALSO scrubbed
  });

  // ---- FINDING F2 (RESOLVED): redaction is no longer string-only for
  // RECORD FIELDS — `applyReplacements` now has a number/boolean branch that
  // stringifies, scans, and only actually replaces (changing the field's
  // type to string) when a pattern genuinely matches. The compounding engine
  // -layer cause (createTrackingSecretResolver only ever tracked
  // `typeof value === "string"` resolved values, so a genuinely non-string
  // secret VALUE never entered the scan set at all) is fixed separately —
  // see packages/engine/src/redaction.test.ts's own coverage of
  // createTrackingSecretResolver's new stringify-canonical-forms behavior.
  it("[SAFE: F2] a numeric secret value IS now redacted when it appears as a NUMBER, not just in its string form", () => {
    const numericSecret = "782341"; // e.g. a resolved OTP/PIN secret, tracked as a string
    const record = { asNumber: 782341, asString: "782341" };
    const result = redactRecord(record, new Set([numericSecret])) as typeof record;
    expect(result.asString).toBe("[REDACTED:secret-1]"); // string form: scrubbed (unchanged from before)
    expect(result.asNumber).toBe("[REDACTED:secret-1]"); // number form: now ALSO scrubbed
    expect(typeof result.asNumber).toBe("string"); // documented side effect: a redacted number becomes a string — there's no numeric way to spell "[REDACTED:...]"
  });

  it("[SAFE: F2] a boolean field that happens to stringify to a resolved secret is also redacted (the fix generalizes beyond numbers)", () => {
    const record = { flag: true, other: false };
    const result = redactRecord(record, new Set(["true"])) as typeof record;
    expect(result.flag).toBe("[REDACTED:secret-1]");
    expect(result.other).toBe(false); // "false" was never in the resolved-secrets set — untouched, still a real boolean
  });

  // ---- FINDING F4 (RESOLVED): overlapping secrets are now applied
  // longest-literal-first (sortLongestFirst, applied to the full replacements
  // array before applyReplacements ever runs), regardless of the Set's
  // insertion order — so a shorter secret that happens to be a substring of a
  // longer one can no longer consume part of the longer match first.
  it("[SAFE: F4] overlapping secrets, SHORTER resolved first — the LONGER secret is now fully redacted, no fragment leak", () => {
    const long = "prefix-SHAREDBODY";
    const short = "SHAREDBODY"; // substring of `long`
    const record = { blob: `value=${long}` };
    // Insertion order: short first (it was resolved earlier in the run) —
    // exactly the ordering that used to leak the "prefix-" fragment.
    const result = redactRecord(record, new Set([short, long])) as typeof record;
    // long is redacted whole — its marker is secret-2 (insertion order still
    // drives WHICH marker number a secret gets; only the APPLICATION order
    // — which pattern is tried against the text first — is now
    // length-sorted, independent of insertion order).
    expect(result.blob).toBe("value=[REDACTED:secret-2]");
    expect(result.blob).not.toContain("prefix-"); // the fragment that used to leak
    expect(result.blob).not.toContain(long);
    expect(result.blob).not.toContain(short);
  });

  it("[SAFE: F4] the very same pair with the LONGER resolved first — same fragment-free outcome (proves the fix is order-INDEPENDENT, not just luckier)", () => {
    const long = "prefix-SHAREDBODY";
    const short = "SHAREDBODY";
    const record = { blob: `value=${long}` };
    const result = redactRecord(record, new Set([long, short])) as typeof record;
    expect(result.blob).toBe("value=[REDACTED:secret-1]"); // long inserted first here, so it gets marker secret-1
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
