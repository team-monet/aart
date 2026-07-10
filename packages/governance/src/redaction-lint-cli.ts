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
import { join } from "node:path";
import { lintRedactionBypass } from "./redaction-lint.js";

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

async function main(): Promise<void> {
  const packagesDir = process.argv[2] ?? join(process.cwd(), "packages");
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
  const findings = await lintRedactionBypass(roots);

  if (findings.length === 0) {
    console.log(`redaction-lint: clean (${roots.length} package src dirs scanned)`);
    return;
  }

  console.error(`redaction-lint: ${findings.length} potential redaction bypass(es) found:\n`);
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  ${f.reason}\n    ${f.snippet}\n`);
  }
  process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
