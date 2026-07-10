// Webhook HMAC verification — architecture §6.1/§15: "must actually reject
// invalid signatures... not a stub."
import { describe, expect, it } from "vitest";
import { computeHmacSignature, verifyHmacSignature } from "./hmac.js";

describe("HMAC verification (architecture §6.1/§15)", () => {
  const secret = "s3cr3t-webhook-key";
  const body = new TextEncoder().encode(JSON.stringify({ hello: "world" }));

  it("accepts a genuinely-valid signature", () => {
    const sig = computeHmacSignature(body, secret);
    expect(verifyHmacSignature(body, sig, secret)).toBe(true);
  });

  it("accepts a bare hex digest (no sha256= prefix)", () => {
    const sig = computeHmacSignature(body, secret).replace("sha256=", "");
    expect(verifyHmacSignature(body, sig, secret)).toBe(true);
  });

  it("REJECTS a tampered body", () => {
    const sig = computeHmacSignature(body, secret);
    const tampered = new TextEncoder().encode(JSON.stringify({ hello: "WORLD" }));
    expect(verifyHmacSignature(tampered, sig, secret)).toBe(false);
  });

  it("REJECTS a signature computed with the wrong secret", () => {
    const sig = computeHmacSignature(body, "wrong-secret");
    expect(verifyHmacSignature(body, sig, secret)).toBe(false);
  });

  it("REJECTS a missing signature header", () => {
    expect(verifyHmacSignature(body, undefined, secret)).toBe(false);
  });

  it("REJECTS an empty secret (never treats 'no secret configured' as 'skip verification')", () => {
    const sig = computeHmacSignature(body, "");
    expect(verifyHmacSignature(body, sig, "")).toBe(false);
  });

  it("REJECTS a garbage (non-hex) signature without throwing", () => {
    expect(verifyHmacSignature(body, "not-valid-hex!!", secret)).toBe(false);
  });

  it("REJECTS a signature of the wrong length rather than throwing on timingSafeEqual's own length check", () => {
    expect(verifyHmacSignature(body, "ab", secret)).toBe(false);
  });
});
