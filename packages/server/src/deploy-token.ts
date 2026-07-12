// checkDeployToken — D1 "remotes + push" (AMENDMENTS.md A56) token gate for
// the deploy-surface mutation routes (POST /bundles/ingest, POST
// /bundles/plan, POST /environments — http/server.ts). A DIFFERENT
// mechanism from the per-binding webhook HMAC secret (triggers/hmac.ts):
// this is ONE shared bearer token gating "can this caller push/register
// deploy-surface state," not a per-trigger-binding signing secret over a
// request body — the three /webhooks/* routes keep their existing HMAC
// verification completely untouched; this token plays no role there.
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

/** Extracts the bearer token from an `Authorization: Bearer <token>` header value (RFC 6750) — `undefined` for a missing header, wrong scheme, or empty token; never a partial/garbage string a caller might mistake for a real token. */
export function extractBearerToken(authorizationHeader: string | undefined): string | undefined {
  if (!authorizationHeader) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader);
  const token = match?.[1]?.trim();
  return token ? token : undefined;
}
