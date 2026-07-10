// DashboardDeps — the injection seam architecture §13.2's three-client
// principle depends on: "every writable action in the dashboard calls the
// SAME underlying functions the MCP/CLI surfaces call... the dashboard is a
// third client of those functions, not a parallel implementation."
//
// Originally, none of @aart/server (S2), @aart/governance (S4), @aart/evidence
// (S6), or @aart/engine (S1) had landed in this package's own worktree (each
// was a concurrent Wave-1 session on its own branch — see AMENDMENTS.md/
// SEAMS.md protocol), so every cross-session function this dashboard calls
// was modeled here as a narrow function-type seam + a deliberately
// swappable DI container (`DashboardDeps`) that `views/`/`actions/`-shaped
// handlers receive and call through, matching that sibling's OWN published
// SEAMS.md signature exactly.
//
// S9 integration (reconciliation ledger item 2): the promotion-related
// group below (`PromotionRecord`/`PromotionEvaluation`/
// `EvaluatePromotionForEnvironmentFn`) is no longer this package's own
// mirror — it's imported directly from the real, now-merged
// `@aart/governance`. This dashboard's own local `PromotionRecord` had
// ALREADY independently converged on governance's exact field shape before
// this reconciliation (confirmed structurally identical), which is part of
// why governance's shape was ratified as canonical over @aart/server's
// former, differently-shaped local mirror (root AMENDMENTS.md A26). The DI
// container SHAPE (a swappable `DashboardDeps`) is unchanged — this is a
// value-source swap, not an architecture change; `views/`/`actions/` call
// sites are unaffected since nothing in this package pattern-matched on
// the old locally-invented `{kind:"blocked"|"evaluated"}` discriminant
// (grep-verified before this change).
//
// Every OTHER field below still follows the original pattern (a narrow
// function-type seam, real imports swapped in one group at a time as each
// sibling's composition-root wiring lands) — see this package's SEAMS.md
// for which fields are genuine dashboard-owned gap-fills vs. which mirror
// an already-published sibling signature.
import type { AartStore } from "@aart/store";
import type {
  ApprovalState,
  ApprovalTask,
  Correction,
  EvalExample,
  EvalRun,
  EvalSuite,
  Gates,
  ImprovementBrief,
  ModelFacingReport,
  RedactFn,
  RunRecord,
  Scorer,
  Trigger,
  TrustMode,
  Workflow,
} from "@aart/types";
import type { PromotionEvaluation, PromotionRecord, SemanticRiskDiff } from "@aart/governance";

export type GateName = keyof Gates;
export type { PromotionEvaluation, PromotionRecord };

// ---------------------------------------------------------------------------
// S2 @aart/server seam — SEAMS.md "clearRunFlag — the flagged-run clear
// write path", packages/server/src/flags.ts. Dashboard/CLI only per
// architecture §13.3's stated exception — see actions/flags.ts.
// ---------------------------------------------------------------------------

export type ClearRunFlagResult = { kind: "cleared"; run: RunRecord } | { kind: "not_found" } | { kind: "no_flag" };
export type ClearRunFlagFn = (store: AartStore, runId: string, clearedBy: string) => Promise<ClearRunFlagResult>;
export type ListFlaggedRunsFn = (store: AartStore) => Promise<RunRecord[]>;

// ---------------------------------------------------------------------------
// S1 @aart/engine seam — SEAMS.md Seam 3 (triggerRun) / Seam 4
// (Engine.triggerRun, the continuation-capable bound form). The dashboard's
// "trigger workflow" (§35.2) action binds to the bound-Engine-instance
// form (single positional arg) since that's what SEAMS.md documents
// production callers (S2's ticker/trigger adapters) should use.
// ---------------------------------------------------------------------------

export interface TriggerRunInput {
  workflow: Workflow;
  trigger: Trigger;
  inputs: Record<string, unknown>;
  params?: Record<string, unknown>;
  environment?: string;
  approved?: boolean;
  approvalMode?: RunRecord["approvalMode"];
}
export type TriggerRunFn = (input: TriggerRunInput) => Promise<RunRecord>;

// S1 Seam 1/4 — resumeApproval. "approve human tasks" (§35.2) is the one
// dashboard write action that must both update the ApprovalTask AND
// actually resume the run waiting on it — a task-only update with no
// effect on the run would silently strand the wait. Bound single-arg form
// (matches `engine.resumeApproval(runId, stepId, task)`, the continuation-
// capable version SEAMS.md says production callers should use, same
// reasoning as triggerRun above).
export type ResumeMechanism = "signal_matched" | "scheduler_tick" | "direct_lookup";
export type ResumeOutcome =
  | { kind: "resumed"; run: RunRecord; mechanism: ResumeMechanism }
  | { kind: "duplicate"; mechanism: ResumeMechanism }
  | { kind: "unmatched"; mechanism: ResumeMechanism };
export type ResumeApprovalFn = (runId: string, stepId: string, task: { id: string; status: string; decision?: unknown; reviewer?: string }) => Promise<ResumeOutcome>;

// ---------------------------------------------------------------------------
// @aart/governance's real exports (S9 integration, reconciliation ledger
// item 2) — computeApprovalState (2-arg), evaluatePromotionForEnvironment,
// PromotionRecord/PromotionEvaluation (imported above, re-exported for this
// package's own consumers). Governance's `evaluatePromotionForEnvironment`
// returns `{blocked:true; reason; environment} | {blocked:false; record}` —
// grep-verified before this change that no view/action in this package
// pattern-matched on the FORMER locally-invented `{kind:"blocked"|
// "evaluated"}` shape, so this is a value-source swap only.
// ---------------------------------------------------------------------------

export type ComputeApprovalStateFn = (gates: Gates, requiredGatesForMode: readonly GateName[]) => ApprovalState;

export type EvaluatePromotionForEnvironmentFn = (params: {
  workflow: Pick<Workflow, "promotionBlocked">;
  globalApproval: ApprovalState;
  gates: Gates;
  requiredGatesForEnvironment: readonly GateName[];
  environment: string;
}) => PromotionEvaluation;

// ---------------------------------------------------------------------------
// @aart/governance's real semanticRiskDiff (S9 integration, reconciliation
// ledger item 13) — replaces this package's former computeSimpleStepDiff
// (views/workflows.ts), which that function's own doc comment already
// flagged as "a deliberately SIMPLIFIED stand-in... until the real
// capability-closure-based diff can be wired in." `SemanticRiskDiff`
// (re-exported below) is governance's real, richer result shape (added/
// removed/modified steps, capabilityChanged, newCapabilities/newSecrets/
// newDomains, riskFrom/riskTo/riskIncreased) — see risk-diff.ts. Takes
// plain `Workflow`s (not `{steps, capabilityClosure}`) at this package's
// own DI boundary; the real 2-arg signature's capability-closure
// computation happens inside the bound function (capability-catalog.ts),
// matching how `approveOrDeprecateWorkflow` above hides its own
// `computeApprovalState` call from callers.
// ---------------------------------------------------------------------------

export type { SemanticRiskDiff };
export type SemanticRiskDiffFn = (from: Workflow, to: Workflow) => SemanticRiskDiff;

// ---------------------------------------------------------------------------
// S6 @aart/evidence seam E4 — SEAMS.md "Correction-outcome functions —
// writable actions consumed by @aart/dashboard (S8)". Signatures copied
// verbatim from S6's own SEAMS.md entry, which explicitly names this
// dashboard as the consumer.
// ---------------------------------------------------------------------------

export interface RecordCorrectionInput {
  runId: string;
  stepId: string;
  fieldPath: string;
  observed: unknown;
  corrected: unknown;
  reason: string;
  reviewer: string;
}
export type RecordCorrectionFn = (store: AartStore, input: RecordCorrectionInput) => Promise<Correction>;
export type UpdateRunOutputFn = (store: AartStore, correction: Correction) => Promise<RunRecord>;
export type CreateEvalExampleFromCorrectionFn = (store: AartStore, correction: Correction, suiteId: string, options?: unknown) => Promise<EvalExample>;
export type CreateIssueForAgentFn = (store: AartStore, correction: Correction) => Promise<ImprovementBrief>;
export type TriggerImprovementProposalFn = (store: AartStore, workflowId: string, workflowVersion: string, options?: unknown) => Promise<ImprovementBrief>;
export type BlockPromotionFn = (store: AartStore, workflowId: string, workflowVersion: string) => Promise<Workflow>;
export type UnblockPromotionFn = (store: AartStore, workflowId: string, workflowVersion: string) => Promise<Workflow>;
export type MarkNeedsReviewFn = (store: AartStore, workflowId: string, workflowVersion: string) => Promise<Workflow>;
export type ClearNeedsReviewFn = (store: AartStore, workflowId: string, workflowVersion: string) => Promise<Workflow>;

// ---------------------------------------------------------------------------
// S6 @aart/evidence seam E3 — SEAMS.md "Report renderers — consumed by
// @aart/dashboard (S8)". `html`'s output is what Run Detail (v1) renders
// directly, per E3's own note ("S8 should render this directly rather than
// re-implementing a RunRecord→HTML transform").
// ---------------------------------------------------------------------------

export interface ReportRenderers {
  modelFacing(run: RunRecord, resolvedSecretRefs?: ReadonlySet<string>): ModelFacingReport;
  markdown(run: RunRecord, resolvedSecretRefs?: ReadonlySet<string>): string;
  html(run: RunRecord, resolvedSecretRefs?: ReadonlySet<string>): string;
  prComment(run: RunRecord, resolvedSecretRefs?: ReadonlySet<string>, options?: unknown): string;
  json(run: RunRecord, resolvedSecretRefs?: ReadonlySet<string>): string;
  cliText(run: RunRecord, resolvedSecretRefs?: ReadonlySet<string>): string;
}
export type CreateReportRenderersFn = (redact: RedactFn) => ReportRenderers;

// ---------------------------------------------------------------------------
// S6 @aart/evidence seam E2 — SEAMS.md "Scorer registry — consumed by
// @aart/blocks-core's eval.run/eval.score blocks (S3)". Dashboard's "run
// eval" action needs the same registry to back `runEvalSuite` below.
// ---------------------------------------------------------------------------

export interface ScorerResult {
  passed: boolean;
  score: number;
  detail?: string;
}
export interface ScorerRegistry {
  readonly kinds: readonly string[];
  get(kind: string): unknown;
  score(kind: string, actual: unknown, expected: unknown, config?: unknown): Promise<ScorerResult>;
}
export type CreateScorerRegistryFn = (options?: { llmJudge?: unknown }) => ScorerRegistry;

// ---------------------------------------------------------------------------
// S6 @aart/evidence — packages/evidence/src/evals/run-suite.ts. Observed
// directly in the S6 sibling worktree's source (exact exported signature)
// but NOT YET published as a SEAMS.md entry by S6 — S8 is binding to it
// proactively and flagging this in its own SEAMS.md for S6/S9 to confirm.
// `execute` is deliberately decoupled from real engine execution (matching
// run-suite.ts's own documented decoupling) — the dashboard's default
// stub `execute` just echoes `input` back; a real engine-backed `execute`
// is S9 integration scope, same as S6's own E5 familiarity-evals note.
// ---------------------------------------------------------------------------

export interface RunEvalSuiteResult {
  evalRun: EvalRun;
  results: Array<{ exampleId: string; actual: unknown; result: ScorerResult }>;
}
export type RunEvalSuiteFn = (
  suite: EvalSuite,
  options: {
    dryRun?: boolean;
    execute: (input: unknown, ctx: { dryRun: boolean }) => unknown | Promise<unknown>;
    scorers: ScorerRegistry;
    workflowId: string;
    workflowVersion: string;
    reportArtifact: string;
  },
) => Promise<RunEvalSuiteResult>;

// ---------------------------------------------------------------------------
// S8-authored gap-fills — no sibling SEAMS.md publishes a single owning
// function for these two writes as of this session (S4 publishes only the
// PURE decision functions above; S2's own `promotion.ts` has an unpublished
// `promoteWorkflowVersionToEnvironment` this package's stub deliberately
// mirrors the shape of). Documented here + this package's SEAMS.md, not
// silently resolved — flagged for S9 reconciliation. The actual STORE
// PERSISTENCE these two do is trivial glue (no policy logic of its own);
// the POLICY decision each one makes is still made by calling the real
// injected `computeApprovalState`/`evaluatePromotionForEnvironment` above,
// which IS the part the three-client principle cares about.
// ---------------------------------------------------------------------------

// `action: "approve"` recomputes approval from gates via the injected
// `computeApprovalState` (whose own contract only ever returns
// "draft"|"approved" — never "deprecated", per S2/S4's documented 2-arg
// contract). `action: "deprecate"` is the one transition NOT derivable from
// gates at all — an explicit human retiring an approved version — so it
// sets "deprecated" directly rather than routing through the gate-computed
// function. Both persist via `store.workflows.put`.
export type ApproveOrDeprecateWorkflowFn = (
  store: AartStore,
  workflowId: string,
  version: string,
  action: "approve" | "deprecate",
  requiredGatesForMode: readonly GateName[],
) => Promise<Workflow>;

export type PromoteResult =
  | { kind: "promoted"; record: PromotionRecord; deployment: { id: string; workflowId: string; workflowVersion: string; environmentId: string; triggerConfig: Record<string, unknown>; createdAt: string } }
  | { kind: "not_promoted"; record: PromotionRecord }
  | { kind: "blocked_by_promotion_block" }
  | { kind: "workflow_not_found" }
  | { kind: "environment_not_found" };
export type PromoteWorkflowVersionToEnvironmentFn = (
  store: AartStore,
  params: { workflowId: string; workflowVersion: string; environmentId: string; triggerConfig?: Record<string, unknown> },
) => Promise<PromoteResult>;

export type CreateEvalSuiteFn = (
  store: AartStore,
  input: { name: string; description?: string; scorer: Scorer; examples?: EvalExample[]; tags?: string[] },
) => Promise<EvalSuite>;

/** The ApprovalTask-record half of "approve human tasks" — trivial store glue (fetch, set status/reviewer/decision/decidedAt, persist), no policy logic, so — like `createEvalSuite` — this package's own real implementation rather than a swap-at-merge stub. The run-resuming half is the real seam (`resumeApproval` above); this only updates the task's own record. */
export type DecideApprovalTaskFn = (
  store: AartStore,
  taskId: string,
  status: "approved" | "rejected" | "needs_changes",
  reviewer: string,
  decision?: unknown,
) => Promise<ApprovalTask>;

// ---------------------------------------------------------------------------
// The DI container every views/actions handler in this package receives.
// ---------------------------------------------------------------------------

export interface DashboardDeps {
  /** S4 @aart/governance's real redactRecord in production; an identity/never-invoked stub in dev — architecture §7.9. Secrets-status page (§35.3) and every report render route through this. */
  redact: RedactFn;

  clearRunFlag: ClearRunFlagFn;
  listFlaggedRuns: ListFlaggedRunsFn;

  triggerRun: TriggerRunFn;
  resumeApproval: ResumeApprovalFn;
  decideApprovalTask: DecideApprovalTaskFn;

  computeApprovalState: ComputeApprovalStateFn;
  evaluatePromotionForEnvironment: EvaluatePromotionForEnvironmentFn;
  semanticRiskDiff: SemanticRiskDiffFn;
  /** architecture §7.3's trust-mode→required-gates table — @aart/governance's real REQUIRED_GATES_BY_MODE as of S9 integration (reconciliation ledger item 2); this field's own name is unchanged (dashboard-internal DI naming), only its bound value. */
  requiredGatesByTrustMode: Record<TrustMode, readonly GateName[]>;

  recordCorrection: RecordCorrectionFn;
  updateRunOutput: UpdateRunOutputFn;
  createEvalExampleFromCorrection: CreateEvalExampleFromCorrectionFn;
  createIssueForAgent: CreateIssueForAgentFn;
  triggerImprovementProposal: TriggerImprovementProposalFn;
  blockPromotion: BlockPromotionFn;
  unblockPromotion: UnblockPromotionFn;
  markNeedsReview: MarkNeedsReviewFn;
  clearNeedsReview: ClearNeedsReviewFn;

  createReportRenderers: CreateReportRenderersFn;
  createScorerRegistry: CreateScorerRegistryFn;
  runEvalSuite: RunEvalSuiteFn;

  approveOrDeprecateWorkflow: ApproveOrDeprecateWorkflowFn;
  promoteWorkflowVersionToEnvironment: PromoteWorkflowVersionToEnvironmentFn;
  createEvalSuite: CreateEvalSuiteFn;
}
