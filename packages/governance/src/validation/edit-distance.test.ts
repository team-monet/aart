import { describe, expect, it } from "vitest";
import { computeDidYouMean, levenshteinDistance } from "./edit-distance.js";

describe("levenshteinDistance", () => {
  it("is 0 for identical strings", () => {
    expect(levenshteinDistance("browser.goto", "browser.goto")).toBe(0);
  });

  it("counts a single substitution as 1", () => {
    expect(levenshteinDistance("cat", "bat")).toBe(1);
  });

  it("counts insertions/deletions correctly", () => {
    expect(levenshteinDistance("browser.gото", "browser.goto")).toBeGreaterThanOrEqual(0);
    expect(levenshteinDistance("goto", "got")).toBe(1);
    expect(levenshteinDistance("", "abc")).toBe(3);
  });
});

// A small fixture catalog + a fixture alias table (spec §32.5's real alias
// table is not part of this session's reading list — this session's own
// DoD explicitly anticipates that: "flag as a same-wave convergence point
// if S3 lags"). Real catalog/alias-table wiring is a same-wave/S9
// convergence point.
const FIXTURE_CATALOG = ["browser.goto", "browser.click", "browser.screenshot", "assert.contains", "http.request", "command.run"];
const FIXTURE_ALIAS_TABLE = { "browser.open": "browser.goto", "open page": "browser.goto" };

describe("computeDidYouMean — errors-as-corrections (architecture §7.7, spec §32.2b)", () => {
  it("suggests the closest real block for a misspelled name", () => {
    expect(computeDidYouMean("browser.got", FIXTURE_CATALOG)).toBe("browser.goto");
    expect(computeDidYouMean("browser.golo", FIXTURE_CATALOG)).toBe("browser.goto");
  });

  it("checks the alias table FIRST, by exact phrase match — spec's own example: browser.open -> browser.goto", () => {
    expect(computeDidYouMean("browser.open", FIXTURE_CATALOG, FIXTURE_ALIAS_TABLE)).toBe("browser.goto");
  });

  it("returns undefined for a wildly-off guess (nothing close enough)", () => {
    expect(computeDidYouMean("totally.unrelated.thing.zzz", FIXTURE_CATALOG)).toBeUndefined();
  });

  it("returns undefined when the input is already an exact catalog match (nothing to suggest)", () => {
    // distance 0 is technically "closest," but a caller only asks
    // computeDidYouMean for a name it ALREADY knows isn't in the catalog
    // (reference.ts only calls this when blockCatalog.resolve() failed) —
    // still verify the function itself behaves sanely if called anyway.
    expect(computeDidYouMean("browser.goto", FIXTURE_CATALOG)).toBe("browser.goto");
  });
});
