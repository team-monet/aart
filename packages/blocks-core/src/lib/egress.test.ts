import { afterEach, describe, expect, it } from "vitest";
import { checkEgressAllowed, EgressDeniedError, getEgressPolicy, setEgressPolicy } from "./egress.js";

describe("checkEgressAllowed", () => {
  afterEach(() => {
    setEgressPolicy({});
  });

  it("allows any domain when no policy is configured (default)", () => {
    expect(() => checkEgressAllowed("https://anything.example.com/path")).not.toThrow();
  });

  it("allows a domain that matches an exact entry in the allowlist", () => {
    setEgressPolicy({ allowedDomains: ["api.github.com"] });
    expect(() => checkEgressAllowed("https://api.github.com/repos")).not.toThrow();
  });

  it("rejects a non-matching domain when an allowlist is configured", () => {
    setEgressPolicy({ allowedDomains: ["api.github.com"] });
    expect(() => checkEgressAllowed("https://evil.example.com/x")).toThrow(EgressDeniedError);
  });

  it("supports a *.suffix wildcard entry", () => {
    setEgressPolicy({ allowedDomains: ["*.internal.company.com"] });
    expect(() => checkEgressAllowed("https://service-a.internal.company.com/x")).not.toThrow();
    expect(() => checkEgressAllowed("https://internal.company.com/x")).toThrow(EgressDeniedError);
    expect(() => checkEgressAllowed("https://internal.company.com.evil.net/x")).toThrow(EgressDeniedError);
  });

  it("denies every domain when allowedDomains is an empty array", () => {
    setEgressPolicy({ allowedDomains: [] });
    expect(() => checkEgressAllowed("https://api.github.com/x")).toThrow(EgressDeniedError);
  });

  it("accepts an explicit per-call policy override instead of the module-level one", () => {
    setEgressPolicy({ allowedDomains: ["api.github.com"] });
    expect(() => checkEgressAllowed("https://hooks.slack.com/x", { allowedDomains: ["hooks.slack.com"] })).not.toThrow();
  });

  it("getEgressPolicy reflects the currently configured policy", () => {
    setEgressPolicy({ allowedDomains: ["a.com"] });
    expect(getEgressPolicy()).toEqual({ allowedDomains: ["a.com"] });
  });

  it("accepts a URL instance as well as a string", () => {
    setEgressPolicy({ allowedDomains: ["api.github.com"] });
    expect(() => checkEgressAllowed(new URL("https://api.github.com/repos"))).not.toThrow();
  });
});
