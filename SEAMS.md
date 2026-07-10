# Seams

Protocol (implementation plan `aart_implementation_plan_v1.md` §7): distinct from `AMENDMENTS.md` (which is for *changing* an already-frozen interface). This file is for *new* interfaces being published early during Wave 1 — the moment a session defines something a sibling session will consume, even in draft form, even before that session's own package is otherwise finished, it gets an entry here. Named examples from the plan: S4's `redactRecord(record, resolvedSecretRefs)` signature (published early per S4's own DoD note); S1's `getDueWaits(now)` export for S2's ticker to call.

Consuming sessions check this file **before** proposing a shape themselves — "check `SEAMS.md`, then S0's frozen `@aart/types`/`@aart/expr`/`@aart/store`, then ask" is the intended order, never "propose and hope it converges."

Scaffolded empty by S0 (Wave 0 "Foundation") alongside `AMENDMENTS.md`. S0's own output is the frozen baseline every Wave-1 session starts from (`@aart/types`, `@aart/expr`, `@aart/store`'s interface — tagged `interfaces-frozen-v0`) — that baseline doesn't need entries here, since it isn't a mid-Wave-1 seam between two concurrent sessions, it's the starting line. The first real entries in this file will come from Wave 1.

---

## 2026-07-11 — S8 Dashboard

`@aart/dashboard` is a leaf consumer (architecture: "a client of nearly everyone else's output"), so this entry is mostly the reverse of the usual seam entry — not "here's what to code against," but "here's exactly what this package expects from S2/S4/S6, and the genuine gaps found while building against their published (or, in two cases, observed-but-unpublished) seams." **S9 and each named sibling should read the gap list below before reconciling.**

### What this package needs from S2 (`@aart/server`) — confirmed, no new asks

Built directly against S2's own SEAMS.md HTTP route list and `flags.ts`/`worker/health.ts` (read from the S2 sibling worktree to confirm exact behavior). `ApiClient` (`packages/dashboard/src/api-client.ts`) matches every route 1:1 — no route this package needs is undocumented on S2's side. One possible future enrichment, not a blocker: `GET /workflows` currently returns bare `{ workflowIds: string[] }`; the Workflows detail page (`/workflows/:id`) has to fall back to a direct `store.workflows.getLatest()` read for name/version/approval/gates since there's no richer HTTP shape yet. Not requesting a change — flagging in case S2/S9 want to enrich that route later.

### `correctionKey` — now identical to S6's real convention (see report for the bug this caught)

`views/corrections.ts`'s `correctionKey(correction)` = `${runId}:${stepId}:${fieldPath}` (no timestamp), matching `packages/evidence/src/corrections/correction.ts`'s own `correctionKey` EXACTLY (read directly from the S6 sibling worktree, not from SEAMS.md — S6's own E4 entry doesn't call this helper out by name even though the file it lives in is cited). Recorded here so if either package's format ever changes, the other needs to change too — **please flag here if `correctionKey`'s shape moves**, don't let the two drift silently.

### Two gap-fills this package authored — no sibling has a published owning function for these writes

Both route the actual POLICY decision through the real injected S4 functions (`computeApprovalState`, `evaluatePromotionForEnvironment`) — only the fetch+persist glue is local to this package:

- **`approveOrDeprecateWorkflow(store, workflowId, version, action, requiredGatesForMode)`** (`deps.ts`/`stub-deps.ts`) — no sibling publishes a function that actually WRITES `Workflow.approval` (S4's `computeApprovalState` is pure, returns a value, never persists). `action: "approve"` recomputes via `computeApprovalState` and persists; `action: "deprecate"` sets `"deprecated"` directly (not derivable from gates at all — an explicit human retiring a version).
- **`promoteWorkflowVersionToEnvironment(store, params)`** (`deps.ts`/`stub-deps.ts`) — S2's own `packages/server/src/promotion.ts` has a function of this exact name doing this exact job (read from the S2 sibling worktree), but it is **not** published in S2's own SEAMS.md entry. This package's version is a close mirror (same not_promoted/blocked/promoted result shape, same Deployment-create-or-refresh behavior) but internally calls the REAL seam (`evaluatePromotionForEnvironment`, S4's refusal wrapper) rather than S2's own local mirror of it. **At S9 merge:** reconcile these two — most likely S2's real `promoteWorkflowVersionToEnvironment` becomes the one true implementation and this package's DI slot just binds to it.

### `runEvalSuite` — bound to S6's real, already-landed function (not yet SEAMS-published)

`packages/evidence/src/evals/run-suite.ts` exports a fully real, non-stub `runEvalSuite(suite, options)` (read directly from the S6 sibling worktree) — this package's `deps.ts`/`stub-deps.ts` mirrors its exact signature (`execute`/`scorers`/`workflowId`/`workflowVersion`/`reportArtifact`, same aggregation algorithm) since S6's own SEAMS.md E1-E6 entries don't call this export out by name even though E2 cites the same scorer-registry file it depends on. **Flagging for S6:** worth a SEAMS.md entry of its own, since S8 isn't the only plausible consumer (S3's `eval.run` block is named in `run-suite.ts`'s own header comment as another one).

### Honest, unimplemented gaps (v1 pages) — no fabricated data

- **Blocks page** (`/blocks`) — no data source exists at all: block catalogs live in `@aart/blocks-core` (S3), a compiled-in registry, not `AartStore` data, and no S2 HTTP route is published for it either.
- **Packs page** (`/packs`) — `AartStore`'s `PackManifestStore` only supports `listVersions(name)` for an *already-known* name (see `packages/store/src/types.ts`); there is no "list every known pack" method, and no S2 HTTP route is published for one. Not proposing an `AartStore` change unilaterally (that would need an `AMENDMENTS.md` entry and isn't this package's call to make alone) — flagging the gap instead.

Both render a clearly-labeled "pending integration" page (`views/blocks-packs.ts`) rather than synthesizing fake data.

### `resumeApproval` stub — honestly scoped to the atomic claim only

This package's `resumeApproval` (backing "approve human tasks", §35.2) performs the documented dedupe-protected atomic claim (architecture §4.4.2's direct-lookup extension: `AartStore.runs.hasDedupeKey`/`recordDedupeKey` inside one `transact()`) and a minimal run-state update (`status -> "running"`, resolved wait removed) — it deliberately does **not** re-derive `step.if`/`then`/`else`/`next` and run the step-loop forward, which is the real bound `Engine.resumeApproval`'s job (S1). Swaps for the real one at S9 merge with zero call-site change (same `(runId, stepId, task) => Promise<ResumeOutcome>` shape, S1's Seam 1/4).

### This package's own HTTP surface, for whoever wires topology at S9

`@aart/dashboard` is its own standalone `node:http` server (`startDashboard(config)`, default port 4000 — distinct from S2's control-plane 8080 and worker health's 8787), reading via an injected `ApiClient` (real implementation is a plain `fetch` client against a live `aart server`) and writing via the `DashboardDeps` DI container documented in `deps.ts`. Full route list (all in `server.ts`): `GET /`, `/health`, `/runs[/:id][/trigger]`, `/workflows[/:id][/approve|/promote|/risk-diff|/block-promotion|/unblock-promotion|/mark-needs-review|/clear-needs-review|/trigger-improvement]`, `/blocks`, `/packs`, `/artifacts`, `/waiting-runs`, `/approvals[/:id/decision]`, `/corrections[/new][/:key/update-run-output|/create-eval-example|/create-issue]`, `/evals[/new][/suites|/runs]`, `/environments`, `/deployments`, `/trigger-configs`, `/secrets`, `/worker-health`, `/flagged-runs[/:runId/clear]`. Not mounted into S2's reserved `/dashboard/*` path (S2's own SEAMS.md note: "S8's own content is not implemented here") — that wiring, if wanted, is S9's to do.
