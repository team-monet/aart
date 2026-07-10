// Shared "fail the run outright" primitive for the 7 `assert.*` blocks
// (spec §15.3 boundary note: "assert.contains fails the run outright when
// the check doesn't hold" — an assertion enforces, unlike a sensor like
// `browser.text_visible` which only observes and returns a boolean).
//
// `BlockAssertionError` is deliberately NOT one of the 10 frozen
// `AartError` subclasses (packages/types/src/errors.ts) — none of them fit
// "a workflow-authored assertion didn't hold" semantically, and that
// hierarchy is closed/S0-owned (`ValidationError` is explicitly
// "Governance (S4) is the sole owner of raising these" per that file's own
// doc comment, so reusing it here would misattribute ownership). A plain,
// locally-scoped Error subclass is deliberate and sufficient: it's still a
// distinguishable `name`/`detail` for traces, without claiming a slot in a
// hierarchy this package doesn't own.
export class BlockAssertionError extends Error {
  constructor(
    public readonly blockId: string,
    message: string,
    public readonly detail?: Record<string, unknown>,
  ) {
    super(`${blockId}: assertion failed — ${message}`);
    this.name = "BlockAssertionError";
  }
}

export function assertOrThrow(blockId: string, condition: boolean, message: string, detail?: Record<string, unknown>): void {
  if (!condition) {
    throw new BlockAssertionError(blockId, message, detail);
  }
}
