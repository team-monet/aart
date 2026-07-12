// checkDeployToken — D1 "remotes + push" (AMENDMENTS.md A56) token gate,
// originally for the deploy-surface mutation routes (POST /bundles/ingest,
// POST /bundles/plan, POST /environments — http/server.ts) alone; scope
// widened to nearly every mutation route by D2a security hardening
// (AMENDMENTS.md A59, see requireDeployTokenIfConfigured's own doc comment,
// http/server.ts, for the full story) and given a rotation-tolerant sibling
// (checkAnyDeployToken, below) in the same session. A DIFFERENT mechanism
// from the per-binding webhook HMAC secret (triggers/hmac.ts): this is ONE
// shared bearer token (now: up to two, during a rotation window) gating
// "can this caller mutate this server's state," not a per-trigger-binding
// signing secret over a request body — the three /webhooks/* routes keep
// their existing HMAC verification completely untouched; this token plays
// no role there.
import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Constant-time comparison via `sha256(BOTH operands)` THEN
 * `timingSafeEqual` — never a raw `providedToken === configuredToken`
 * string comparison (a timing side-channel on the token's own bytes) and
 * never a raw `timingSafeEqual` on the UNHASHED tokens either
 * (`crypto.timingSafeEqual` throws on a LENGTH MISMATCH, so a caller would
 * need its own length pre-check first — itself an early-return timing
 * signal, exactly the shape `triggers/hmac.ts`'s `verifyHmacSignature`
 * accepts for an HMAC digest, deliberately NOT reused here). Hashing both
 * operands first makes them ALWAYS the same fixed length (32 bytes, sha256's
 * digest size) regardless of the input tokens' own lengths, so
 * `timingSafeEqual` can never throw and this function never needs a length
 * branch at all.
 *
 * `!configuredToken || !providedToken -> false, never throw` — this
 * codebase's established secret-handling discipline (`@aart/cli`'s
 * `secrets.ts`'s `createRealSecretResolver`: "Returns `undefined`... never
 * throws"; `triggers/hmac.ts`'s `verifyHmacSignature`: `if (!signatureHeader
 * || !secret) return false`): an unconfigured `AART_DEPLOY_TOKEN`, or a
 * request with no bearer token at all, must fail EVERY gated request the
 * same uniform way, never crash the process on the first one.
 */
export function checkDeployToken(configuredToken: string | undefined, providedToken: string | undefined): boolean {
  if (!configuredToken || !providedToken) return false;
  const expected = createHash("sha256").update(configuredToken).digest();
  const actual = createHash("sha256").update(providedToken).digest();
  return timingSafeEqual(expected, actual);
}

/**
 * D2a security hardening, token rotation (AMENDMENTS.md A59) — checks
 * `providedToken` against EVERY configured token (typically `[config.
 * deployToken, config.deployTokenNext]` — `server.ts`'s `requireDeployToken`/
 * `requireDeployTokenIfConfigured`, the two real callers), accepting a
 * match against ANY of them. Lets an operator roll a compromised/expiring
 * token without a hard cutover: publish a new value as `deployTokenNext`,
 * both old and new are accepted while callers migrate, then promote the new
 * value to `deployToken` proper and clear `deployTokenNext`.
 *
 * Deliberately a thin wrapper around `checkDeployToken` above (called once
 * per configured token), NOT a reimplementation of the comparison itself —
 * `checkDeployToken`'s own constant-time discipline (hash-then-
 * `timingSafeEqual`, never a raw compare) is untouched, exercised unchanged
 * for each candidate. `.some(...)` short-circuits on the first match, which
 * is fine here: unlike comparing a SINGLE secret against a guessed value
 * (where an attacker could in principle try to time how long comparison
 * against different WRONG candidates takes), every candidate here is this
 * operator's OWN currently-valid token — there is no secret-guessing
 * surface in which candidate order is checked, only whether the provided
 * value matches something valid at all.
 *
 * Entries that are themselves `undefined` (e.g. `deployTokenNext` unset,
 * the common case) are skipped — `checkDeployToken` already treats
 * `!configuredToken` as an automatic `false`, so this needs no separate
 * filter, but the caller's own array can freely include `undefined` slots
 * without special-casing them.
 */
export function checkAnyDeployToken(configuredTokens: ReadonlyArray<string | undefined>, providedToken: string | undefined): boolean {
  return configuredTokens.some((configured) => checkDeployToken(configured, providedToken));
}

/** Extracts the bearer token from an `Authorization: Bearer <token>` header value (RFC 6750) — `undefined` for a missing header, wrong scheme, or empty token; never a partial/garbage string a caller might mistake for a real token. */
export function extractBearerToken(authorizationHeader: string | undefined): string | undefined {
  if (!authorizationHeader) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader);
  const token = match?.[1]?.trim();
  return token ? token : undefined;
}
