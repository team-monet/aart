// D1 "remotes + push" (AMENDMENTS.md A56).
import { describe, expect, it } from "vitest";
import { checkDeployToken, extractBearerToken } from "./deploy-token.js";

describe("checkDeployToken", () => {
  it("unset configured token: always false (disabled/fail-closed), never throws", () => {
    expect(checkDeployToken(undefined, "anything")).toBe(false);
    expect(checkDeployToken("", "anything")).toBe(false);
  });

  it("no provided token: false, never throws", () => {
    expect(checkDeployToken("real-token", undefined)).toBe(false);
    expect(checkDeployToken("real-token", "")).toBe(false);
  });

  it("correct token: true", () => {
    expect(checkDeployToken("real-token", "real-token")).toBe(true);
  });

  it("wrong token: false", () => {
    expect(checkDeployToken("real-token", "wrong-token")).toBe(false);
  });

  it("provided token of a DIFFERENT length than the configured one never throws (the timing-safe hash-first path)", () => {
    expect(() => checkDeployToken("short", "a-much-much-much-longer-provided-token-value")).not.toThrow();
    expect(checkDeployToken("short", "a-much-much-much-longer-provided-token-value")).toBe(false);
    expect(() => checkDeployToken("a-much-much-much-longer-configured-token-value", "short")).not.toThrow();
  });

  it("is case-sensitive and exact — a near-miss (trailing space, different case) does not match", () => {
    expect(checkDeployToken("Real-Token", "real-token")).toBe(false);
    expect(checkDeployToken("real-token", "real-token ")).toBe(false);
  });
});

describe("extractBearerToken", () => {
  it("extracts the token from a well-formed Authorization: Bearer header", () => {
    expect(extractBearerToken("Bearer abc123")).toBe("abc123");
  });

  it("is case-insensitive on the scheme name", () => {
    expect(extractBearerToken("bearer abc123")).toBe("abc123");
    expect(extractBearerToken("BEARER abc123")).toBe("abc123");
  });

  it("undefined for a missing header", () => {
    expect(extractBearerToken(undefined)).toBeUndefined();
  });

  it("undefined for a wrong scheme (e.g. Basic)", () => {
    expect(extractBearerToken("Basic dXNlcjpwYXNz")).toBeUndefined();
  });

  it("undefined for a Bearer header with no token", () => {
    expect(extractBearerToken("Bearer")).toBeUndefined();
    expect(extractBearerToken("Bearer ")).toBeUndefined();
  });
});
