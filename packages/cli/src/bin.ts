#!/usr/bin/env node
// The real `aart` bin entry (package.json: "bin": { "aart": "./dist/bin.js" }).
// S0's cli stub declared this bin field but shipped no src/bin.ts — this is
// that real entry, created as part of this session's CLI work.
import { run, USAGE } from "./cli.js";

const argv = process.argv.slice(2);
if (argv.length === 0) {
  process.stdout.write(USAGE);
  process.exit(1);
}

const outcome = await run(argv);
process.stdout.write(`${JSON.stringify(outcome.result, null, 2)}\n`);
process.exitCode = outcome.exitCode;
