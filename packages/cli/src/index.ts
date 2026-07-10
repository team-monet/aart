// @team-monet/aart (directory packages/cli) — package root export. Real
// bin entry is bin.ts; this module is what a programmatic consumer (or this
// package's own tests) imports instead of shelling out to the built binary.
export { run, USAGE, type CliOutcome, type RunOptions } from "./cli.js";
export { createCliContext, type CliContext } from "./cli-context.js";
export { tokenize, type Tokenized } from "./args.js";
export { createStubServerPort } from "./stubs/server.js";
