// createBlockCatalog / getBlockCatalog — the single assembly point for all
// 51 blocks across this package's 11 groups (spec §15.1-15.3), each block
// a real `BlockImplementation` built via lib/define-block.ts against the
// S0-frozen contract (architecture §2.5).
//
// Two groups (eval, artifact-report) are DI'd via their own `createX(deps)`
// factories rather than plain arrays, since 3 of their combined 6 blocks
// need a `ScorerRegistryPort`/`ReportRenderersPort` injected at
// construction time (eval/scorer-registry-port.ts, artifact-report/
// report-renderers-port.ts). `createBlockCatalog(deps)` is where those
// deps get threaded through; `getBlockCatalog()` is the zero-arg
// convenience default (no injection — eval blocks lazy-resolve
// `@aart/evidence` or throw a clear "not wired yet" error; report blocks
// lazy-resolve `@aart/evidence` or fall back to a real local renderer).
// Once S9 merges S6's real `@aart/evidence`, a composition root wires the
// real `createScorerRegistry(...)`/`createReportRenderers(...)` outputs in
// via `createBlockCatalog({ scorerRegistry, reportRenderers })` — no block
// rewrite needed, per this session's injected-boundary brief.
import type { BlockImplementation } from "@aart/types";
import { BROWSER_BLOCKS } from "./browser/index.js";
import { HTTP_BLOCKS } from "./http/index.js";
import { DATA_BLOCKS } from "./data/index.js";
import { FILE_BLOCKS } from "./file/index.js";
import { FLOW_BLOCKS } from "./flow/index.js";
import { WAIT_BLOCKS } from "./wait/index.js";
import { HUMAN_BLOCKS } from "./human/index.js";
import { ASSERT_BLOCKS } from "./assert/index.js";
import { createArtifactReportBlocks } from "./artifact-report/index.js";
import { COMMAND_BLOCKS } from "./command/index.js";
import { createEvalBlocks } from "./eval/index.js";
import type { ScorerRegistryPort } from "./eval/scorer-registry-port.js";
import type { ReportRenderersPort } from "./artifact-report/report-renderers-port.js";

export interface BlocksCoreDeps {
  /** Injected into eval.run/eval.score (eval/index.ts). No local fallback — see eval/scorer-registry-port.ts for why. */
  scorerRegistry?: ScorerRegistryPort;
  /** Injected into report.summarize/report.markdown/report.json (artifact-report/index.ts). Falls back to a real local renderer when omitted — see artifact-report/report-renderers-port.ts. */
  reportRenderers?: ReportRenderersPort;
}

/**
 * The 11 groups, in spec §15.3's own listing order, covering the 13
 * core-builtin namespaces architecture §1 counts separately (`web` folded
 * into Browser, `artifact`+`report` grouped together — both figures are
 * the same 13 namespaces, just grouped differently). `llm.*`'s 5 blocks
 * are `@aart/llm`/S7's, per ADR-11 — not part of this catalog.
 */
export function createBlockCatalog(deps: BlocksCoreDeps = {}): BlockImplementation[] {
  return [
    ...BROWSER_BLOCKS, // 11 (incl. web.read)
    ...HTTP_BLOCKS, // 3
    ...DATA_BLOCKS, // 6
    ...FILE_BLOCKS, // 4
    ...FLOW_BLOCKS, // 4
    ...WAIT_BLOCKS, // 6
    ...HUMAN_BLOCKS, // 3
    ...ASSERT_BLOCKS, // 7
    ...createArtifactReportBlocks({ reportRenderers: deps.reportRenderers }), // 4
    ...COMMAND_BLOCKS, // 1
    ...createEvalBlocks({ scorerRegistry: deps.scorerRegistry }), // 2
  ]; // = 51
}

/** `createBlockCatalog()` with no injected deps — see this module's doc comment for the lazy-resolution behavior that gives every caller a real, complete 51-manifest catalog even before deps are injected (only calling `execute()` on an eval/report block without a resolvable dependency can fail; building the catalog and reading every manifest never does). */
export function getBlockCatalog(): BlockImplementation[] {
  return createBlockCatalog();
}

/** Per-group counts, exported for tests/tooling that want to verify the catalog's shape without re-deriving group boundaries from block ids. */
export function getBlockGroupCounts(): Record<string, number> {
  return {
    browser: BROWSER_BLOCKS.length,
    http: HTTP_BLOCKS.length,
    data: DATA_BLOCKS.length,
    file: FILE_BLOCKS.length,
    flow: FLOW_BLOCKS.length,
    wait: WAIT_BLOCKS.length,
    human: HUMAN_BLOCKS.length,
    assert: ASSERT_BLOCKS.length,
    artifactReport: createArtifactReportBlocks().length,
    command: COMMAND_BLOCKS.length,
    eval: createEvalBlocks().length,
  };
}
