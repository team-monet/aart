// Redaction routing (architecture §4.2/§4.4 step 3/§4.6/§7.9, F2 chokepoint
// fix) — the engine routes EVERY StepTrace/RunRecord/wait-checkpoint persist
// through the constructor-injected `RedactFn`, threading in the claimed
// run's currently-resolved secret-refs set fresh on every call. This module
// is the one place that threading happens; every persist call site in this
// package goes through `applyRedaction`, never `config.redact` directly.
import type { SecretResolver } from "@aart/expr";
import type { RedactFn } from "@aart/types";
import { SecretResolutionError } from "@aart/types";

/**
 * Identity `RedactFn` — this session's own tests wire this by default
 * (architecture §7.9: "Engine unit tests may wire an identity `RedactFn`
 * when redaction isn't what's under test"). A real composition root wires
 * `@aart/governance`'s `redactRecord` instead.
 */
export const identityRedactFn: RedactFn = (record) => record;

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
 * Wraps a real `SecretResolver` so that every name it successfully resolves
 * is recorded into `resolvedRefs` (architecture §7.9: "a per-run 'resolved
 * secret refs' set populated at the moment @aart/expr's injected secret
 * resolver... returns a value"). `resolvedRefs` is scoped to one execution
 * segment (one `triggerRun`/`resumeWait` call, from wherever it starts to
 * wherever it stops at a wait/terminal status) — see `engine.ts` for where
 * a fresh `Set` is created per segment. Callers pass the SAME set to every
 * `applyRedaction` call made during that segment, so a secret resolved by
 * an earlier step is still redacted from a later step's persisted output
 * that happens to echo it back.
 */
export function createTrackingSecretResolver(resolver: SecretResolver, resolvedRefs: Set<string>): SecretResolver {
  return async (name: string) => {
    const value = await resolver(name);
    resolvedRefs.add(name);
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
