import { describe, expect, it } from "vitest";
import { summarizeJsonSerialization } from "./json-serialization.js";

describe("summarizeJsonSerialization", () => {
  it("matches native compact and pretty JSON sizes while bounding the preview", () => {
    const value = {
      text: 'quote " slash \\ newline\n',
      nested: [1, true, null, { emoji: "😀" }],
    };
    const summary = summarizeJsonSerialization(value, 24, 2);

    expect(summary).toBeDefined();
    expect(summary?.preview).toBe(JSON.stringify(value).slice(0, 24));
    expect(summary?.totalChars).toBe(JSON.stringify(value).length);
    expect(summary?.prettyChars).toBe(JSON.stringify(value, null, 2).length);
  });

  it("handles deeply nested values without cloning or materializing their full JSON", () => {
    let nested: unknown = "leaf";
    for (let depth = 0; depth < 1_000; depth++) nested = [nested];

    const summary = summarizeJsonSerialization({ nested }, 32, 2);

    expect(summary?.preview.length).toBe(32);
    expect(summary?.totalChars).toBeLessThan(4_096);
    expect(summary?.prettyChars).toBeGreaterThan(1_000_000);
  });
});
