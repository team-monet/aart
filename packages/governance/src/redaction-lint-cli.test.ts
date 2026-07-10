// Unit tests for redaction-lint-cli.ts's suppression logic (root
// AMENDMENTS.md, S10 completion). Deliberately does NOT import `main` or
// trigger it — this file only exercises the two exported pure functions;
// main() is guarded by an entry-point check specifically so importing this
// module for testing never runs a real filesystem scan as a side effect.
import { describe, expect, it } from "vitest";
import { applySuppressions, toRepoRelativePath } from "./redaction-lint-cli.js";
import type { RedactionLintFinding } from "./redaction-lint.js";
import type { RedactionLintSuppression } from "./redaction-lint-suppressions.js";

function finding(file: string, line: number, snippet: string): RedactionLintFinding {
  return { file, line, snippet, reason: "store write call not visibly routed through redactRecord" };
}

describe("toRepoRelativePath", () => {
  it("strips the repo root prefix and normalizes to forward slashes", () => {
    expect(toRepoRelativePath("/Users/johnlee/code/aart", "/Users/johnlee/code/aart/packages/mcp/src/stubs/foo.ts")).toBe(
      "packages/mcp/src/stubs/foo.ts",
    );
  });

  it("is a no-op (relative to itself) when already given a relative path under repoRoot", () => {
    expect(toRepoRelativePath("/repo", "/repo/packages/x/src/y.ts")).toBe("packages/x/src/y.ts");
  });
});

describe("applySuppressions", () => {
  const repoRoot = "/Users/johnlee/code/aart";

  it("keeps a finding with no matching suppression (explicit empty suppression list — never relies on the real, live redaction-lint-suppressions.ts, which changes as triage proceeds)", () => {
    const findings = [finding("/Users/johnlee/code/aart/packages/mcp/src/real.ts", 10, "await store.runs.put(x);")];
    const result = applySuppressions(repoRoot, findings, []);
    expect(result.kept).toEqual(findings);
    expect(result.suppressed).toEqual([]);
    expect(result.staleSuppressions).toEqual([]);
  });

  it("suppresses a finding whose (file, snippet) exactly matches a suppression entry, and reports zero stale entries", () => {
    const suppressions = [{ file: "packages/mcp/src/stubs/fake.ts", snippet: "await store.runs.put(fake);", reason: "stub — deterministic fake data, never a real secret" }];
    const findings = [finding("/Users/johnlee/code/aart/packages/mcp/src/stubs/fake.ts", 42, "await store.runs.put(fake);")];
    const result = applySuppressions(repoRoot, findings, suppressions);
    expect(result.kept).toEqual([]);
    expect(result.suppressed).toEqual([{ finding: findings[0], reason: suppressions[0]!.reason }]);
    expect(result.staleSuppressions).toEqual([]);
  });

  it("does NOT suppress when the snippet differs even if the file matches (the guarded line changed — must be re-reviewed, not silently kept suppressed)", () => {
    const suppressions = [{ file: "packages/mcp/src/stubs/fake.ts", snippet: "await store.runs.put(fake);", reason: "stub" }];
    const findings = [finding("/Users/johnlee/code/aart/packages/mcp/src/stubs/fake.ts", 42, "await store.runs.put(differentNow);")];
    const result = applySuppressions(repoRoot, findings, suppressions);
    expect(result.kept).toEqual(findings);
    expect(result.suppressed).toEqual([]);
    // The suppression itself is now stale — it matched nothing this run.
    expect(result.staleSuppressions).toEqual(suppressions);
  });

  it("reports a suppression as stale when its file+snippet doesn't match ANY current finding at all (the call site was removed/refactored away)", () => {
    const suppressions = [{ file: "packages/mcp/src/stubs/gone.ts", snippet: "await store.runs.put(longGone);", reason: "stub, presumably removed since" }];
    const result = applySuppressions(repoRoot, [], suppressions);
    expect(result.kept).toEqual([]);
    expect(result.suppressed).toEqual([]);
    expect(result.staleSuppressions).toEqual(suppressions);
  });

  it("only suppresses the specific finding that matches, leaving siblings in the same file kept", () => {
    const suppressions = [{ file: "packages/mcp/src/stubs/mixed.ts", snippet: "await store.runs.put(fakeOnly);", reason: "stub" }];
    const findings = [
      finding("/Users/johnlee/code/aart/packages/mcp/src/stubs/mixed.ts", 10, "await store.runs.put(fakeOnly);"),
      finding("/Users/johnlee/code/aart/packages/mcp/src/stubs/mixed.ts", 20, "await store.runs.put(somethingElseEntirely);"),
    ];
    const result = applySuppressions(repoRoot, findings, suppressions);
    expect(result.kept).toEqual([findings[1]]);
    expect(result.suppressed.map((s) => s.finding)).toEqual([findings[0]]);
    expect(result.staleSuppressions).toEqual([]);
  });
});
