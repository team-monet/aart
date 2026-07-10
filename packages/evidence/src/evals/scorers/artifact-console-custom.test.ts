import type { Artifact } from "@aart/types";
import { describe, expect, it } from "vitest";
import { artifactExists } from "./artifact-exists.js";
import { customNode } from "./custom-node.js";
import type { ConsoleEntry } from "./no-console-errors.js";
import { noConsoleErrors } from "./no-console-errors.js";
import { screenshotExists } from "./screenshot-exists.js";

const artifacts: Artifact[] = [
  { id: "a1", runId: "r", name: "checkout.png", kind: "screenshot", mime: "image/png", path: "p1", bytes: 1, createdAt: "t" },
  { id: "a2", runId: "r", name: "out.json", kind: "json_output", mime: "application/json", path: "p2", bytes: 1, createdAt: "t" },
];

describe("artifact_exists scorer (spec §24.3)", () => {
  it("passes when an artifact matching config.name/kind exists (actual as a plain Artifact[])", () => {
    expect(artifactExists(artifacts, null, { name: "checkout.png" }).passed).toBe(true);
    expect(artifactExists(artifacts, null, { kind: "json_output" }).passed).toBe(true);
    expect(artifactExists(artifacts, null, { name: "checkout.png", kind: "json_output" }).passed).toBe(false);
  });

  it("also accepts actual shaped as { artifacts: Artifact[] }", () => {
    expect(artifactExists({ artifacts }, null, { name: "checkout.png" }).passed).toBe(true);
  });

  it("falls back to a string `expected` as the name filter when config.name is absent", () => {
    expect(artifactExists(artifacts, "checkout.png").passed).toBe(true);
    expect(artifactExists(artifacts, "does-not-exist.png").passed).toBe(false);
  });

  it("fails (not throws) when actual isn't an artifact array/wrapper shape", () => {
    expect(artifactExists("not-artifacts", "checkout.png").passed).toBe(false);
  });
});

describe("screenshot_exists scorer (spec §24.3) — defaults kind to 'screenshot'", () => {
  it("passes for a screenshot-kind artifact by name", () => {
    expect(screenshotExists(artifacts, "checkout.png").passed).toBe(true);
  });

  it("fails for a non-screenshot artifact even if the name matches nothing screenshot-kind", () => {
    expect(screenshotExists(artifacts, "out.json").passed).toBe(false);
  });

  it("respects an explicit config.kind override", () => {
    expect(screenshotExists(artifacts, null, { kind: "json_output", name: "out.json" }).passed).toBe(true);
  });
});

describe("no_console_errors scorer (spec §24.3)", () => {
  it("passes when there are zero error-level entries", () => {
    const entries: ConsoleEntry[] = [{ level: "log" }, { level: "warn" }];
    expect(noConsoleErrors(entries, null).passed).toBe(true);
  });

  it("fails when at least one error-level entry is present", () => {
    const entries: ConsoleEntry[] = [{ level: "log" }, { level: "error", message: "boom" }];
    const result = noConsoleErrors(entries, null);
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("1 console error(s)");
  });

  it("also accepts actual shaped as { console: ConsoleEntry[] }", () => {
    expect(noConsoleErrors({ console: [{ level: "error" }] }, null).passed).toBe(false);
  });

  it("treats a non-array actual as zero entries (passes vacuously)", () => {
    expect(noConsoleErrors(undefined, null).passed).toBe(true);
  });
});

describe("custom_node scorer (spec §24.3) — an injected pure function, never an eval()'d string", () => {
  it("delegates scoring to config.fn and forces deterministic: true", () => {
    const result = customNode("a", "a", {
      fn: (actual: unknown, expected: unknown) => ({ passed: actual === expected, score: actual === expected ? 1 : 0 }),
    });
    expect(result).toEqual({ passed: true, score: 1, detail: undefined, deterministic: true });
  });

  it("throws a clear, documented error when config.fn is missing (not a silent no-op or an eval())", () => {
    expect(() => customNode("a", "a")).toThrow(/requires config\.fn/);
  });
});
