// @aart/governance — approval/gates lifecycle, trust modes, approval
// summary, semantic risk diff, capability/risk-closure computation,
// standing approvals, the full 5-class validation engine with
// errors-as-corrections, the single redaction chokepoint plus its
// bypass-detection lint, and pack approval-gate wiring. Architecture §7
// (full section), spec §16.2-16.3/§17/§18/§31.
//
// See SEAMS.md (repo root) for this package's cross-session-consumed
// exports (`redactRecord`, `checkCapability`, `computePromotionState`) and
// AMENDMENTS.md for the design gaps this package had to fill where neither
// source document gave an exact shape.

// ---------------------------------------------------------------------------
// Gates / trust modes — architecture §7.2/§7.3, spec §17.1/§17.2/§17.5
// ---------------------------------------------------------------------------
export {
  AART_APPROVE_TOOL_NAME,
  GATE_NAMES,
  MODES_WITH_AART_APPROVE,
  REQUIRED_GATES_BY_MODE,
  isAartApproveRegisteredForMode,
  type GateName,
} from "./gates.js";

// ---------------------------------------------------------------------------
// Approval state machine + per-environment promotion — architecture §7.1, ADR-07
// ---------------------------------------------------------------------------
export {
  computeApprovalState,
  computePromotionState,
  evaluatePromotionForEnvironment,
  type AutoApprovalState,
  type PromotionEvaluation,
  type PromotionRecord,
} from "./approval.js";

// ---------------------------------------------------------------------------
// The normal ApprovalTask write path — architecture §7.1/§7.2/§7.5
// ---------------------------------------------------------------------------
export {
  decodeWorkflowVersionApprovalSubject,
  recordPrMergeApproval,
  recordStandingApprovalDecision,
  workflowVersionApprovalSubject,
  writeApprovalDecision,
  type GithubMergeEventPayload,
  type RecordStandingApprovalDecisionInput,
  type WriteApprovalDecisionInput,
} from "./approval-tasks.js";

// ---------------------------------------------------------------------------
// Capability model, risk-from-closure, the real CapabilityCheck
// implementation, and the granted-capabilities policy query —
// architecture §4.6/§7.4, spec §31.0-31.1, ADR-09
// ---------------------------------------------------------------------------
export {
  RISK_TIERS,
  checkCapability,
  compareRiskTiers,
  computeCapabilityClosure,
  getGrantedCapabilities,
  maxRiskTier,
  normalizeEnvironmentTrustMode,
  riskForCapability,
  type CapabilityClosureLookup,
  type CapabilityClosureNode,
  type CapabilityClosureResult,
  type GrantedCapabilitiesInput,
  type RiskTier,
} from "./capability.js";
export { isRiskTierName } from "./risk-tiers.js";

// ---------------------------------------------------------------------------
// Standing approvals — architecture §7.5, spec §17.6
// ---------------------------------------------------------------------------
export { findMatchingStandingApproval, type StandingApprovalMatchInput } from "./standing-approvals.js";

// ---------------------------------------------------------------------------
// Semantic risk diff — architecture §7.6, spec §17.4
// ---------------------------------------------------------------------------
export {
  renderSemanticRiskDiff,
  semanticRiskDiff,
  type SemanticRiskDiff,
  type StepAddedOrRemoved,
  type StepModified,
} from "./risk-diff.js";

// ---------------------------------------------------------------------------
// Approval summary renderer — spec §17.3
// ---------------------------------------------------------------------------
export {
  COVERED_WORKFLOW_FIELDS,
  COVERED_WORKFLOW_STEP_FIELDS,
  renderApprovalSummary,
  type ApprovalSummaryInput,
} from "./approval-summary.js";

// ---------------------------------------------------------------------------
// Trust-surface completeness — ADR-17 CI gate
// ---------------------------------------------------------------------------
export {
  checkWorkflowFieldCompleteness,
  checkWorkflowStepFieldCompleteness,
  type CompletenessResult,
} from "./trust-surface-completeness.js";

// ---------------------------------------------------------------------------
// Full 5-class validation engine with errors-as-corrections —
// architecture §7.7, spec §18, spec §32.2b
// ---------------------------------------------------------------------------
export {
  computeDidYouMean,
  findEffectfulStepsWithoutIdempotencyKey,
  isValid,
  levenshteinDistance,
  validateCapabilities,
  validateDeployment,
  validateInputSafety,
  validateReferences,
  validateSchema,
  validateWorkflow,
  type CapabilityValidationContext,
  type DeploymentValidationContext,
  type FullValidationResult,
  type ReferenceValidationContext,
  type TriggerConfigCheck,
  type ValidationClass,
  type ValidationContext,
  type ValidationFinding,
  type ValidationResult,
} from "./validation/index.js";

// ---------------------------------------------------------------------------
// The redaction chokepoint — architecture §7.9, ADR-10. `redactRecord`
// implements the frozen 2-arg RedactFn type from @aart/types EXACTLY.
// ---------------------------------------------------------------------------
export { redactRecord, redactRecordWithNames, type Replacement } from "./redact.js";

// ---------------------------------------------------------------------------
// Redaction-bypass lint / architecture test — ADR-10's consequences
// ---------------------------------------------------------------------------
export { lintRedactionBypass, lintSource, type RedactionLintFinding } from "./redaction-lint.js";

// ---------------------------------------------------------------------------
// Pack approval-gate wiring — spec §16.2-16.3 (S4 owns the gate; S7 owns
// pack import/hashing mechanics)
// ---------------------------------------------------------------------------
export {
  applyPackApprovalDecision,
  isPackSealBroken,
  writePackApprovalDecision,
  type PackApprovalDecisionInput,
  type PackApprovalStatus,
} from "./pack-approval.js";
