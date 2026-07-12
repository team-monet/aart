// ApprovalTask, StandingApproval — spec §13.5, §17.6.
import { z } from "zod";

export const ApprovalTaskSchema = z.object({
  id: z.string(),
  runId: z.string(),
  stepId: z.string(),
  title: z.string(),
  description: z.string(),
  // ApprovalTask.status is a task-level lifecycle (one human decision on one
  // run step) — a different entity from the workflow-version-level
  // ApprovalState (governance.ts, spec §17.1). Do not conflate: a task can
  // be "rejected" on a workflow version that remains "approved" overall.
  status: z.enum(["pending", "approved", "rejected", "needs_changes", "expired"]),
  reviewer: z.string().optional(),
  decision: z.unknown().optional(),
  createdAt: z.string(),
  decidedAt: z.string().optional(),
  // D2a security hardening, token-derived attribution (AMENDMENTS.md A59) —
  // additive optional, same pattern as A56's Deployment.promoted: WHICH
  // configured deploy token (by label — "mechanical half," named per-token
  // identities are deferred) authenticated the HTTP request that decided
  // this task, when one did. Undefined for every pre-D2a row, every
  // tokenless/local decision, and every decision made when the token was
  // unconfigured — "unset" means "no attribution available," never
  // "definitely anonymous." Distinct from, and does not replace, the
  // existing free-text `reviewer` field above (a human name/identity the
  // caller supplies) — this is a SEPARATE, server-derived signal of which
  // credential authenticated the write, kept for the tokenless-local case
  // and backward compatibility.
  authenticatedAs: z.string().optional(),
});
export type ApprovalTask = z.infer<typeof ApprovalTaskSchema>;

export const StandingApprovalSchema = z.object({
  // Spec §17.6's TS block types the policy shape only (maxRiskTier through
  // expiresAt below) with no `id` field. Architecture §5's AartStore
  // extension (A32/G6 fix) adds `standingApprovals: StandingApprovalStore`,
  // "keyed by id" (§5's one-line contract) — architecture's own §5.3 SQL
  // table backs this with `standing_approvals (id PK, ...)`. `id` is added
  // here so the type the store persists can actually be keyed as
  // architecture requires; spec's own type has no stored-entity identity
  // concept since it doesn't model StandingApproval as an AartStore member
  // at all. See AMENDMENTS.md.
  id: z.string(),
  maxRiskTier: z.string(),
  capabilities: z.array(z.string()),
  grantedBy: z.string(),
  expiresAt: z.string(),
});
export type StandingApproval = z.infer<typeof StandingApprovalSchema>;
