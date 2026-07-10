// DashboardDeps — the injection seam architecture §13.2's three-client
// principle depends on: "every writable action in the dashboard calls the
// SAME underlying functions the MCP/CLI surfaces call... the dashboard is a
// third client of those functions, not a parallel implementation."
//
// None of @aart/server (S2), @aart/governance (S4), @aart/evidence (S6), or
// @aart/engine (S1) has landed in THIS worktree (each is a concurrent
// Wave-1 session on its own branch — see AMENDMENTS.md/SEAMS.md protocol);
// this package therefore does not take a package.json dependency on any of
// them. Instead, every cross-session function this dashboard calls is
// modeled here as a narrow function-type seam matching that sibling's
// OWN published SEAMS.md signature exactly (cited per group below), + a
// deliberately swappable DI container (`DashboardDeps`) that `views/`
// and `actions/`-shaped handlers receive and call through.
//
// This is the same pattern @aart/server itself used for S1's engine
// (`engine/boundary.ts`'s `EngineBoundary` + `createFakeEngine`) and for
// S4's governance functions (`promotion.ts`'s flagged local mirror) —
// established, precedented, not a dashboard-specific invention.
//
// AT S9 MERGE TIME: replace `createStubDeps`'s fields one-by-one with the
// real imports (`import { clearRunFlag } from "@aart/server"`, etc.) — the
// function TYPES here are written to match the real signatures exactly, so
// no call site in `views/`/`actions/` needs to change, only the values
// passed into `DashboardDeps`. See this package's SEAMS.md for the fields
// that are genuine gaps (no sibling has published a seam yet) vs. fields
// that mirror an already-published signature.
import type { AartStore } from "@aart/store";
import type {
  ApprovalState,
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

export type GateName = keyof Gates;

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

// ---------------------------------------------------------------------------
// S4 @aart/governance seam — SEAMS.md "computePromotionState /
// evaluatePromotionForEnvironment" entry. `computeApprovalState` 2-arg form
// per this package's own injection brief. `PromotionRecord`'s field shape
// is explicitly NOT frozen anywhere (S4's own SEAMS.md note) — the shape
// below is copied verbatim from S4's documented "reasonable fill".
// `PromotionEvaluation`'s exact return shape for the refusal wrapper isn't
// spelled out in S4's SEAMS.md excerpt either; modeled here as a
// blocked/evaluated discriminated union, this package's own reasonable
// fill for THAT narrower gap — see SEAMS.md.
// ---------------------------------------------------------------------------

export type ComputeApprovalStateFn = (gates: Gates, requiredGatesForMode: readonly GateName[]) => ApprovalState;

export interface PromotionRecord {
  environment: string;
  promoted: boolean;
  globalApproval: ApprovalState;
  requiredGates: readonly GateName[];
  unmetGates: readonly GateName[];
}
export type PromotionEvaluation = { kind: "blocked" } | { kind: "evaluated"; record: PromotionRecord };
export type EvaluatePromotionForEnvironmentFn = (params: {
  workflow: Pick<Workflow, "promotionBlocked">;
  globalApproval: ApprovalState;
  gates: Gates;
  requiredGatesForEnvironment: readonly GateName[];
  environment: string;
}) => PromotionEvaluation;

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

// ---------------------------------------------------------------------------
// The DI container every views/actions handler in this package receives.
// ---------------------------------------------------------------------------

export interface DashboardDeps {
  /** S4 @aart/governance's real redactRecord in production; an identity/never-invoked stub in dev — architecture §7.9. Secrets-status page (§35.3) and every report render route through this. */
  redact: RedactFn;

  clearRunFlag: ClearRunFlagFn;
  listFlaggedRuns: ListFlaggedRunsFn;

  triggerRun: TriggerRunFn;

  computeApprovalState: ComputeApprovalStateFn;
  evaluatePromotionForEnvironment: EvaluatePromotionForEnvironmentFn;
  /** architecture §7.3's trust-mode→required-gates table. Not itself given a literal value by either source doc for this session to cite verbatim; mirrors S2's own observed `REQUIRED_GATES_BY_TRUST_MODE` constant (itself flagged there as a mirror of S4's table) — see SEAMS.md. */
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
