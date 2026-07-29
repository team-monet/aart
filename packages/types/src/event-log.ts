// EventLogEntry — V1 event log foundation (AMENDMENTS.md A61), the spine
// the activity feed + live-updates features depend on. Architecture-
// introduced via the amendment protocol (types.ts's own header comment on
// `AartStore`: "a Wave-1 session that needs one more query method adds it
// through the amendment protocol... which is the intended path"), same
// "no spec anchor, full architecture-introduced type" provenance
// store-records.ts's own `RejectedTrigger` already established (that
// file's header: "architecture-introduced in full... no spec anchor at
// all"). Given its own file rather than folded into store-records.ts —
// that file's header comment enumerates exactly eight named types
// ("Deployment, Environment, Schedule, PromptRegistryEntry,
// SchemaRegistryEntry, PackManifest, Correction, RejectedTrigger"); adding
// a ninth would falsify that count the same way AartStore's own "16
// members" header would go stale if left unedited by this same change.
//
// `type` is DELIBERATELY a plain string, not a closed zod enum — the write
// sites across every real composition root (CLI/MCP/dashboard, per
// AMENDMENTS.md A61's own write-site enumeration) use a fixed vocabulary
// today (`workflow.version_registered`, `workflow.validated`,
// `workflow.gate_passed`/`gate_failed`, `workflow.approved`/`deprecated`,
// `run.started`/`completed`/`failed`/`cancelled`, `approval.requested`/
// `decided`, `correction.recorded`, `eval.suite_created`/`run_completed`,
// `deployment.created`/`promoted`/`pushed`) but that vocabulary is a VALUE
// SET this session's own write sites populate, not a schema-level
// constraint — a future Wave-2 event type (e.g. `deployment.pushed`,
// explicitly deferred by this session, AMENDMENTS.md A61) must not require
// another S0-style frozen-type amendment just to add a string literal.
//
// Every correlation field is optional and independent — an entry carries
// whichever subset of (workflowId, workflowVersion, runId, deploymentId,
// environmentId, approvalTaskId, actor) is actually known at its write
// site (e.g. a `run.started` event has no `approvalTaskId`; an
// `approval.requested` event for a workflow-version-level review has no
// `runId` at all — ApprovalTask's own `runId`/`stepId` pair is sometimes a
// governance-owned sentinel encoding rather than a genuine run, see
// `@aart/governance`'s `decodeWorkflowVersionApprovalSubject`). None of
// this schema's fields is a foreign key the store enforces referentially —
// this is an audit/observability record, not a join target.
import { z } from "zod";

export const EventLogEntrySchema = z.object({
  id: z.string(),
  /** A dotted-namespace string (e.g. "run.completed") — the value set, not a closed enum. See this module's own header comment for why. */
  type: z.string(),
  /** ISO 8601 timestamp. */
  occurredAt: z.string(),
  /** A short human string (e.g. "invoice-scan@0.3.0 passed validate"). Write sites avoid resolved values; if a later execution nevertheless identifies matching text as secret, EventLogStore's security rewrite redacts this presentation field without changing the event fact. */
  summary: z.string(),
  workflowId: z.string().optional(),
  workflowVersion: z.string().optional(),
  runId: z.string().optional(),
  deploymentId: z.string().optional(),
  environmentId: z.string().optional(),
  approvalTaskId: z.string().optional(),
  actor: z.string().optional(),
});
export type EventLogEntry = z.infer<typeof EventLogEntrySchema>;
