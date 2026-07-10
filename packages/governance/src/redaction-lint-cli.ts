#!/usr/bin/env node
// CI entry point for the redaction-bypass lint (architecture §7.9-adjacent,
// ADR-10's consequences). Scans every consuming package's `src/` directory
// for call sites that look like a persist/emit path not visibly routed
// through `redactRecord`. Wired into this package's own `lint:redaction`
// script; S9 is responsible for adding this as a CI step (this package's
// DoD: "S9 verifies it actually runs in CI, not just exists as a script
// nobody wired in") — not touched here, since .github/workflows/ci.yml is
// outside packages/governance/**'s ownership boundary.
import { promises as fs } from "node:fs";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { lintRedactionBypass, type RedactionLintFinding } from "./redaction-lint.js";
import { REDACTION_LINT_SUPPRESSIONS, type RedactionLintSuppression } from "./redaction-lint-suppressions.js";

// `@aart/store` is deliberately excluded from the default scan: it IS the
// storage mechanism (the fs/sqlite/postgres adapters, the migration
// framework, and the adapter-conformance suite that exercises them
// directly with raw fixture data to prove get/put/transact() round-trip
// correctly) — architecturally BELOW where redaction applies. Redaction is
// the CALLER's responsibility, enforced before a record ever reaches
// `store.x.put(...)` (architecture §4.2/§7.9: the engine redacts, THEN
// persists) — the store's own adapter code and its own test suite calling
// `store.runs.put(rawFixture)` are not a "persist/emit path" in the
// architecture §7.9 sense, they're proving the storage mechanism itself
// works, which is an orthogonal concern. Verified empirically during this
// session: an unscoped scan against packages/store produced 40+ findings,
// every one a false positive of exactly this shape (adapter internals /
// conformance-suite fixture writes), which would have buried the small
// number of real findings this tool needs to stay useful for.
const DEFAULT_EXCLUDED_PACKAGES = new Set(["store"]);

// repoRoot: packagesDir's parent — findings are normalized relative to this
// before suppression-matching, so REDACTION_LINT_SUPPRESSIONS' entries (and
// this CLI's own portability) don't depend on any one machine's/CI runner's
// absolute checkout path.
export function toRepoRelativePath(repoRoot: string, absoluteOrRelativePath: string): string {
  return relative(repoRoot, absoluteOrRelativePath).split(sep).join("/");
}

/**
 * Splits findings into (kept, suppressed) against the reviewed suppression
 * list — matched on (repo-relative file, exact trimmed snippet), never on
 * line number alone (see redaction-lint-suppressions.ts's own doc comment
 * for why). A suppression entry that matches NOTHING (stale — the guarded
 * code moved or changed) is reported separately, since a suppression list
 * that silently accumulates dead entries is exactly the kind of thing that
 * erodes trust in this file over time.
 */
export function applySuppressions(
  repoRoot: string,
  findings: readonly RedactionLintFinding[],
  suppressions: readonly RedactionLintSuppression[] = REDACTION_LINT_SUPPRESSIONS,
): { kept: RedactionLintFinding[]; suppressed: Array<{ finding: RedactionLintFinding; reason: string }>; staleSuppressions: readonly RedactionLintSuppression[] } {
  const kept: RedactionLintFinding[] = [];
  const suppressed: Array<{ finding: RedactionLintFinding; reason: string }> = [];
  const matchedSuppressionKeys = new Set<string>();

  for (const finding of findings) {
    const relFile = toRepoRelativePath(repoRoot, finding.file);
    const match = suppressions.find((s) => s.file === relFile && s.snippet === finding.snippet);
    if (match) {
      matchedSuppressionKeys.add(`${match.file}:::${match.snippet}`);
      suppressed.push({ finding, reason: match.reason });
    } else {
      kept.push(finding);
    }
  }

  const staleSuppressions = suppressions.filter((s) => !matchedSuppressionKeys.has(`${s.file}:::${s.snippet}`));
  return { kept, suppressed, staleSuppressions };
}

async function main(): Promise<void> {
  const packagesDir = process.argv[2] ?? join(process.cwd(), "packages");
  const repoRoot = join(packagesDir, "..");
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = await fs.readdir(packagesDir, { withFileTypes: true });
  } catch (err) {
    console.error(`redaction-lint: could not read packages dir ${packagesDir}: ${String(err)}`);
    process.exitCode = 1;
    return;
  }
  const roots = entries
    .filter((e) => e.isDirectory() && !DEFAULT_EXCLUDED_PACKAGES.has(e.name))
    .map((e) => join(packagesDir, e.name, "src"));
  const allFindings = await lintRedactionBypass(roots);
  const { kept, suppressed, staleSuppressions } = applySuppressions(repoRoot, allFindings);

  if (staleSuppressions.length > 0) {
    console.error(`redaction-lint: ${staleSuppressions.length} STALE suppression(s) in redaction-lint-suppressions.ts matched nothing — the guarded code moved or changed since review; remove or re-review:\n`);
    for (const s of staleSuppressions) {
      console.error(`  ${s.file}  (was: "${s.snippet}")\n    reason on file: ${s.reason}\n`);
    }
    process.exitCode = 1;
    return;
  }

  if (kept.length === 0) {
    console.log(`redaction-lint: clean (${roots.length} package src dirs scanned, ${suppressed.length} reviewed suppression(s) applied)`);
    return;
  }

  console.error(`redaction-lint: ${kept.length} potential redaction bypass(es) found (${suppressed.length} reviewed suppression(s) applied):\n`);
  for (const f of kept) {
    console.error(`  ${f.file}:${f.line}  ${f.reason}\n    ${f.snippet}\n`);
  }
  process.exitCode = 1;
}

// Only auto-run when executed directly (`node redaction-lint-cli.js`), not
// when imported as a module — this file now exports real logic
// (applySuppressions/toRepoRelativePath) worth unit-testing directly
// (redaction-lint-cli.test.ts), which would otherwise trigger a real
// filesystem scan + console output + possible process.exitCode mutation as
// a side effect of the mere `import`.
const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
