// Shared validation types — architecture §7.7, spec §18.
//
// Naming note: architecture §7.7 names its return shape `ValidationError`
// (`{ class, path, message, didYouMean?, correctedSnippet? }`). That name
// is already taken in this workspace by @aart/types' errors.ts — an
// AartError SUBCLASS (a throwable Error, used when a caller wants to
// signal an exceptional failure), a different thing from architecture
// §7.7's plain-data FINDING shape returned by the validation engine here.
// This module names its own type `ValidationFinding` to avoid shadowing
// the imported class, while keeping every field architecture §7.7
// specifies (`class`/`path`/`message`/`didYouMean`/`correctedSnippet`)
// plus one addition this session's own DoD requires: `severity`, so the
// effectful-capability-without-idempotencyKey WARNING (advisory, must
// never block validation) and every other class's blocking errors can
// share one result shape without conflating "wrong" with "worth a look."
export type ValidationClass = "schema" | "reference" | "capability" | "input-safety" | "deployment";

export interface ValidationFinding {
  readonly class: ValidationClass;
  readonly path: string;
  readonly message: string;
  readonly didYouMean?: string;
  readonly correctedSnippet?: string;
  readonly severity: "error" | "warning";
}

export interface ValidationResult {
  /** true iff no `severity: "error"` finding exists — warnings never block. */
  readonly valid: boolean;
  readonly findings: readonly ValidationFinding[];
}

export function isValid(findings: readonly ValidationFinding[]): boolean {
  return findings.every((f) => f.severity !== "error");
}
