# Seams

Protocol (implementation plan `aart_implementation_plan_v1.md` §7): distinct from `AMENDMENTS.md` (which is for *changing* an already-frozen interface). This file is for *new* interfaces being published early during Wave 1 — the moment a session defines something a sibling session will consume, even in draft form, even before that session's own package is otherwise finished, it gets an entry here. Named examples from the plan: S4's `redactRecord(record, resolvedSecretRefs)` signature (published early per S4's own DoD note); S1's `getDueWaits(now)` export for S2's ticker to call.

Consuming sessions check this file **before** proposing a shape themselves — "check `SEAMS.md`, then S0's frozen `@aart/types`/`@aart/expr`/`@aart/store`, then ask" is the intended order, never "propose and hope it converges."

Scaffolded empty by S0 (Wave 0 "Foundation") alongside `AMENDMENTS.md`. S0's own output is the frozen baseline every Wave-1 session starts from (`@aart/types`, `@aart/expr`, `@aart/store`'s interface — tagged `interfaces-frozen-v0`) — that baseline doesn't need entries here, since it isn't a mid-Wave-1 seam between two concurrent sessions, it's the starting line. The first real entries in this file will come from Wave 1.

---

## 2026-07-10 — S2 Server

All exported from `@aart/server`'s package root (`packages/server/src/index.ts`) unless noted. Full context/rationale for each lives in the referenced source file's doc comments — this entry gives the exact signatures a consuming session needs to code against without reading the implementation.

### `@aart/cli`'s (S5) three composition-root entry points — architecture §1's "CLI commands delegate to @aart/server's production logic" note

```ts
async function startServer(config: ServerConfig): Promise<ServerHandle>
// packages/server/src/http/server.ts

async function startWorker(options: StartWorkerOptions): Promise<WorkerHandle>
// packages/server/src/worker/worker.ts

async function produceBundle(store: AartStore, params: ProduceBundleParams): Promise<Bundle>
async function writeBundleToDisk(bundle: Bundle, outDir: string): Promise<void>
// packages/server/src/bundle/bundle.ts
```

`aart server`/`aart worker`/`aart bundle` (spec §33.6-33.7, architecture §1) should each be a thin argument-parse-then-call — `@aart/cli` never reimplements ticker/claim/lease/closure logic itself. `ServerConfig`/`StartWorkerOptions`/`ProduceBundleParams` (all exported from `@aart/server`'s root) list every tunable (ports, intervals, admission-control caps, lease durations, secret resolver, etc.) with documented defaults in `packages/server/src/config.ts` — the CLI's own `--flag` surface should map onto these, not invent parallel ones. **Known gap blocking `--store=sqlite:<path>` specifically: see AMENDMENTS.md A18** — `@aart/store` doesn't yet export the SQLite adapter to sibling packages; that needs a small fix at the source (S9 or coordinator) before this wiring is possible.

### `EngineBoundary` — the seam S1's real engine must satisfy (or S9 must adapt) at integration time

```ts
// packages/server/src/engine/boundary.ts
interface EngineBoundary {
  startRun(params: StartRunParams): Promise<StartRunResult>;
  resumeWithSignal(signal: Signal): Promise<ResumeResult>;
  resumeDirect(runId: string, stepId: string, payload: unknown): Promise<ResumeResult>;
  getDueWaits(now: string): Promise<Array<{ runId: string; stepId: string; wait: WaitCondition }>>;
  executeClaimedRun(runId: string, workerId: string): Promise<void>;
}
type StartRunParams = { workflowId: string; workflowVersion?: string; trigger: Trigger; mappedInputs: Record<string, unknown>; dryRun?: boolean };
type StartRunResult = { kind: "started"; runId: string } | { kind: "queued"; runId: string } | { kind: "rejected"; reason: string };
type ResumeResult = { kind: "resumed"; runId: string } | { kind: "duplicate"; runId: string } | { kind: "no_match" } | { kind: "ambiguous"; matches: number };
```

This is **not** S1's own frozen export — it's this session's documentation of the shape implementation plan §3 describes S1 as owning (run-intake, `getDueWaits(now)` per architecture §4.4.3, claim execution), built so `@aart/server` had something concrete to code against while S1 ran concurrently. `createFakeEngine(store, clock): EngineBoundary` (same file) is the fake this session's own tests use — real `RunRecord`/`job_queue` writes, no step execution/wait-resume/capability-dispatch. **At S9 merge time**: reconcile S1's actual exported shape against this interface (the field/method names above, especially `getDueWaits(now)` which architecture names verbatim) and wire the real implementation into `startServer`'s/`startWorker`'s `config.engine`, replacing `createFakeEngine`. If S1's real signature differs, S9 either adapts a thin wrapper to this shape or both sessions converge on a shared one — this file records what S2 built against, not a unilateral freeze.

### `computeApprovalState` / `computePromotionState` — the seam S4's real governance package must satisfy (or S9 must adapt)

```ts
// packages/server/src/promotion.ts
function computeApprovalState(gates: Gates, requiredGatesForMode: GateKey[]): ApprovalState
function computePromotionState(globalApproval: ApprovalState, gates: Gates, requiredGatesForEnvironment: GateKey[], environment: Environment, clock?: Clock): PromotionRecord
const REQUIRED_GATES_BY_TRUST_MODE: Record<TrustMode, GateKey[]> // architecture §7.3's table
```

Same pattern as `EngineBoundary` above: architecture §7.1 documents these as pure functions owned by `@aart/governance` (S4); this session mirrors the documented contract locally (clearly flagged in the file's own header comment) so `promoteWorkflowVersionToEnvironment` (this session's own environment/deployment integration, same file) could be built and tested without a hard dependency on S4 landing first. **At S9 merge time**: replace this module's two functions with imports from `@aart/governance`'s real implementation at whichever composition root wires environments together — `promoteWorkflowVersionToEnvironment`'s own logic (the promotion_blocked check, the Deployment create/refresh) should not need to change, only its two pure-function calls.

### `clearRunFlag` — the flagged-run clear write path (architecture §4.1/§4.7/§6.2/§13.3)

```ts
// packages/server/src/flags.ts
async function clearRunFlag(store: AartStore, runId: string, clearedBy: string, clock?: Clock): Promise<ClearRunFlagResult>
// ClearRunFlagResult = { kind: "cleared"; run: RunRecord } | { kind: "not_found" } | { kind: "no_flag" }
async function listFlaggedRuns(store: AartStore): Promise<RunRecord[]>
```

For `@aart/cli` (S5, a CLI command) and `@aart/dashboard` (S8, the §13.3 flagged-runs view's clear action) to call directly. **Deliberately not exposed via HTTP for MCP consumption and MUST NOT be wired into any MCP tool** — architecture §13.3's stated exception to the three-client principle (un-flagging a poison/reclaim-exhausted run is a human judgment call). The HTTP route `POST /runs/:runId/flag/clear` (below) exists for dashboard/CLI's own use over HTTP, not as a general-purpose API S5 should register as an `aart_*` MCP tool.

### `@aart/server`'s HTTP API surface — for `@aart/dashboard` (S8)

Base: whatever `port` `startServer` was given (`ServerConfig.port`, default 8080). All bodies/responses JSON.

```
POST /webhooks/:bindingId              generic webhook ingress (HMAC-verified)
POST /webhooks/github/:bindingId       github ingress (HMAC-verified; PR-merge events routed to ApprovalTask decision instead of a new run)
POST /webhooks/slack/:bindingId        slack ingress (HMAC-verified if a secret is configured)
POST /approvals/:id/decision           body: { status, reviewer, decision? } -> { task, resume? }
POST /runs/:runId/resume               body: { stepId, payload? } -> ResumeResult
POST /runs/:runId/signal               body: { name, correlationId, payload? } -> ResumeResult
POST /runs/:runId/flag/clear           body: { clearedBy } -> ClearRunFlagResult  (dashboard/CLI only — see above)
GET  /health                           -> { status: "ok" }   (control-plane liveness; DISTINCT from the worker's own per-process /health below)
GET  /runs?status=&workflowId=         -> { runs: RunRecord[] }
GET  /runs/:id                         -> { run: RunRecord } | 404
GET  /waiting-runs                     -> { waits: Array<{runId,stepId,wait,createdAt}> }
GET  /flagged-runs                     -> { runs: RunRecord[] }
GET  /workflows                        -> { workflowIds: string[] }
GET  /environments                     -> { environments: Environment[] }
GET  /deployments                      -> { deployments: Deployment[] }
GET  /rejected-triggers                -> { rejected: RejectedTrigger[] }
GET  /dashboard/*                      RESERVED mount point — S8's own content is not implemented here (this session's DoD note: "S2 just needs to expose the mount point/API surface S8 will consume")
```

Route handlers live in `packages/server/src/http/server.ts`; the small hand-rolled router (`packages/server/src/http/router.ts`, no framework dependency) supports `:param` segments and a trailing `*` wildcard for the dashboard mount.

### `GET /health` — the WORKER's own endpoint (architecture ADR-16/§16), separate from the control-plane `/health` above

```ts
// packages/server/src/worker/health.ts — one instance per aart worker process, port = WorkerConfig.healthPort (default 8787)
type HealthPayload = { status: "ok"; claimedRuns: number; uptime: number; version: string }
```

This is what S8's "worker health" dashboard page polls, per-registered-worker (architecture §13.3).

### Trigger binding configuration — how S5/S8/S9 register a trigger for this session's adapters to consume

```ts
// packages/server/src/triggers/types.ts
interface TriggerBinding { id, type, workflowId, workflowVersion?, triggerMapping?, mode: "start"|"resume", webhookPath?, webhookHmacSecretRef?, cron?, timezone?, missedRunPolicy?, pollUrl?, pollIntervalMs?, pollCondition?, githubEvent?, dedupeHeaderName?, ... }
```

Sourced two ways (`packages/server/src/triggers/registry.ts`): (1) `schedule`-type bindings come directly from the already-frozen `Schedule` store member — no new persistence; (2) every other type is read out of `Deployment.triggerConfig` (a `TriggerBinding` object minus `id`/`type`/`workflowId`, which are filled from the `Deployment` row itself) via `loadTriggerBindingsFromDeployments(store)`. **This session does not own or build a CRUD/authoring surface for trigger configs** (spec's `aart trigger add` is `@aart/cli`'s command, S5) — whatever S5/S8 write into a `Deployment.triggerConfig` matching this shape, this session's adapters and HTTP routes will pick up and process correctly.
