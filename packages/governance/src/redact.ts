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
  return [...forms].map((form) => ({ pattern: new RegExp(escapeForRegex(form), "g"), marker }));
}

function applyReplacements(value: unknown, replacements: readonly Replacement[]): unknown {
  if (replacements.length === 0) return value;
  if (typeof value === "string") {
    let result = value;
    for (const { pattern, marker } of replacements) {
      result = result.replace(pattern, marker);
    }
    return result;
  }
  if (Array.isArray(value)) {
    return value.map((item) => applyReplacements(item, replacements));
  }
  if (value !== null && typeof value === "object") {
    // A record persisted through this chokepoint (StepTrace/RunRecord/wait
    // checkpoints, MCP tool returns, log lines — architecture §7.9's
    // diagram) is always JSON-shaped data by the time it gets here, never a
    // live class instance — this branch is a defensive guard, not an
    // expected path, and never inspects KEY names, only recurses into
    // values (never redact based on field names — this session's own hard
    // rule, and ADR-10's own rejected-alternative rationale).
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = applyReplacements(v, replacements);
    }
    return out;
  }
  return value; // numbers, booleans, null, undefined pass through unchanged
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
  return applyReplacements(record, replacements);
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
  return applyReplacements(record, replacements);
}
