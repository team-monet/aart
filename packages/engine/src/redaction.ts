// Redaction routing (architecture §4.2/§4.4 step 3/§4.6/§7.9, F2 chokepoint
// fix) — the engine routes EVERY StepTrace/RunRecord/wait-checkpoint persist
// through the constructor-injected `RedactFn`, threading in the claimed
// run's currently-resolved secret-refs set fresh on every call. This module
// is the one place that threading happens; every persist call site in this
// package goes through `applyRedaction`, never `config.redact` directly.
import type { SecretResolver } from "@aart/expr";
import type { RedactFn, RunRecord, StepTrace } from "@aart/types";
import { SecretResolutionError } from "@aart/types";
import { jsonValuesEqual } from "./output-validation.js";

function escapeJsonPointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

export function changedJsonPointers(
  before: unknown,
  after: unknown,
  path = "",
): string[] {
  if (jsonValuesEqual(before, after)) return [];
  if (Array.isArray(before) && Array.isArray(after)) {
    if (before.length !== after.length) return [path || "*"];
    return before.flatMap((value, index) =>
      changedJsonPointers(value, after[index], `${path}/${index}`),
    );
  }
  if (
    before !== null &&
    after !== null &&
    typeof before === "object" &&
    typeof after === "object" &&
    !Array.isArray(before) &&
    !Array.isArray(after)
  ) {
    const beforeRecord = before as Record<string, unknown>;
    const afterRecord = after as Record<string, unknown>;
    const beforeKeys = Object.keys(beforeRecord);
    const afterKeys = Object.keys(afterRecord);
    if (
      beforeKeys.length !== afterKeys.length ||
      beforeKeys.some((key) => !Object.hasOwn(afterRecord, key))
    ) {
      return [path || "*"];
    }
    return beforeKeys.flatMap((key) =>
      changedJsonPointers(
        beforeRecord[key],
        afterRecord[key],
        `${path}/${escapeJsonPointerSegment(key)}`,
      ),
    );
  }
  return [path || "*"];
}

/**
 * Identity `RedactFn` — this session's own tests wire this by default
 * (architecture §7.9: "Engine unit tests may wire an identity `RedactFn`
 * when redaction isn't what's under test"). A real composition root wires
 * `@aart/governance`'s `redactRecord` instead.
 */
export const identityRedactFn: RedactFn = (record) => record;

/**
 * F5 fix (root AMENDMENTS.md, S10 completion): decides whether an artifact's
 * declared MIME type is text — the boundary `step-executor.ts`'s
 * `writeArtifact` uses to decide whether artifact BYTES pass through the
 * redaction chokepoint before persist. Deliberately narrow and explicit
 * (not "assume text unless proven binary") — a false positive here would
 * mean attempting to UTF-8-decode genuinely binary bytes (corrupting them)
 * before re-encoding, which is worse than doing nothing.
 */
export function isTextMime(mime: string): boolean {
  return mime.startsWith("text/") || mime === "application/json" || mime.endsWith("+json") || mime === "application/xml" || mime.endsWith("+xml");
}

/**
 * Default `resolveSecret` — throws if a workflow under test actually
 * references `secrets.*` without the engine being configured with a real
 * resolver (`EngineConfig.resolveSecret`). Kept as a loud failure rather
 * than a silent `undefined` so a missing-configuration bug in a test/
 * composition root surfaces immediately as a `SecretResolutionError`
 * (architecture §3.2/§31.2), the same error class a genuinely-missing
 * secret adapter value would raise.
 */
export const throwingSecretResolver: SecretResolver = (name) => {
  throw new SecretResolutionError({
    message: `secrets.${name} was referenced but no resolveSecret was configured on this Engine (EngineConfig.resolveSecret) — @aart/expr never resolves secrets.* itself (architecture §3.2/ADR-10).`,
    detail: { kind: "missingResolver", name },
  });
};

/**
 * F2 fix (root AMENDMENTS.md, S10 completion): stringifies the canonical
 * form of a resolved secret VALUE so it enters the tracked-refs set even
 * when the resolver's real return type isn't a string — `SecretResolver`
 * is typed `=> unknown` (a resolver adapter can legitimately return a raw
 * numeric OTP/PIN, a boolean flag, etc.), but before this fix only
 * `typeof value === "string"` was ever tracked, so a genuinely non-string
 * secret never entered the scan set at all — @aart/governance's
 * `redactRecord` had nothing to search for even where the SAME value later
 * appeared as a plain string elsewhere in a persisted record.
 *
 * Deliberately excludes `null`/`undefined` — neither is a "value" to
 * protect, and adding the literal string `"null"`/`"undefined"` to a
 * value-scan-and-replace set would redact every ordinary null/undefined-
 * shaped field in every run, a catastrophic over-redaction bug, not a fix.
 * Also excludes objects/arrays — a resolver returning a composite isn't
 * itself a flat scalar secret to string-match against; if a scalar leaf
 * inside it matters, the resolver should resolve to that scalar directly.
 */
function toCanonicalSecretString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  return undefined;
}

/**
 * Wraps a real `SecretResolver` so that every VALUE it successfully
 * resolves is recorded into `resolvedRefs` (architecture §7.9: "a per-run
 * 'resolved secret refs' set populated at the moment @aart/expr's injected
 * secret resolver... returns a value" — literally the resolved VALUE, not
 * the symbolic name/ref that was looked up). `resolvedRefs` is scoped to
 * one execution segment (one `triggerRun`/`resumeWait` call, from wherever
 * it starts to wherever it stops at a wait/terminal status) — see
 * `engine.ts` for where a fresh `Set` is created per segment. Callers pass
 * the SAME set to every `applyRedaction` call made during that segment, so
 * a secret resolved by an earlier step is still redacted from a later
 * step's persisted output that happens to echo it back.
 *
 * S9 integration fix (found via a genuine end-to-end test against the REAL
 * @aart/governance redactRecord, not this package's own mocks — see
 * root AMENDMENTS.md's dedicated entry on this): this previously tracked
 * `name` (the symbolic ref/argument passed to the resolver) instead of
 * `value` (what the resolver actually returned). `@aart/governance`'s real
 * `redactRecord` — the frozen `RedactFn` contract's only real
 * implementation — scans a persisted record for literal occurrences of
 * each SET MEMBER, documented explicitly as "resolved secret VALUES (not
 * names)". Tracking names instead of values meant `resolvedSecretRefs`
 * held strings like `"API_KEY"` instead of the actual secret value that
 * could appear in output data — `redactRecord` would then search for the
 * literal substring `"API_KEY"` (which essentially never coincidentally
 * appears in real data) instead of the real secret value, so redaction
 * silently redacted NOTHING in the real merged system despite every test
 * in this package's own (pre-integration) suite passing — those tests used
 * mock redactors that derived their own search value FROM the tracked name
 * (e.g. `` `secret-value-for-${ref}` ``), which happened to round-trip
 * correctly against a same-shaped mock resolver without ever exercising
 * the real value-based contract. This is exactly the class of bug a
 * hardening wave's genuine cross-package integration testing exists to
 * catch that per-package testing against fakes structurally cannot.
 */
export function createTrackingSecretResolver(resolver: SecretResolver, resolvedRefs: Set<string>): SecretResolver {
  return async (name: string) => {
    const value = await resolver(name);
    const canonical = toCanonicalSecretString(value);
    if (canonical !== undefined) resolvedRefs.add(canonical);
    return value;
  };
}

/**
 * The one call site every persist/emit path in this package routes through
 * (architecture §7.9's diagram, engine row). Never call `config.redact`
 * directly from elsewhere in this package — route through this function so
 * the "redaction happens between block-produced-raw-output and
 * trace-entry-persisted, not only at report-render time" discipline
 * (architecture micro-decision #29) is enforced structurally, in one place.
 */
export function applyRedaction<T>(redact: RedactFn, record: T, resolvedSecretRefs: ReadonlySet<string>): T {
  return redact(record, resolvedSecretRefs) as T;
}

/**
 * Redacts a RunRecord while keeping its active concurrency lock readable by
 * every intake version sharing the store. The authored key is operational
 * coordination state while a run is pending/running/waiting; changing it
 * mid-run can admit overlapping execution or strand a queued run. Terminal
 * records no longer participate in matching and remain fully redacted.
 */
export function applyRunRedaction(redact: RedactFn, run: RunRecord, resolvedSecretRefs: ReadonlySet<string>): RunRecord {
  const { trace: _trace, ...runWithoutTrace } = run;
  const redactedPayload = applyRedaction(
    redact,
    runWithoutTrace,
    resolvedSecretRefs,
  );
  const redactedTrace = run.trace.map((trace): StepTrace => {
    const redactedInputs = applyRedaction(
      redact,
      trace.inputs,
      resolvedSecretRefs,
    );
    const redactedOutputs =
      trace.outputs === undefined
        ? undefined
        : applyRedaction(redact, trace.outputs, resolvedSecretRefs);
    const discoveredPaths =
      trace.outputs === undefined || redactedOutputs === undefined
        ? []
        : changedJsonPointers(trace.outputs, redactedOutputs);
    const existingPaths =
      trace.secretTaintedPaths ??
      (trace.secretTainted === true ? ["*"] : []);
    const secretTaintedPaths = [
      ...new Set([...existingPaths, ...discoveredPaths]),
    ];
    return {
      ...trace,
      inputs: redactedInputs,
      ...(redactedOutputs !== undefined ? { outputs: redactedOutputs } : {}),
      ...(trace.error !== undefined
        ? {
            error: applyRedaction(
              redact,
              trace.error,
              resolvedSecretRefs,
            ),
          }
        : {}),
      ...(trace.artifacts !== undefined
        ? {
            artifacts: applyRedaction(
              redact,
              trace.artifacts,
              resolvedSecretRefs,
            ),
          }
        : {}),
      ...(trace.llmCall !== undefined
        ? {
            llmCall: applyRedaction(
              redact,
              trace.llmCall,
              resolvedSecretRefs,
            ),
          }
        : {}),
      ...(trace.externalCalls !== undefined
        ? {
            externalCalls: applyRedaction(
              redact,
              trace.externalCalls,
              resolvedSecretRefs,
            ),
          }
        : {}),
      ...(secretTaintedPaths.length > 0
        ? { secretTainted: true, secretTaintedPaths }
        : {}),
    };
  });
  const redacted: RunRecord = {
    ...redactedPayload,
    trace: redactedTrace,
  };
  const concurrencyKey = run.params?.concurrencyKey;
  if (
    typeof concurrencyKey !== "string" ||
    (run.status !== "pending" && run.status !== "running" && run.status !== "waiting")
  ) {
    return redacted;
  }

  return {
    ...redacted,
    params: {
      ...redacted.params,
      concurrencyKey,
      ...(run.params?.concurrencyKeyFormat !== undefined
        ? { concurrencyKeyFormat: run.params.concurrencyKeyFormat }
        : {}),
    },
  };
}
