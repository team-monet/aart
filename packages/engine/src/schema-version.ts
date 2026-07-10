// Engine-code schema-version tag (architecture §4.7) — distinct from
// `schema-version.json`'s whole-store migration watermark (§5.5), which
// tracks the *store's* schema, not an individual record's shape. Every
// `WaitCondition`/`RunRecord` this engine persists carries `schemaVersion`
// (the field itself is S0-frozen — see AMENDMENTS.md A8); this module is
// where THIS engine build's own compatible-version range lives, and where a
// resuming engine checks a loaded record's tag against it before trusting
// the record's shape.
import { AartError } from "@aart/types";

/**
 * This build's current schema version. Bump when a change to this engine's
 * on-disk `WaitCondition`/`RunRecord` *interpretation* would make an
 * older-tagged record unsafe to resume naively (not on every unrelated code
 * change) — the same discipline a migration-version bump follows.
 */
export const CURRENT_ENGINE_SCHEMA_VERSION = 1;

/**
 * The range of `schemaVersion` tags this engine build considers safe to
 * resume. `[DECISION]` v1 ships a single compatible version (no released
 * schema migrations yet to be backward-compatible with) — this is the seam
 * a future version-skew-tolerant release would widen, not a hardcoded "must
 * equal current" check that would need rewriting later.
 */
export function isSchemaVersionCompatible(recordVersion: number, engineVersion: number = CURRENT_ENGINE_SCHEMA_VERSION): boolean {
  return recordVersion === engineVersion;
}

/**
 * `AartError` is abstract (architecture §8) and this taxonomy is S0-frozen
 * at exactly 10 subclasses (types/src/errors.ts) — schema-version-mismatch
 * doesn't fit any of the 10 existing ones semantically (it isn't a
 * capability denial, a timeout, an HTTP error, an iteration-limit breach, a
 * correlation ambiguity, a secret-resolution failure, a pack-hash mismatch,
 * or a concurrency rejection), and fabricating an 11th subclass without an
 * amendment isn't warranted for what is, functionally, a loud-refusal-to-
 * proceed condition — `CorrelationError` already exists for "the persisted
 * state doesn't mean what I expected," which a version-tag mismatch is a
 * specific instance of (a resuming engine that doesn't recognize a
 * persisted record's shape is, precisely, unable to correlate its own
 * expectations against what's on disk). Reused here with a distinguishing
 * `detail.kind`, exactly the pattern `IterationLimitExceededError` already
 * uses to cover two distinct trigger conditions (architecture §4.2) under
 * one error class.
 */
export class SchemaVersionMismatchError extends AartError {
  readonly errorClass = "CorrelationError" as const;
}

/** Throws `SchemaVersionMismatchError` (not silent misinterpretation) if `recordVersion` isn't in this engine's compatible range — architecture §4.7: "a version it doesn't recognize as compatible fails loudly... rather than silently misinterpreting a shape it doesn't actually understand." Call at every resume entry point, on the loaded `RunRecord.schemaVersion` and the loaded `WaitCondition.schemaVersion`, before touching either record's contents. */
export function assertSchemaVersionCompatible(
  recordVersion: number,
  context: { runId: string; stepId?: string; recordKind: "RunRecord" | "WaitCondition" },
  engineVersion: number = CURRENT_ENGINE_SCHEMA_VERSION,
): void {
  if (!isSchemaVersionCompatible(recordVersion, engineVersion)) {
    throw new SchemaVersionMismatchError({
      message: `${context.recordKind} for run ${context.runId}${context.stepId ? `/step ${context.stepId}` : ""} carries schemaVersion ${recordVersion}, which this engine build (schemaVersion ${engineVersion}) does not recognize as compatible — refusing to resume rather than risk silently misinterpreting a stale record shape (architecture §4.7).`,
      detail: { kind: "schemaVersionMismatch", recordKind: context.recordKind, recordVersion, engineVersion, runId: context.runId, stepId: context.stepId },
    });
  }
}
