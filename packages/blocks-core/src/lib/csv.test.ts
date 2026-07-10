import { describe, expect, it } from "vitest";
import { parseCsv, stringifyCsv } from "./csv.js";

describe("parseCsv", () => {
  it("parses a simple header + rows into records", () => {
    expect(parseCsv("a,b\n1,2\n3,4")).toEqual([
      { a: "1", b: "2" },
      { a: "3", b: "4" },
    ]);
  });

  it("handles a quoted field containing an embedded comma", () => {
    expect(parseCsv('name,note\n"Doe, John",hi')).toEqual([{ name: "Doe, John", note: "hi" }]);
  });

  it("handles a quoted field containing an embedded newline", () => {
    expect(parseCsv('name,note\n"line1\nline2",x')).toEqual([{ name: "line1\nline2", note: "x" }]);
  });

  it("handles an escaped double-quote inside a quoted field", () => {
    expect(parseCsv('name\n"She said ""hi"""')).toEqual([{ name: 'She said "hi"' }]);
  });

  it("returns an empty array for empty input", () => {
    expect(parseCsv("")).toEqual([]);
    expect(parseCsv("   ")).toEqual([]);
  });

  it("handles CRLF line endings", () => {
    expect(parseCsv("a,b\r\n1,2\r\n")).toEqual([{ a: "1", b: "2" }]);
  });
});

describe("stringifyCsv", () => {
  it("stringifies rows with a header derived from the union of keys", () => {
    expect(stringifyCsv([{ a: 1, b: 2 }, { a: 3, b: 4 }])).toBe("a,b\r\n1,2\r\n3,4");
  });

  it("quotes a field containing a comma", () => {
    expect(stringifyCsv([{ name: "Doe, John" }])).toBe('name\r\n"Doe, John"');
  });

  it("escapes an embedded double-quote", () => {
    expect(stringifyCsv([{ name: 'She said "hi"' }])).toBe('name\r\n"She said ""hi"""');
  });

  it("returns an empty string for an empty row array", () => {
    expect(stringifyCsv([])).toBe("");
  });

  it("round-trips through parseCsv", () => {
    const original = [{ a: "x,y", b: 'z"w' }, { a: "plain", b: "line\nbreak" }];
    const csv = stringifyCsv(original);
    expect(parseCsv(csv)).toEqual([{ a: "x,y", b: 'z"w' }, { a: "plain", b: "line\nbreak" }]);
  });
});
