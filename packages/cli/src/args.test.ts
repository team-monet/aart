import { describe, expect, it } from "vitest";
import { flagBoolean, flagString, requireFlagString, requirePositional, tokenize } from "./args.js";

describe("tokenize", () => {
  it("separates positionals from --flag value pairs", () => {
    const { positionals, flags } = tokenize(["run", "wf-1", "--input", "{}"]);
    expect(positionals).toEqual(["run", "wf-1"]);
    expect(flags).toEqual({ input: "{}" });
  });

  it("supports --flag=value form", () => {
    const { flags } = tokenize(["--target=staging"]);
    expect(flags).toEqual({ target: "staging" });
  });

  it("treats a --flag with no following value (or followed by another flag) as boolean true", () => {
    const { flags } = tokenize(["--dry-run", "--other"]);
    expect(flags).toEqual({ "dry-run": true, other: true });
  });

  it("handles a realistic mixed command line", () => {
    const { positionals, flags } = tokenize(["correction", "add", "run_1", "--step", "s1", "--field", "outputs.x", "--reason", "typo"]);
    expect(positionals).toEqual(["correction", "add", "run_1"]);
    expect(flags).toEqual({ step: "s1", field: "outputs.x", reason: "typo" });
  });
});

describe("flag helpers", () => {
  it("flagString returns the string value or undefined", () => {
    expect(flagString({ a: "x" }, "a")).toBe("x");
    expect(flagString({ a: true }, "a")).toBeUndefined();
    expect(flagString({}, "a")).toBeUndefined();
  });

  it("flagBoolean treats true/'true' as true, everything else false", () => {
    expect(flagBoolean({ a: true }, "a")).toBe(true);
    expect(flagBoolean({ a: "true" }, "a")).toBe(true);
    expect(flagBoolean({ a: "false" }, "a")).toBe(false);
    expect(flagBoolean({}, "a")).toBe(false);
  });

  it("requireFlagString throws when missing", () => {
    expect(() => requireFlagString({}, "reviewer")).toThrow(/reviewer/);
  });

  it("requirePositional throws with a labeled message when missing", () => {
    expect(() => requirePositional([], 0, "workflowId")).toThrow(/workflowId/);
  });

  it("requirePositional returns the value when present", () => {
    expect(requirePositional(["wf-1"], 0, "workflowId")).toBe("wf-1");
  });
});
