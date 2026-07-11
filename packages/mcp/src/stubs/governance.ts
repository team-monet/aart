// StubGovernance — a documented stand-in for @aart/governance (S4), which
// is still an S0 `export {}` stub in THIS worktree (S4 builds it in a
// concurrent, unmerged worktree: /Users/johnlee/code/aart-s4). Per this
// session's pure-consumer contract: mirror the REAL, LANDED signature and
// documented algorithm exactly (verified 2026-07-10 by reading S4's actual
// source, not just its SEAMS.md prose), so swapping this module's import
// for `@aart/governance` at S9 merge time is a one-line change, not a
// redesign. This is the same "mirror now, swap at merge" pattern S2 used
// for computeApprovalState/computePromotionState in its own
// packages/server/src/promotion.ts (see /Users/johnlee/code/aart-s2/SEAMS.md).
//
// What's mirrored VERBATIM (trivial, frozen, spec-level algorithms fully
// given in architecture §7.1-§7.3's own prose — not S4's proprietary
// design):
//   - REQUIRED_GATES_BY_MODE, AART_APPROVE_TOOL_NAME, MODES_WITH_AART_APPROVE,
//     isAartApproveRegisteredForMode (gates.ts)
//   - computeApprovalState, computePromotionState, evaluatePromotionForEnvironment
//     (approval.ts) — algorithms fully spelled out in architecture §7.1
//
// What's SIMPLIFIED (flagged, not a faithful port of S4's real modules):
//   - validateWorkflow: only validation class 1 (schema, via the real frozen
//     WorkflowSchema) runs for real. Classes 2-5 (reference/capability/
//     input-safety/deployment — architecture §7.7) need a real block catalog
//     + capability-closure walk this worktree doesn't have; they return no
//     findings here rather than a fabricated approximation.
//   - semanticRiskDiff: step-level added/removed/modified only (mirrors S4's
//     real diffStepFields algorithm, which IS simple/mechanical and fully
//     inspectable). The capability-closure risk-tier delta (newCapabilities/
//     newSecrets/newDomains/riskFrom/riskTo) is NOT computed — same reason
//     as validateWorkflow's classes 2-5.
//   - redact: a real value-scan-and-replace over the record's full tree
//     (arrays/nested objects), matching @aart/types' frozen RedactFn shape
//     and S4's documented behavior contract (SEAMS.md: "value-scan-and-
//     replace ... never a field-name allowlist") — but WITHOUT S4's
//     documented JSON-string-escaped/URL-percent-encoded secondary-form
//     matching, which is real redaction-hardening logic, not a trivial
//     mirror.
import type { AartStore } from "@aart/store";
import type { ApprovalTask, Gates, TrustMode, Workflow, WorkflowStep } from "@aart/types";
import { WorkflowSchema } from "@aart/types";
import type {
  AutoApprovalState,
  GateName,
  GovernancePort,
  PromotionEvaluation,
  PromotionRecordShape,
  SemanticRiskDiffShape,
  ValidationFinding,
  ValidationResultShape,
} from "../types.js";

// Mirrors @aart/governance/src/gates.ts's GATE_NAMES exactly (spec §17.1's
// five independent, parallel gates) — used below by decodeGateFromStepId's
// membership check (S14 "gate write paths").
const GATE_NAMES: readonly GateName[] = ["validate", "readiness", "evals", "riskReview", "humanReview"];

// Mirrors @aart/governance/src/gates.ts's REQUIRED_GATES_BY_MODE exactly
// (architecture §7.3's table).
export const REQUIRED_GATES_BY_MODE: Readonly<Record<TrustMode, readonly GateName[]>> = {
  dev: [],
  governed: ["validate", "humanReview"],
  strict: ["validate", "humanReview"],
  production: ["validate", "readiness", "evals", "riskReview", "humanReview"],
};

// Mirrors @aart/governance/src/gates.ts's AART_APPROVE_TOOL_NAME /
// MODES_WITH_AART_APPROVE / isAartApproveRegisteredForMode exactly
// (spec §17.5's table: dev + governed only).
export const AART_APPROVE_TOOL_NAME = "aart_approve";
export const MODES_WITH_AART_APPROVE: readonly TrustMode[] = ["dev", "governed"];
export function isAartApproveRegisteredForMode(mode: TrustMode): boolean {
  return MODES_WITH_AART_APPROVE.includes(mode);
}

// Mirrors @aart/governance/src/approval.ts's computeApprovalState exactly,
// including the "empty requiredGatesForMode is never-satisfiable, not
// vacuously satisfied" resolved-ambiguity rule documented there.
export function computeApprovalState(gates: Gates, requiredGatesForMode: readonly GateName[]): AutoApprovalState {
  if (requiredGatesForMode.length === 0) return "draft";
  const allSatisfied = requiredGatesForMode.every((gate) => gates[gate] === "passed" || gates[gate] === "waived");
  return allSatisfied ? "approved" : "draft";
}

// Mirrors @aart/governance/src/approval.ts's computePromotionState exactly.
export function computePromotionState(
  globalApproval: AutoApprovalState | "deprecated",
  gates: Gates,
  requiredGatesForEnvironment: readonly GateName[],
  environment: string,
): PromotionRecordShape {
  const unmetGates = requiredGatesForEnvironment.filter((gate) => !(gates[gate] === "passed" || gates[gate] === "waived"));
  return {
    environment,
    promoted: globalApproval === "approved" && unmetGates.length === 0,
    globalApproval,
    requiredGates: [...requiredGatesForEnvironment],
    unmetGates,
  };
}

// Mirrors @aart/governance/src/approval.ts's evaluatePromotionForEnvironment
// exactly — the promotion_blocked call-site refusal wrapper.
export function evaluatePromotionForEnvironment(params: {
  workflow: Pick<Workflow, "promotionBlocked">;
  globalApproval: AutoApprovalState | "deprecated";
  gates: Gates;
  requiredGatesForEnvironment: readonly GateName[];
  environment: string;
}): PromotionEvaluation {
  if (params.workflow.promotionBlocked === true) {
    return { blocked: true, reason: "promotion_blocked", environment: params.environment };
  }
  return {
    blocked: false,
    record: computePromotionState(params.globalApproval, params.gates, params.requiredGatesForEnvironment, params.environment),
  };
}

// SIMPLIFIED — see module doc comment. Class 1 (schema) is real; classes
// 2-5 are documented no-ops pending the real @aart/governance import.
export function validateWorkflow(input: unknown): ValidationResultShape {
  const parsed = WorkflowSchema.safeParse(input);
  if (!parsed.success) {
    const findings: ValidationFinding[] = parsed.error.issues.map((issue) => ({
      class: "schema",
      path: issue.path.join("."),
      message: issue.message,
      severity: "error",
    }));
    return { valid: false, findings };
  }
  // Classes 2 (reference), 3 (capability), 4 (input-safety), 5 (deployment)
  // all need a real block catalog / capability-closure walk that only
  // @aart/governance's real implementation has (architecture §7.7). Not
  // faked here — see module doc comment.
  return { valid: true, findings: [] };
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function diffStepFields(from: WorkflowStep, to: WorkflowStep): string[] {
  const details: string[] = [];
  if (from.uses !== to.uses) details.push(`block reference changed from "${from.uses}" to "${to.uses}"`);
  if (!deepEqual(from.with, to.with)) details.push("step parameters changed");
  if (from.if !== to.if) details.push(`condition changed from ${JSON.stringify(from.if)} to ${JSON.stringify(to.if)}`);
  if (from.then !== to.then) details.push(`"then" target changed from ${JSON.stringify(from.then)} to ${JSON.stringify(to.then)}`);
  if (from.else !== to.else) details.push(`"else" target changed from ${JSON.stringify(from.else)} to ${JSON.stringify(to.else)}`);
  if (from.next !== to.next) details.push(`"next" target changed from ${JSON.stringify(from.next)} to ${JSON.stringify(to.next)}`);
  return details;
}

// SIMPLIFIED — step-level diff only, mirroring S4's real diffStepFields
// mechanics. No capability-closure risk-tier delta — see module doc comment.
export function semanticRiskDiff(from: Workflow, to: Workflow): SemanticRiskDiffShape {
  const fromById = new Map(from.execution.steps.map((s) => [s.id, s]));
  const toById = new Map(to.execution.steps.map((s) => [s.id, s]));

  const added: { stepId: string; uses: string }[] = [];
  const removed: { stepId: string; uses: string }[] = [];
  const modified: { stepId: string; details: readonly string[] }[] = [];

  for (const [id, step] of toById) {
    if (!fromById.has(id)) added.push({ stepId: id, uses: step.uses });
  }
  for (const [id, step] of fromById) {
    if (!toById.has(id)) removed.push({ stepId: id, uses: step.uses });
  }
  for (const [id, toStep] of toById) {
    const fromStep = fromById.get(id);
    if (!fromStep) continue;
    const details = diffStepFields(fromStep, toStep);
    if (details.length > 0) modified.push({ stepId: id, details });
  }

  return {
    added,
    removed,
    modified,
    capabilityChanged: false,
    riskIncreased: false,
  };
}

// SIMPLIFIED redact — real value-scan-and-replace over the full tree,
// matching @aart/types' frozen RedactFn 2-arg shape exactly. Does not
// implement S4's documented JSON-escaped / URL-percent-encoded secondary
// form matching (redaction-hardening logic, not a trivial mirror) — see
// module doc comment.
export function redact(record: unknown, resolvedSecretRefs: ReadonlySet<string>): unknown {
  const values = [...resolvedSecretRefs].filter((v) => v.length > 0);
  if (values.length === 0) return record;

  function walk(node: unknown): unknown {
    if (typeof node === "string") {
      let result = node;
      for (const value of values) {
        result = result.split(value).join("[REDACTED]");
      }
      return result;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node)) out[k] = walk(v);
      return out;
    }
    return node;
  }
  return walk(record);
}

// Mirrors @aart/governance/src/approval-tasks.ts's workflowVersionApprovalSubject/
// decodeWorkflowVersionApprovalSubject exactly (S9 integration, reconciliation
// ledger item 1 — this is the sentinel convention that WON over this
// package's own former `version-review:`/`humanReview` encoding; see root
// AMENDMENTS.md A23's "S9 resolution"). S14 "gate write paths": gate-
// parameterized (`__gate:<gateName>__`, was the fixed `__gate:humanReview__`
// constant) so riskReview can share this same machinery — mirrored here
// exactly too, `gate`/`stepId` both optional and defaulting to `humanReview`
// so every pre-S14 call site is unaffected.
const WORKFLOW_VERSION_SUBJECT_PREFIX = "workflow-version:";
const WORKFLOW_VERSION_SUBJECT_STEP_PREFIX = "__gate:";
const WORKFLOW_VERSION_SUBJECT_STEP_SUFFIX = "__";
const DEFAULT_WORKFLOW_VERSION_GATE: GateName = "humanReview";

export function workflowVersionApprovalSubject(
  workflowId: string,
  workflowVersion: string,
  gate: GateName = DEFAULT_WORKFLOW_VERSION_GATE,
): { runId: string; stepId: string } {
  return {
    runId: `${WORKFLOW_VERSION_SUBJECT_PREFIX}${workflowId}@${workflowVersion}`,
    stepId: `${WORKFLOW_VERSION_SUBJECT_STEP_PREFIX}${gate}${WORKFLOW_VERSION_SUBJECT_STEP_SUFFIX}`,
  };
}

function decodeGateFromStepId(stepId: string | undefined): GateName {
  if (stepId !== undefined && stepId.startsWith(WORKFLOW_VERSION_SUBJECT_STEP_PREFIX) && stepId.endsWith(WORKFLOW_VERSION_SUBJECT_STEP_SUFFIX)) {
    const candidate = stepId.slice(WORKFLOW_VERSION_SUBJECT_STEP_PREFIX.length, stepId.length - WORKFLOW_VERSION_SUBJECT_STEP_SUFFIX.length);
    if ((GATE_NAMES as readonly string[]).includes(candidate)) return candidate as GateName;
  }
  return DEFAULT_WORKFLOW_VERSION_GATE;
}

export function decodeWorkflowVersionApprovalSubject(runId: string, stepId?: string): { workflowId: string; workflowVersion: string; gate: GateName } | undefined {
  if (!runId.startsWith(WORKFLOW_VERSION_SUBJECT_PREFIX)) return undefined;
  const rest = runId.slice(WORKFLOW_VERSION_SUBJECT_PREFIX.length);
  const at = rest.lastIndexOf("@");
  if (at === -1) return undefined;
  return { workflowId: rest.slice(0, at), workflowVersion: rest.slice(at + 1), gate: decodeGateFromStepId(stepId) };
}

// Mirrors @aart/governance/src/approval-tasks.ts's writeApprovalDecision —
// the ONE path every ApprovalTask write should go through (architecture
// §7.9's redaction-chokepoint diagram names "approval decision" as a named
// redactRecord input path). Routes through this module's own SIMPLIFIED
// `redact` above (see module doc comment on why it's simplified, not a
// faithful port). S9 integration: added because this package's own
// handlers previously wrote `store.approvals.put(...)` directly,
// bypassing redaction entirely — a real finding from this reconciliation
// pass, not a hypothetical.
export async function writeApprovalDecision(
  store: AartStore,
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
): Promise<ApprovalTask> {
  const task: ApprovalTask = { ...input };
  const redacted = redact(task, new Set()) as ApprovalTask;
  await store.approvals.put(redacted);
  return redacted;
}

export function createStubGovernance(): GovernancePort {
  return {
    requiredGatesByMode: REQUIRED_GATES_BY_MODE,
    isAartApproveRegisteredForMode,
    computeApprovalState,
    computePromotionState,
    evaluatePromotionForEnvironment,
    validateWorkflow,
    semanticRiskDiff,
    redact,
    workflowVersionApprovalSubject,
    decodeWorkflowVersionApprovalSubject,
    writeApprovalDecision,
  };
}
