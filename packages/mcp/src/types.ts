// Ports — the dependency-injection seams this package uses to call every
// OTHER Wave-1 package (engine/S1, governance/S4, evidence/S6, registry/S7).
//
// This session (S5, @aart/mcp + @aart/cli) is a PURE CONSUMER (implementation
// plan §3/S5's own scope note): every MCP tool and CLI command calls the
// real underlying function from its owning package, or — where that
// package's real implementation is not in THIS worktree (governance/engine/
// evidence/registry are all still S0 `export {}` stubs here, since S4/S1/S6/
// S7 are concurrent Wave-1 sessions building in their own worktrees) — a
// documented stub with the frozen/published signature, exactly mirroring
// what the owning session's own SEAMS.md (or, where landed, its real source)
// documents. This is the SAME pattern S2's `packages/server/src/promotion.ts`
// and `packages/server/src/engine/boundary.ts` use for the identical reason
// (see /Users/johnlee/code/aart-s2/SEAMS.md) — a port type here, a Stub*
// implementation in `stubs/*.ts`, swapped for a real workspace import at S9
// merge time.
//
// Every port below cites the exact sibling doc/source it mirrors so a
// reviewer (or S9) can diff this file against the real package without
// re-deriving the shape from prose.
import type {
  ApprovalState,
  ApprovalTask,
  Correction,
  Deployment,
  EvalExample,
  EvalRun,
  EvalSuite,
  Gates,
  ModelFacingReport,
  RunRecord,
  TrustMode,
  Workflow,
} from "@aart/types";

// PromotionRecord — NOT part of @aart/types (ADR-07/architecture §7.1:
// "its exact field shape is ADR-07's/S2's to finalize ... not part of this
// section's frozen return-type vocabulary"). This is @aart/governance's
// (S4) own real, landed shape (packages/governance/src/approval.ts,
// verified 2026-07-10), reproduced here so this port can name it.
export interface PromotionRecordShape {
  readonly environment: string;
  readonly promoted: boolean;
  readonly globalApproval: ApprovalState;
  readonly requiredGates: readonly GateNameLocal[];
  readonly unmetGates: readonly GateNameLocal[];
}
type GateNameLocal = keyof Gates;

// ---------------------------------------------------------------------------
// EnginePort — mirrors @aart/engine's Engine interface (S1 SEAMS.md, Seam 4
// `createEngine(config): Engine`) and its standalone triggerRun (Seam 3).
// Narrowed to the methods @aart/mcp/@aart/cli actually call; every method
// name/signature below is copied verbatim from S1's documented Engine
// interface so a real @aart/engine import satisfies this port with zero
// adaptation at merge time.
// ---------------------------------------------------------------------------

export type ResumeOutcome =
  | { kind: "resumed"; run: RunRecord }
  | { kind: "duplicate" }
  | { kind: "unmatched" };

export interface EnginePort {
  /** S1 SEAMS Seam 3/4: `triggerRun`/`engine.triggerRun` — creates and persists a `pending` RunRecord, enqueues to job_queue. */
  triggerRun(input: {
    workflow: Workflow;
    trigger: import("@aart/types").Trigger;
    inputs: Record<string, unknown>;
    params?: Record<string, unknown>;
    environment?: string;
    approved?: boolean;
    approvalMode?: TrustMode;
  }): Promise<RunRecord>;
  /** S1 SEAMS Seam 4: `engine.executeRun(runId)` — advances a claimed run through its step loop. */
  executeRun(runId: string): Promise<RunRecord>;
  /** S1 SEAMS Seam 4: `engine.resumeManual/resumeBySignal/resumeApproval/resumeTimerWait` — this port collapses those four into one dispatch by `mechanism`, since @aart/mcp/@aart/cli only need "resume this run" with whichever payload shape the caller has. */
  resumeManual(runId: string, stepId: string, payload?: unknown): Promise<ResumeOutcome>;
  resumeBySignal(signal: { name: string; correlationId: string; payload?: unknown }): Promise<ResumeOutcome>;
  resumeApproval(runId: string, stepId: string, task: { id: string; status: string; decision?: unknown; reviewer?: string }): Promise<ResumeOutcome>;
}

// ---------------------------------------------------------------------------
// GovernancePort — mirrors @aart/governance's real, LANDED exports (verified
// directly against /Users/johnlee/code/aart-s4/packages/governance/src —
// S4 merged 7e319e0 on branch s4-governance): gates.ts's
// `REQUIRED_GATES_BY_MODE`/`AART_APPROVE_TOOL_NAME`/`MODES_WITH_AART_APPROVE`/
// `isAartApproveRegisteredForMode`; approval.ts's `computeApprovalState`/
// `computePromotionState`/`evaluatePromotionForEnvironment`; validation/
// index.ts's `validateWorkflow`; risk-diff.ts's `semanticRiskDiff`;
// redact.ts's `redactRecord` (== @aart/types' frozen `RedactFn`).
// ---------------------------------------------------------------------------

export type GateName = keyof Gates;
export type AutoApprovalState = "draft" | "approved";

export type PromotionEvaluation =
  | { blocked: true; reason: "promotion_blocked"; environment: string }
  | { blocked: false; record: PromotionRecordShape };

export interface ValidationFinding {
  readonly class: "schema" | "reference" | "capability" | "input-safety" | "deployment";
  readonly path: string;
  readonly message: string;
  readonly didYouMean?: string;
  readonly correctedSnippet?: string;
  readonly severity: "error" | "warning";
}

export interface ValidationResultShape {
  readonly valid: boolean;
  readonly findings: readonly ValidationFinding[];
}

export interface SemanticRiskDiffShape {
  readonly added: readonly { stepId: string; uses: string }[];
  readonly removed: readonly { stepId: string; uses: string }[];
  readonly modified: readonly { stepId: string; details: readonly string[] }[];
  readonly capabilityChanged: boolean;
  readonly riskIncreased: boolean;
}

export interface GovernancePort {
  requiredGatesByMode: Readonly<Record<TrustMode, readonly GateName[]>>;
  isAartApproveRegisteredForMode(mode: TrustMode): boolean;
  computeApprovalState(gates: Gates, requiredGatesForMode: readonly GateName[]): AutoApprovalState;
  computePromotionState(
    globalApproval: AutoApprovalState | "deprecated",
    gates: Gates,
    requiredGatesForEnvironment: readonly GateName[],
    environment: string,
  ): PromotionRecordShape;
  evaluatePromotionForEnvironment(params: {
    workflow: Pick<Workflow, "promotionBlocked">;
    globalApproval: AutoApprovalState | "deprecated";
    gates: Gates;
    requiredGatesForEnvironment: readonly GateName[];
    environment: string;
  }): PromotionEvaluation;
  validateWorkflow(input: unknown): ValidationResultShape;
  semanticRiskDiff(from: Workflow, to: Workflow): SemanticRiskDiffShape;
  redact(record: unknown, resolvedSecretRefs: ReadonlySet<string>): unknown;
  /**
   * S9 integration (reconciliation ledger item 1): governance's sentinel
   * runId/stepId encoding for a workflow-VERSION-level ApprovalTask
   * decision (approval-tasks.ts) — the convention this package's own
   * handlers now use instead of the FORMER locally-invented
   * `version-review:<id>@<version>`/`humanReview` encoding (root
   * AMENDMENTS.md A23's "S9 resolution": governance's convention won,
   * since governance owns the underlying ApprovalTask-writing business
   * logic this sentinel decorates).
   */
  workflowVersionApprovalSubject(workflowId: string, workflowVersion: string): { runId: string; stepId: string };
  /** The decode side of `workflowVersionApprovalSubject` above — `undefined` for any `runId` that isn't this sentinel shape (including a genuine per-run `RunRecord.runId`). */
  decodeWorkflowVersionApprovalSubject(runId: string): { workflowId: string; workflowVersion: string } | undefined;
  /**
   * S9 integration (reconciliation ledger item 1's redaction-bypass finding):
   * the one path every `ApprovalTask` write goes through, routing through
   * governance's redaction chokepoint before persisting (architecture
   * §7.9's diagram names "approval decision" as a redactRecord input path
   * explicitly). This package's own handlers previously wrote
   * `store.approvals.put(...)` directly, bypassing it.
   */
  writeApprovalDecision(
    store: import("@aart/store").AartStore,
    input: {
      readonly id: string;
      readonly runId: string;
      readonly stepId: string;
      readonly title: string;
      readonly description: string;
      readonly status: ApprovalTask["status"];
      readonly reviewer?: string;
      readonly decision?: unknown;
      readonly createdAt: string;
      readonly decidedAt?: string;
    },
  ): Promise<ApprovalTask>;
}

// ---------------------------------------------------------------------------
// EvidencePort — mirrors @aart/evidence's real exports (S6 SEAMS.md E3/E4):
// `createReportRenderers(redact).modelFacing(run)`; the correction-outcome
// function set (correction.ts/outcomes.ts).
// ---------------------------------------------------------------------------

export interface EvidencePort {
  modelFacingReport(run: RunRecord): ModelFacingReport;
  markdownReport(run: RunRecord): string;
  /** S6 SEAMS E4: `recordCorrection(store, input): Promise<Correction>`. */
  recordCorrection(input: {
    runId: string;
    stepId: string;
    fieldPath: string;
    observed: unknown;
    corrected: unknown;
    reason: string;
    reviewer: string;
  }): Promise<Correction>;
  /** S6 SEAMS E4: `createEvalExampleFromCorrection(store, correction, suiteId, options?): Promise<EvalExample>`. */
  createEvalExampleFromCorrection(correction: Correction, suiteId: string): Promise<EvalExample>;
  /** Runs every example in a suite against a workflow's latest run outputs — a simplified stand-in for S6's full scorer registry (12 kinds, architecture §9.5); this port only exercises `exact_match`/`jsonpath_contains`-shaped comparisons, clearly short of S6's real registry. */
  runEval(suite: EvalSuite, workflowId: string, workflowVersion: string): Promise<EvalRun>;
}

// ---------------------------------------------------------------------------
// RegistryPort — mirrors @aart/registry's real, documented export (S7
// SEAMS.md R2): `findBlocks(input): BlockSearchResult[]` over a
// `BlockCatalogEntry[]` (manifest + packName + examples).
// ---------------------------------------------------------------------------

export interface BlockCatalogEntry {
  manifest: import("@aart/types").BlockManifest;
  packName?: string;
  examples: readonly { description: string; inputs: Record<string, unknown> }[];
}

export interface BlockSearchResult {
  entry: BlockCatalogEntry;
  score: number;
}

export interface RegistryPort {
  findBlocks(input: { query: string; category?: string }): BlockSearchResult[];
  listBlocks(): readonly BlockCatalogEntry[];
  getBlock(id: string): BlockCatalogEntry | undefined;
}

// ---------------------------------------------------------------------------
// ServerPort — mirrors @aart/server's real, documented exports (S2 SEAMS.md):
// startServer/startWorker/produceBundle+writeBundleToDisk/clearRunFlag+
// listFlaggedRuns. CLI-only (architecture §13.3's stated exception — NO MCP
// tool wraps clearRunFlag; @aart/mcp does not depend on this port at all,
// only @aart/cli's server/worker/bundle/flag commands do).
// ---------------------------------------------------------------------------

export interface ServerHandleLike {
  port: number;
  close(): Promise<void>;
}

export interface WorkerHandleLike {
  stop(): Promise<void>;
}

export interface BundleLike {
  manifest: Record<string, unknown>;
  files: Record<string, string>;
}

export type ClearRunFlagResult = { kind: "cleared"; run: RunRecord } | { kind: "not_found" } | { kind: "no_flag" };

export interface ServerPort {
  startServer(config: { port?: number }): Promise<ServerHandleLike>;
  startWorker(options: { workerId?: string }): Promise<WorkerHandleLike>;
  produceBundle(params: { workflowId: string; workflowVersion: string; environment?: string }): Promise<BundleLike>;
  writeBundleToDisk(bundle: BundleLike, outDir: string): Promise<void>;
  clearRunFlag(runId: string, clearedBy: string): Promise<ClearRunFlagResult>;
  listFlaggedRuns(): Promise<RunRecord[]>;
}

export type { ApprovalTask, Deployment };
