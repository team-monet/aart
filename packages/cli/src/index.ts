// @team-monet/aart (directory packages/cli) — package root export. Real
// bin entry is bin.ts; this module is what a programmatic consumer (or this
// package's own tests) imports instead of shelling out to the built binary.
export { INIT_AGENT_USAGE, run, USAGE, type CliOutcome, type RunOptions } from "./cli.js";
export { createCliContext, type CliContext } from "./cli-context.js";
export { tokenize, type Tokenized } from "./args.js";
export { createStubServerPort } from "./stubs/server.js";

// Re-exported verbatim from @aart/mcp — NOT a copy, the literal same
// function objects `packages/cli/src/commands/*.ts` call. Exported here so
// a consumer (or S9's same-function-reference integration check) can import
// "the function `aart run` calls" without reaching into @aart/mcp
// separately and hoping the two happen to line up.
export {
  approveHandler,
  deployToRemoteHandler,
  deployWorkflowHandler,
  diffWorkflowHandler,
  getReportHandler,
  promoteWorkflowHandler,
  recordCorrectionHandler,
  registerWorkflowHandler,
  requestApprovalHandler,
  runEvalHandler,
  runWorkflowHandler,
  validateWorkflowHandler,
} from "@aart/mcp";
