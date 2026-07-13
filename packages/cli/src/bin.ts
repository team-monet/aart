#!/usr/bin/env node
// The real `aart` bin entry (package.json: "bin": { "aart": "./dist/bin.js" }).
// S0's cli stub declared this bin field but shipped no src/bin.ts — this is
// that real entry, created as part of this session's CLI work.
import { run, USAGE, VERSION } from "./cli.js";

const argv = process.argv.slice(2);
if (argv.length === 0) {
  process.stdout.write(USAGE);
  process.exit(1);
}
// AMENDMENTS.md A63 FIX 7 (optional/low-priority, tester UX) — mirrors the
// zero-arg case immediately above: `aart --help`/`-h`/`help` prints the
// plain USAGE block to stdout and exits 0, bypassing `run()`/context
// construction entirely (a help request needs no `.aart` store). Pre-fix,
// these fell through to `run()`'s own `default:` case, which JSON-wrapped
// USAGE inside a false "Unknown command" envelope at exit code 1 —
// cli.ts's own `run()` gained a matching `case "--help"/"-h"/"help"` too
// (defense in depth for a direct `run()` caller), but reaching THIS exit-0,
// plain-text behavior for the real `aart` binary requires the short-circuit
// here, same as the zero-arg case.
if (argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
  process.stdout.write(USAGE);
  process.exit(0);
}
// AMENDMENTS.md A68 (0.10.0 release prep) — `aart --version`/`-v` did not
// exist anywhere in this CLI's surface before this release (see cli.ts's
// own VERSION doc comment). Same short-circuit shape as --help immediately
// above, for the same reason: a version check needs no `.aart` store and
// should never attempt to construct one.
if (argv[0] === "--version" || argv[0] === "-v") {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}

const outcome = await run(argv);
process.stdout.write(`${JSON.stringify(outcome.result, null, 2)}\n`);
process.exitCode = outcome.exitCode;
