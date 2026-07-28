// The single redaction chokepoint (architecture §7.9, ADR-10). Every
// persist/emit path in the system funnels through this ONE function —
// value-scan-and-replace, NEVER a field-name allowlist, because a secret
// value can leak into ANY field (a screenshot's rendered text, an LLM's
// echoed output, an HTTP response body captured as a step output).
//
// `redactRecord` implements the frozen 2-arg `RedactFn` type from
// @aart/types EXACTLY: `(record: unknown, resolvedSecretRefs:
// ReadonlySet<string>) => unknown`. S1 (engine) wires this in via
// constructor injection, never a direct `@aart/governance` import
// (architecture §4.6/§7.9) — see SEAMS.md for the published signature.
import type { RedactFn } from "@aart/types";

export interface Replacement {
  readonly pattern: RegExp;
  readonly marker: string;
  // F4 fix: the raw substring length this pattern matches (NOT
  // pattern.source.length — escapeForRegex can grow a literal's length,
  // e.g. "." -> "\." doubles it, which would sort by the wrong quantity).
  // redactRecord/redactRecordWithNames sort the full replacements array by
  // this, descending, before applyReplacements ever runs, so a longer
  // secret's pattern always gets first crack at a shared substring — see
  // that sort for the full rationale (root AMENDMENTS.md, S10 completion).
  readonly literalLength: number;
}

function escapeForRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * For one resolved secret VALUE, builds the set of literal substrings to
 * scan for: the verbatim value, its JSON-string-escaped form (catches a
 * secret embedded inside a JSON-stringified payload — e.g. a raw HTTP
 * response body captured as a step output), and its URL-percent-encoded
 * form (catches a secret embedded in a URL query string). This is what
 * this session's briefing calls out explicitly: "verbatim + JSON-escaped +
 * URL-encoded forms."
 */
function buildReplacementsForValue(literal: string, marker: string): Replacement[] {
  if (literal.length === 0) return []; // never build a replacement for an empty string — that would match (and corrupt) everything
  const forms = new Set<string>([literal]);
  const jsonForm = JSON.stringify(literal).slice(1, -1); // strip the surrounding quotes JSON.stringify adds, keep only the escaped inner content
  if (jsonForm !== literal) forms.add(jsonForm);
  const urlForm = encodeURIComponent(literal);
  if (urlForm !== literal) forms.add(urlForm);
  return [...forms].map((form) => ({ pattern: new RegExp(escapeForRegex(form), "g"), marker, literalLength: form.length }));
}

/** The core scan-and-replace over one string — shared by the plain-string branch, the F1 key-scan, and the F2 stringified-number/boolean branch below, so all three get identical matching behavior (including the F4 longest-first ordering, which is a property of the `replacements` array's own order, not of this loop). */
function applyStringReplacements(value: string, replacements: readonly Replacement[]): string {
  let result = value;
  for (const { pattern, marker } of replacements) {
    result = result.replace(pattern, marker);
  }
  return result;
}

function applyReplacements(value: unknown, replacements: readonly Replacement[]): unknown {
  if (replacements.length === 0) return value;
  if (typeof value === "string") {
    return applyStringReplacements(value, replacements);
  }
  // F2 fix: a resolved secret can coincide with a NUMBER or BOOLEAN field a
  // block's own output independently produced as that type (e.g. a block
  // that parses a numeric OTP/PIN and returns it as `{ code: 782341 }`,
  // not as a string) — the string-only branch above never even looked at
  // these before. Stringify, scan, and only actually change anything if a
  // pattern matched; if nothing matched, return the ORIGINAL value
  // unchanged (same type, same value) rather than gratuitously turning
  // every number/boolean field in every record into a string. When a
  // secret genuinely is a number this DOES change the field's type
  // (number -> the string marker) — there's no way to represent
  // "[REDACTED:...]" as a number, and leaking the secret is not the
  // alternative.
  if (typeof value === "number" || typeof value === "boolean") {
    const stringForm = String(value);
    const redacted = applyStringReplacements(stringForm, replacements);
    return redacted === stringForm ? value : redacted;
  }
  if (Array.isArray(value)) {
    return value.map((item) => applyReplacements(item, replacements));
  }
  if (value !== null && typeof value === "object") {
    // A record persisted through this chokepoint (StepTrace/RunRecord/wait
    // checkpoints, MCP tool returns, log lines — architecture §7.9's
    // diagram) is always JSON-shaped data by the time it gets here, never a
    // live class instance — this branch is a defensive guard, not an
    // expected path.
    //
    // F1 fix: KEYS are now scanned too, not just values (a resolved secret
    // used as a group-by/index-by key — e.g. `{ [secretToken]: [...] }` —
    // used to survive verbatim; `out[key] = ...` copied it unredacted).
    // This is still not a field-NAME allowlist (this session's own hard
    // rule, and ADR-10's own rejected-alternative rationale still holds —
    // nothing here inspects what a key IS, only whether its literal text
    // happens to contain a resolved secret VALUE, exactly the same
    // value-scan-and-replace test every string field gets). On the rare
    // chance two distinct original keys redact down to the identical
    // string, the later one simply wins the write, same as any other
    // plain-JS duplicate-key collision — a data-fidelity nicety, not a
    // security property (the secret not leaking is unaffected either way).
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      const redactedKey = applyStringReplacements(key, replacements);
      // `out["__proto__"] = value` invokes Object.prototype's legacy
      // setter instead of preserving JSON-shaped data. Define every key as
      // an own data property so redaction cannot drop a valid public output
      // or mutate the reconstructed object's prototype.
      Object.defineProperty(out, redactedKey, {
        value: applyReplacements(v, replacements),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return out;
  }
  return value; // null, undefined pass through unchanged (never meaningfully a "secret value" to protect)
}

/** F4 fix: sorts a fully-built replacements array by literal length, descending, so a longer secret's pattern always gets first crack at text before a SHORTER secret that happens to be a substring of it can consume part of the match and leave the longer secret's non-overlapping fragment exposed. Applies uniformly across every secret's every form (verbatim/JSON-escaped/URL-encoded) and both call sites that build a replacements array (redactRecord/redactRecordWithNames below) — and, because applyReplacements' key-scan (F1) and value-scan share the same replacements array, the ordering fix covers both automatically. */
function sortLongestFirst(replacements: Replacement[]): Replacement[] {
  return [...replacements].sort((a, b) => b.literalLength - a.literalLength);
}

/**
 * The frozen-signature entry point every consumer (S1 via constructor
 * injection, S2/S6/S8 directly) calls. `resolvedSecretRefs` is a flat
 * `ReadonlySet<string>` of resolved secret VALUES (per architecture §7.9:
 * "for every symbolic secret reference resolved during the run ...
 * replaces any occurrence of THAT LITERAL RESOLVED VALUE anywhere in the
 * record" — the set's members are used directly as search values, which is
 * only executable if they ARE the values, not just their symbolic names).
 *
 * Marker-format note (resolved gap in the frozen type's own expressiveness
 * — documented here and in SEAMS.md, NOT a deviation from the frozen
 * signature, which this function matches exactly): architecture's diagram
 * illustrates the marker as `[REDACTED:<NAME>]`, but a flat
 * `ReadonlySet<string>` of values alone carries no NAME to put there. This
 * implementation uses a stable, position-based marker
 * (`[REDACTED:secret-N]`, N = 1-based insertion order of the set) so
 * repeated occurrences of the SAME secret value get the SAME marker within
 * one call (useful for a report reader to see "the same secret appeared in
 * 2 places" without learning what it is), while never fabricating a name it
 * wasn't given. Callers who DO have name information available (this
 * package's own future callers, or a richer composition-root wiring) can
 * use `redactRecordWithNames` below for real `[REDACTED:<NAME>]` markers.
 */
export const redactRecord: RedactFn = (record, resolvedSecretRefs) => {
  const replacements: Replacement[] = [];
  let index = 0;
  for (const value of resolvedSecretRefs) {
    index += 1;
    replacements.push(...buildReplacementsForValue(value, `[REDACTED:secret-${index}]`));
  }
  // F4 fix: marker numbers above are still assigned by insertion order
  // (unaffected — a report reader still sees a stable per-secret marker);
  // only the ORDER replacements are tried against the text is length-sorted.
  return applyReplacements(record, sortLongestFirst(replacements));
};

/**
 * Same value-scan-and-replace core, for callers with a value -> symbolic
 * NAME mapping available (e.g. governance's own report/summary rendering,
 * or a richer future composition-root wiring) — produces the
 * architecture-diagram-illustrated `[REDACTED:<NAME>]` marker exactly, per
 * secret name, rather than a positional stand-in.
 */
export function redactRecordWithNames(record: unknown, resolvedSecretRefs: ReadonlyMap<string, string>): unknown {
  const replacements: Replacement[] = [];
  for (const [value, name] of resolvedSecretRefs) {
    replacements.push(...buildReplacementsForValue(value, `[REDACTED:${name}]`));
  }
  return applyReplacements(record, sortLongestFirst(replacements));
}
