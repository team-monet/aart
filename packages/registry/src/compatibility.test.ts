import { describe, expect, it } from "vitest";
import { assertPackCompatibility, PackCompatibilityError } from "./compatibility.js";

describe("assertPackCompatibility", () => {
  const runtime = { aart: "0.10.0", node: "22.14.0" };

  it("accepts compatible AART and Node.js ranges", () => {
    expect(() =>
      assertPackCompatibility(
        { aart: ">=0.10.0 <0.11.0", node: ">=22 <23" },
        runtime,
      ),
    ).not.toThrow();
  });

  it("rejects a Pack that requires a newer AART release", () => {
    expect(() => assertPackCompatibility({ aart: ">=0.12.0" }, runtime)).toThrow(
      /requires AART >=0\.12\.0.*runtime is 0\.10\.0/i,
    );
  });

  it("rejects a Pack that requires a newer Node.js release", () => {
    expect(() => assertPackCompatibility({ node: ">=24" }, runtime)).toThrow(
      /requires Node\.js >=24.*runtime is 22\.14\.0/i,
    );
  });

  it("rejects malformed compatibility ranges instead of approving by accident", () => {
    expect(() => assertPackCompatibility({ aart: "new enough" }, runtime)).toThrow(
      PackCompatibilityError,
    );
  });
});
