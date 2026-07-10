import { describe, expect, it } from "vitest";
import { applyRedaction, identityRedact } from "./redact.js";

describe("identityRedact", () => {
  it("passes a record through unchanged", () => {
    const record = { secret: "sk-live-abc123" };
    expect(identityRedact(record, new Set(["sk-live-abc123"]))).toBe(record);
  });
});

describe("applyRedaction", () => {
  it("calls the supplied RedactFn and narrows the result back to T", () => {
    const record = { value: "sk-live-abc123" };
    const scrubbed = applyRedaction(record, (r) => ({ ...(r as typeof record), value: "[REDACTED]" }), new Set(["sk-live-abc123"]));
    expect(scrubbed).toEqual({ value: "[REDACTED]" });
  });

  it("defaults resolvedSecretRefs to an empty set when omitted", () => {
    let capturedRefs: ReadonlySet<string> | undefined;
    applyRedaction({ x: 1 }, (record, refs) => {
      capturedRefs = refs;
      return record;
    });
    expect(capturedRefs).toBeInstanceOf(Set);
    expect(capturedRefs?.size).toBe(0);
  });
});
