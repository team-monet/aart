// redact.ts — the RedactFn injection seam (architecture §9.2/§7.9). "Every
// artifact/report/log/MCP-return persist-or-emit path in this subsystem
// must route through the single redactRecord(record, resolvedSecretRefs) →
// record chokepoint before reaching its destination... every evidence
// renderer/persist path MUST route through redactRecord" (architecture
// §9.2).
//
// @aart/evidence never imports @aart/governance directly — S4 (which owns
// the real redactRecord implementation) is a concurrent Wave-1 session, not
// a consumed interface of this package. The RedactFn TYPE is what's frozen
// in @aart/types (S0, architecture §2.1 governance.ts): `(record,
// resolvedSecretRefs) => record`. This module re-exports that type and
// supplies an identity fake — per this session's brief: "code against it
// with an identity fake; the orchestrator will relay S4's concrete export
// seam when published." This is the exact same constructor-injection
// pattern @aart/engine uses for RedactFn/CapabilityCheck (architecture
// §7.9): a frozen @aart/types interface, never a package import.
import type { RedactFn } from "@aart/types";

export type { RedactFn };

/**
 * An identity RedactFn — a no-op passthrough. Used as the default wherever
 * a caller hasn't wired in S4's real redactRecord yet. NEVER use this in
 * production: it does not redact anything, it exists purely so every
 * renderer/consumer in this package can be built and tested against the
 * real RedactFn *type* before S4's implementation exists.
 */
export const identityRedact: RedactFn = (record) => record;

/**
 * Applies `redact` to `run` and narrows the result back to `T`.
 * redactRecord's frozen signature is `(record: unknown, resolvedSecretRefs)
 * => unknown` (architecture §2.1/§7.9) — a real implementation is a
 * structural (shape-preserving) value-scan-and-replace across a record's
 * serialized form, never one that changes a record's shape, so narrowing
 * the return value back to `T` is safe by contract, not just convenience.
 *
 * `resolvedSecretRefs` defaults to an empty set: by the time a renderer
 * reads a *persisted* RunRecord, architecture §7.9 says the engine has
 * already redacted every StepTrace/RunRecord persist at write time (before
 * the record reached the store) — so there is usually nothing further to
 * scrub, and calling `redact` again is a defense-in-depth no-op. Callers
 * that DO have live secret-ref knowledge (e.g. reporting on an in-memory,
 * not-yet-persisted run) pass an explicit set.
 */
export function applyRedaction<T>(record: T, redact: RedactFn, resolvedSecretRefs: ReadonlySet<string> = new Set()): T {
  return redact(record, resolvedSecretRefs) as T;
}
