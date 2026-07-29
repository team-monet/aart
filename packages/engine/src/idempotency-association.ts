import { createHash } from "node:crypto";

/**
 * Stable, non-secret cache-to-trace association. The mutable audit key may
 * later be redacted; this one-way fingerprint remains comparable without
 * retaining the authored key.
 */
export function idempotencyAssociationFingerprint(
  ledgerKey: string,
): string {
  return createHash("sha256").update(ledgerKey).digest("hex");
}
