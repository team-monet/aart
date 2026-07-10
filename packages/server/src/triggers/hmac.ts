// Webhook HMAC verification — architecture §6.1/§15 threat model: "HMAC
// verification is mandatory... a delivery with a missing/invalid signature
// is rejected (401) before any workflow logic runs, not just logged." Named
// explicitly in this session's DoD as "real and tested — not a stub; this
// is a named threat-model mitigation."
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verifies `signatureHeader` against an HMAC-SHA256 of `rawBody` keyed by
 * `secret`. Accepts both a bare hex digest and the common
 * `sha256=<hexdigest>` prefixed form (GitHub's `X-Hub-Signature-256`
 * convention) so this one function covers the general `webhook` adapter and
 * the `github` adapter without a second implementation. Uses
 * `timingSafeEqual` — a naive `===`/string comparison on a MAC is a timing
 * side-channel (architecture §15's threat model is exactly the kind of
 * thing this level of care is for).
 */
export function verifyHmacSignature(rawBody: Uint8Array, signatureHeader: string | undefined, secret: string): boolean {
  if (!signatureHeader || !secret) return false;
  const provided = signatureHeader.startsWith("sha256=") ? signatureHeader.slice("sha256=".length) : signatureHeader;
  let providedBuf: Buffer;
  try {
    providedBuf = Buffer.from(provided, "hex");
  } catch {
    return false;
  }
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  if (providedBuf.length !== expected.length) return false;
  return timingSafeEqual(providedBuf, expected);
}

/** Computes a `sha256=<hex>` signature — used by adapter tests to construct a genuinely-valid signed delivery rather than a hand-typed magic string, and available for any caller (e.g. an outbound-fake in a fixture) that needs to sign a payload the same way a real sender would. */
export function computeHmacSignature(rawBody: Uint8Array, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}
