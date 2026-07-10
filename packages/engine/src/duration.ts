// Duration-string parsing — `step.timeout` (spec §14.1), `WaitCondition.timeout`
// (spec §13.3, e.g. `"7d"` in the §20.2 wait_for_signature example). Neither
// spec nor architecture gives an exact grammar for these strings beyond the
// examples used throughout (`"7d"`, and elsewhere plain seconds/minutes) —
// this module picks the smallest sensible grammar that covers every example
// in both source documents: an integer plus one of ms/s/m/h/d.

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

const DURATION_PATTERN = /^(\d+)\s*(ms|s|m|h|d)$/;

/**
 * Parses a duration string (`"30s"`, `"5m"`, `"7d"`, ...) into milliseconds.
 * Throws a plain `Error` (not an `AartError` subclass — this is a
 * malformed-input condition governance's validation engine (spec §18.1,
 * S4's scope) is expected to catch before a workflow is ever approved to
 * run; by the time the engine is executing a step, a malformed duration
 * string reaching here is a validation gap upstream, not a runtime failure
 * mode this package's own error taxonomy needs to model).
 */
export function parseDurationMs(duration: string): number {
  const match = DURATION_PATTERN.exec(duration.trim());
  if (!match) {
    throw new Error(`Not a valid duration string: ${JSON.stringify(duration)} — expected an integer followed by one of ms|s|m|h|d (e.g. "30s", "7d").`);
  }
  const [, amount, unit] = match;
  return Number(amount) * UNIT_MS[unit!]!;
}
