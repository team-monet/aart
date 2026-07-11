// The normal ApprovalTask write path — architecture §7.1/§7.2/§7.5. Every
// approval decision (CLI/dashboard, PR-merge ingestion, standing-approval
// auto-pass) goes through `writeApprovalDecision`, satisfying architecture
// §7.2's "going through the exact same ApprovalTask write path as a
// CLI/dashboard decision" for PR-merge, and spec §17.6's "recorded exactly
// like a regular approval — same audit trail, same visibility" for standing
// approvals.
//
// architecture §7.9's redaction-chokepoint diagram explicitly lists
// "approval decision" as one of the named input paths into `redactRecord`
// (alongside step outputs / llm call metadata / external call metadata /
// artifact metadata / dashboard payload / MCP tool return values / engine
// StepTrace/RunRecord persist) — an ApprovalTask's free-form `decision`
// field can echo back arbitrary data (a corrected value, a synthetic
// merge-event payload), so this write path routes through the SAME
// `redactRecord` chokepoint every other persist path does, not a
// second/divergent one. `resolvedSecretRefs` defaults to an empty set for
// callers with no known secrets in scope (PR-merge/standing-approval
// synthetic decisions never touch a resolved secret), in which case
// `redactRecord` is a documented no-op (redact.test.ts).
import type { AartStore, Logger } from "@aart/store";
import type { ApprovalTask, StandingApproval } from "@aart/types";
import { GATE_NAMES, type GateName } from "./gates.js";
import { redactRecord } from "./redact.js";

export interface WriteApprovalDecisionInput {
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
}

/** S4's "normal approval-write function" (architecture §7.2's own phrase) — the one path every ApprovalTask write goes through, regardless of origin. Routes through the redaction chokepoint before persisting (architecture §7.9's diagram: "approval decision" is a named redactRecord input path). */
export async function writeApprovalDecision(
  store: AartStore,
  input: WriteApprovalDecisionInput,
  logger?: Logger,
  resolvedSecretRefs: ReadonlySet<string> = new Set(),
): Promise<ApprovalTask> {
  const task: ApprovalTask = { ...input };
  const redacted = redactRecord(task, resolvedSecretRefs) as ApprovalTask;
  await store.approvals.put(redacted);
  logger?.info("approval task written", { runId: redacted.runId, stepId: redacted.stepId, status: redacted.status });
  return redacted;
}

/**
 * `ApprovalTask`'s frozen shape (spec §13.5) is `runId`/`stepId`-keyed for a
 * per-run wait-type approval. A workflow-VERSION-level approval decision
 * (PR-merge ingestion satisfying the `humanReview` gate; a standing
 * approval's synthetic audit-trail task) decides something about a
 * VERSION's promotion eligibility before that version has necessarily ever
 * run — there is no real run/step to key off. Neither source document
 * resolves this identity gap (see AMENDMENTS.md); this sentinel-pair
 * convention is governance's own resolution, used consistently by every
 * workflow-version-level ApprovalTask writer in this module. A genuine
 * per-run `human.approval` wait's ApprovalTask always carries real
 * runId/stepId from the RunRecord/WorkflowStep that created the wait and
 * never goes through this helper.
 */
const WORKFLOW_VERSION_SUBJECT_PREFIX = "workflow-version:";
const WORKFLOW_VERSION_SUBJECT_STEP_PREFIX = "__gate:";
const WORKFLOW_VERSION_SUBJECT_STEP_SUFFIX = "__";
/** This sentinel's sole gate before S14 "gate write paths" — kept as the default so every pre-existing caller (recordPrMergeApproval, recordStandingApprovalDecision, the dashboard's single-arg decode call, every prior test) is byte-for-byte unaffected by the gate-parameterization below. */
const DEFAULT_WORKFLOW_VERSION_GATE: GateName = "humanReview";

/**
 * S14 "gate write paths": `stepId` is now gate-parameterized
 * (`__gate:<gateName>__`, was the fixed constant `__gate:humanReview__`) so
 * this SAME ApprovalTask machinery can also carry a `riskReview` decision —
 * spec §17.1's "each gate is advanced ONLY by its own mechanism" means
 * `riskReview`'s mechanism IS a human decision, exactly like `humanReview`'s,
 * just a different gate key; no new mechanism is introduced. `gate` defaults
 * to `humanReview`, so every 2-arg call site is unaffected.
 */
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

/** Decodes a `stepId` produced by `workflowVersionApprovalSubject` back to the `GateName` it encodes. Falls back to the documented default (never throws) for `undefined`, malformed, or unrecognized-gate input — including every pre-S14 sentinel, which was always the literal `"__gate:humanReview__"` and decodes correctly here too. */
function decodeGateFromStepId(stepId: string | undefined): GateName {
  if (stepId !== undefined && stepId.startsWith(WORKFLOW_VERSION_SUBJECT_STEP_PREFIX) && stepId.endsWith(WORKFLOW_VERSION_SUBJECT_STEP_SUFFIX)) {
    const candidate = stepId.slice(WORKFLOW_VERSION_SUBJECT_STEP_PREFIX.length, stepId.length - WORKFLOW_VERSION_SUBJECT_STEP_SUFFIX.length);
    if ((GATE_NAMES as readonly string[]).includes(candidate)) return candidate as GateName;
  }
  return DEFAULT_WORKFLOW_VERSION_GATE;
}

/**
 * The decode side of `workflowVersionApprovalSubject` above (S9 integration,
 * reconciliation ledger item 1 — added because a caller needs to recognize
 * "this ApprovalTask is a workflow-version-level decision, not a real
 * per-run wait" from a `runId` alone, e.g. `@aart/mcp`'s `aart_approve`
 * handler branching on which write path to take). Returns `undefined` for
 * any `runId` that isn't this sentinel shape (including a genuine per-run
 * `RunRecord.runId`, which never starts with this prefix — generated run
 * ids use a different convention, `ids.ts`). Splits on the LAST `@` (not
 * the first), matching `@aart/llm`'s `decodeResolvedVersion` precedent for
 * the same reason: defensive against a workflowId that itself happens to
 * contain `@`, even though `workflowVersion` (typically semver) practically
 * never does.
 *
 * S14: `stepId` is a new, OPTIONAL 2nd parameter — every existing 1-arg call
 * site (the dashboard's `decodeWorkflowVersionApprovalSubject(t.runId)`
 * chief among them) keeps working unchanged, decoding `gate: "humanReview"`
 * by default (`decodeGateFromStepId`'s documented fallback), which is
 * exactly what those call sites already assumed implicitly before this
 * field existed.
 */
export function decodeWorkflowVersionApprovalSubject(runId: string, stepId?: string): { workflowId: string; workflowVersion: string; gate: GateName } | undefined {
  if (!runId.startsWith(WORKFLOW_VERSION_SUBJECT_PREFIX)) return undefined;
  const rest = runId.slice(WORKFLOW_VERSION_SUBJECT_PREFIX.length);
  const at = rest.lastIndexOf("@");
  if (at === -1) return undefined;
  return { workflowId: rest.slice(0, at), workflowVersion: rest.slice(at + 1), gate: decodeGateFromStepId(stepId) };
}

export interface GithubMergeEventPayload {
  readonly workflowId: string;
  readonly workflowVersion: string;
  readonly mergedBy: string;
  readonly mergedAt: string;
  readonly pullRequestNumber: number;
  readonly pullRequestUrl?: string;
}

/**
 * PR-merge-as-decision write path (architecture §7.2, spec §26.2). The
 * trigger-side DETECTION of "this is a merge event on a PR tracked as a
 * pending workflow-version approval" is S2's (`@aart/server`'s `github`
 * trigger adapter) — this function is the resulting WRITE, tested here
 * with a synthetic merge-event payload, going through the exact same
 * `writeApprovalDecision` path as any CLI/dashboard decision.
 */
export async function recordPrMergeApproval(store: AartStore, payload: GithubMergeEventPayload, logger?: Logger): Promise<ApprovalTask> {
  const subject = workflowVersionApprovalSubject(payload.workflowId, payload.workflowVersion);
  return writeApprovalDecision(
    store,
    {
      id: `approval_pr_${payload.workflowId}_${payload.pullRequestNumber}`,
      ...subject,
      title: `PR #${payload.pullRequestNumber} merged`,
      description:
        payload.pullRequestUrl ??
        `Pull request #${payload.pullRequestNumber} merged for ${payload.workflowId}@${payload.workflowVersion}`,
      status: "approved",
      reviewer: payload.mergedBy,
      decision: { source: "github_pr_merge", pullRequestNumber: payload.pullRequestNumber },
      createdAt: payload.mergedAt,
      decidedAt: payload.mergedAt,
    },
    logger,
  );
}

export interface RecordStandingApprovalDecisionInput {
  readonly workflowId: string;
  readonly workflowVersion: string;
  readonly standingApproval: StandingApproval;
  readonly now: string;
}

/**
 * architecture §7.5 / spec §17.6: a standing-approval auto-pass is "recorded
 * exactly like a regular approval — same audit trail, same visibility —
 * just with a policy as its origin instead of a one-off human click." The
 * synthetic task's `decision` records WHICH standing approval matched, per
 * spec's explicit audit-trail requirement.
 */
export async function recordStandingApprovalDecision(
  store: AartStore,
  input: RecordStandingApprovalDecisionInput,
  logger?: Logger,
): Promise<ApprovalTask> {
  const subject = workflowVersionApprovalSubject(input.workflowId, input.workflowVersion);
  return writeApprovalDecision(
    store,
    {
      id: `approval_standing_${input.workflowId}_${input.workflowVersion}_${input.now}`,
      ...subject,
      title: "Standing approval auto-pass",
      description: `Auto-approved by standing approval granted by ${input.standingApproval.grantedBy} (expires ${input.standingApproval.expiresAt}).`,
      status: "approved",
      decision: {
        source: "standing_approval",
        standingApprovalId: input.standingApproval.id,
        grantedBy: input.standingApproval.grantedBy,
      },
      reviewer: input.standingApproval.grantedBy,
      createdAt: input.now,
      decidedAt: input.now,
    },
    logger,
  );
}
