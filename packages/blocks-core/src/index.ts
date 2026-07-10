// @aart/blocks-core — the core built-in block catalog (spec §15.1-15.3):
// browser/web/http/file/data/flow/wait/human/assert/artifact/report/
// command/eval. 51 blocks across 11 groups, every one a real
// `BlockImplementation` against the S0-frozen contract (architecture
// §2.5, packages/types/src/block.ts). See AMENDMENTS.md / SEAMS.md at
// the repo root for this package's flagged decisions and published seams.

// --- Catalog assembly — the primary entry point ---
export { createBlockCatalog, getBlockCatalog, getBlockGroupCounts, type BlocksCoreDeps } from "./catalog.js";

// --- Per-group arrays/factories, for a consumer that wants one group only ---
export { BROWSER_BLOCKS } from "./browser/index.js";
export { HTTP_BLOCKS } from "./http/index.js";
export { DATA_BLOCKS } from "./data/index.js";
export { FILE_BLOCKS } from "./file/index.js";
export { FLOW_BLOCKS } from "./flow/index.js";
export { WAIT_BLOCKS } from "./wait/index.js";
export { HUMAN_BLOCKS } from "./human/index.js";
export { ASSERT_BLOCKS } from "./assert/index.js";
export { COMMAND_BLOCKS } from "./command/index.js";
export { createArtifactReportBlocks } from "./artifact-report/index.js";
export { createEvalBlocks } from "./eval/index.js";

// --- Injected-boundary ports (SEAMS.md E2/E3 — the exact S6 @aart/evidence shapes) ---
export {
  ScorerRegistryUnavailableError,
  tryLoadEvidenceScorerRegistry,
  type ScorerRegistryPort,
  type ScorerRegistryEntry,
  type ScorerResult,
} from "./eval/scorer-registry-port.js";
export {
  createFallbackReportRenderers,
  tryLoadEvidenceReportRenderers,
  type ReportRenderersPort,
} from "./artifact-report/report-renderers-port.js";

// --- Composition-root configuration (analogous to constructor-injecting a RedactFn elsewhere in this architecture) ---
export { checkEgressAllowed, getEgressPolicy, setEgressPolicy, EgressDeniedError, type EgressPolicy } from "./lib/egress.js";
export { getWorkspaceRoot, resolveWorkspacePath, setWorkspaceRoot, WorkspacePathError } from "./lib/workspace-fs.js";

// --- Browser session lifecycle (SEAMS.md S3-E1 — expected to be called by S1/S2 at run-completion/shutdown) ---
export { closeAllBrowserSessions, closeBrowserSession, hasSession as hasBrowserSession } from "./lib/browser-session.js";

// --- Shared error types a caller may want to `instanceof`-check ---
export { BlockSchemaError } from "./lib/define-block.js";
export { BlockAssertionError } from "./lib/assertion.js";
export { DataPathError } from "./lib/data-path.js";
export { JsonPathSyntaxError } from "./lib/jsonpath.js";
