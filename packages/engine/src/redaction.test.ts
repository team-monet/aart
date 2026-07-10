import { SecretResolutionError } from "@aart/types";
import { describe, expect, it } from "vitest";
import { applyRedaction, createTrackingSecretResolver, identityRedactFn, throwingSecretResolver } from "./redaction.js";

describe("identityRedactFn", () => {
  it("returns the record unchanged — this session's own tests wire this by default (architecture §7.9)", () => {
    const record = { a: 1, secret: "shh" };
    expect(identityRedactFn(record, new Set(["shh"]))).toBe(record);
  });
});

describe("throwingSecretResolver", () => {
  it("throws SecretResolutionError when no real resolver was configured", async () => {
    await expect(Promise.resolve().then(() => throwingSecretResolver("API_KEY"))).rejects.toThrow(SecretResolutionError);
  });
});

describe("createTrackingSecretResolver", () => {
  it("delegates to the wrapped resolver and returns its value", async () => {
    const resolvedRefs = new Set<string>();
    const tracking = createTrackingSecretResolver(async (name) => `value-of-${name}`, resolvedRefs);
    await expect(tracking("API_KEY")).resolves.toBe("value-of-API_KEY");
  });

  it("records every successfully-resolved name into the shared set (architecture §7.9's 'resolved secret refs' set)", async () => {
    const resolvedRefs = new Set<string>();
    const tracking = createTrackingSecretResolver(async (name) => `value-of-${name}`, resolvedRefs);
    await tracking("API_KEY");
    await tracking("DB_PASSWORD");
    expect(resolvedRefs).toEqual(new Set(["API_KEY", "DB_PASSWORD"]));
  });

  it("accumulates across multiple calls within the same set (segment-scoped, not per-call)", async () => {
    const resolvedRefs = new Set<string>();
    const tracking = createTrackingSecretResolver(async (name) => name, resolvedRefs);
    await tracking("A");
    await tracking("B");
    await tracking("A"); // re-resolved — Set naturally dedupes
    expect(resolvedRefs.size).toBe(2);
  });

  it("does NOT record a name if the wrapped resolver throws (only successful resolutions are tracked)", async () => {
    const resolvedRefs = new Set<string>();
    const tracking = createTrackingSecretResolver(async () => {
      throw new SecretResolutionError({ message: "no value" });
    }, resolvedRefs);
    await expect(tracking("MISSING")).rejects.toThrow(SecretResolutionError);
    expect(resolvedRefs.size).toBe(0);
  });
});

describe("applyRedaction", () => {
  it("calls the injected RedactFn with the record and the resolvedSecretRefs set, and returns its result", () => {
    const refs = new Set(["API_KEY"]);
    let seenArgs: unknown[] = [];
    const fakeRedact = (record: unknown, resolvedSecretRefs: ReadonlySet<string>) => {
      seenArgs = [record, resolvedSecretRefs];
      return { ...(record as object), redacted: true };
    };
    const result = applyRedaction(fakeRedact, { value: "raw" }, refs);
    expect(seenArgs[0]).toEqual({ value: "raw" });
    expect(seenArgs[1]).toBe(refs);
    expect(result).toEqual({ value: "raw", redacted: true });
  });

  it("a non-identity redactor's value-scan-and-replace behavior is visible through this call site (routing is real, not merely declared)", () => {
    const refs = new Set(["shh-secret-value"]);
    const scanAndReplaceRedact = (record: unknown, resolvedSecretRefs: ReadonlySet<string>): unknown => {
      let json = JSON.stringify(record);
      for (const ref of resolvedSecretRefs) {
        json = json.split(ref).join("[REDACTED]");
      }
      return JSON.parse(json);
    };
    const result = applyRedaction(scanAndReplaceRedact, { outputs: { echoed: "the value is shh-secret-value here" } }, refs);
    expect(JSON.stringify(result)).not.toContain("shh-secret-value");
    expect((result as { outputs: { echoed: string } }).outputs.echoed).toBe("the value is [REDACTED] here");
  });
});
