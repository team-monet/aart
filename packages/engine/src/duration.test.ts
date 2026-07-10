import { describe, expect, it } from "vitest";
import { parseDurationMs } from "./duration.js";

describe("parseDurationMs", () => {
  it.each([
    ["30s", 30_000],
    ["5m", 300_000],
    ["7d", 604_800_000],
    ["1h", 3_600_000],
    ["500ms", 500],
    ["0s", 0],
  ])("parses %s to %dms", (input, expected) => {
    expect(parseDurationMs(input)).toBe(expected);
  });

  it("tolerates whitespace between amount and unit", () => {
    expect(parseDurationMs("30 s")).toBe(30_000);
  });

  it("throws on a malformed duration string", () => {
    expect(() => parseDurationMs("soon")).toThrow(/not a valid duration/i);
  });

  it("throws on an unrecognized unit", () => {
    expect(() => parseDurationMs("30w")).toThrow();
  });

  it("throws on a negative amount", () => {
    expect(() => parseDurationMs("-5s")).toThrow();
  });
});
