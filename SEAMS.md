# Seams

Protocol (implementation plan `aart_implementation_plan_v1.md` §7): distinct from `AMENDMENTS.md` (which is for *changing* an already-frozen interface). This file is for *new* interfaces being published early during Wave 1 — the moment a session defines something a sibling session will consume, even in draft form, even before that session's own package is otherwise finished, it gets an entry here. Named examples from the plan: S4's `redactRecord(record, resolvedSecretRefs)` signature (published early per S4's own DoD note); S1's `getDueWaits(now)` export for S2's ticker to call.

Consuming sessions check this file **before** proposing a shape themselves — "check `SEAMS.md`, then S0's frozen `@aart/types`/`@aart/expr`/`@aart/store`, then ask" is the intended order, never "propose and hope it converges."

Scaffolded empty by S0 (Wave 0 "Foundation") alongside `AMENDMENTS.md`. S0's own output is the frozen baseline every Wave-1 session starts from (`@aart/types`, `@aart/expr`, `@aart/store`'s interface — tagged `interfaces-frozen-v0`) — that baseline doesn't need entries here, since it isn't a mid-Wave-1 seam between two concurrent sessions, it's the starting line. The first real entries in this file will come from Wave 1.

---

## 2026-07-10 — S1 Engine + durable execution

### Seam 1 — Scheduler-ticker seam: `getDueWaits` + wait-claim resume operations (architecture §4.4.3/§4.7)

**Consumer:** S2 (`@aart/server`'s worker/ticker loop).

S1 does **not** run the ticker loop itself (per its own DoD boundary) — it exports the queryable, correctly-claimable primitives S2's interval loop calls. Two forms are exported from `@aart/engine`, both from `packages/engine/src/index.ts`:

**Standalone functions** (no `Engine` instance needed — cheap to call from a lightweight ticker that doesn't want to hold a full block registry):
```ts
function getDueWaits(store: AartStore, now: Date): Promise<DueWait[]>
// DueWait = { runId: string; stepId: string; wait: Extract<WaitCondition, { type: "timer" }> }

function listExternalJobWaits(store: AartStore): Promise<Array<{ runId: string; stepId: string; wait: Extract<WaitCondition, { type: "external_job" }> }>>
```

**Scope note, load-bearing for S2:** `getDueWaits` is scoped to `timer`-type waits ONLY (it wraps `AartStore.waits.listDue`, which S0 built to filter on `resumeAt <= now` — `external_job` has no comparable deadline field on the frozen `WaitCondition` shape). For `external_job`'s poll sub-path (architecture §4.4.1), S2's poll mechanism should call `listExternalJobWaits(store)` to find every outstanding job-wait, poll each provider on its OWN interval/policy (S2's `poll` trigger logic, architecture §6.1), and call `resumeExternalJobResult` once a poll reports completion — there is no "due" concept for `external_job` the way there is for `timer`.

**Resume calls** S2's ticker makes once it identifies a due/completed wait (standalone functions, take an explicit `runId`/`stepId` — no `Engine` instance required for the claim step itself, but see Seam 4 below for how to actually CONTINUE execution afterward):
```ts
function resumeTimerWait(config: WaitMachineConfig, runId: string, stepId: string, resolvedSecretRefs?: ReadonlySet<string>): Promise<ResumeOutcome>
function resumeExternalJobResult(config: WaitMachineConfig, runId: string, stepId: string, resultPayload: unknown, resolvedSecretRefs?: ReadonlySet<string>): Promise<ResumeOutcome>
function resumeBySignal(config: WaitMachineConfig, signal: Signal, resolvedSecretRefs?: ReadonlySet<string>): Promise<ResumeOutcome>
function resumeManual(config: WaitMachineConfig, runId: string, stepId: string, payload?: unknown, resolvedSecretRefs?: ReadonlySet<string>): Promise<ResumeOutcome>
function resumeApproval(config: WaitMachineConfig, runId: string, stepId: string, task: { id: string; status: string; decision?: unknown; reviewer?: string }, resolvedSecretRefs?: ReadonlySet<string>): Promise<ResumeOutcome>

// ResumeOutcome =
//   | { kind: "resumed"; run: RunRecord; mechanism: ResumeMechanism }
//   | { kind: "duplicate"; mechanism: ResumeMechanism }
//   | { kind: "unmatched"; mechanism: ResumeMechanism }
```

**IMPORTANT — these standalone functions only perform the atomic CLAIM, they do NOT continue execution past the resumed step.** To actually advance the run to its next step (or its next wait/terminal status), call the SAME-NAMED method on a constructed `Engine` instance instead (`engine.resumeTimerWait(runId, stepId)` etc. — see Seam 4) — the `Engine`-bound versions wrap the standalone claim call and then run the step-loop forward. S2's ticker should use the `Engine`-bound methods in production; the standalone functions are exposed mainly for a caller that genuinely only wants the claim primitive (e.g. a lower-level test, or a future architecture where claim and continuation are split across processes).

**Wait-TIMEOUT-expiry sibling seam (architecture §4.4.1's "Expiry note") — a DIFFERENT terminal outcome from resume, S2's ticker should sweep this too, on the same interval:**
```ts
function getExpiredWaits(store: AartStore, now: Date): Promise<Array<{ runId: string; stepId: string; wait: WaitCondition }>>
function failExpiredWait(config: WaitMachineConfig, runId: string, stepId: string, resolvedSecretRefs?: ReadonlySet<string>): Promise<ResumeOutcome>
```
`getExpiredWaits` returns every outstanding wait carrying a `timeout` field (6 of the 7 `WaitCondition` members — `timer` has none) whose deadline (`WaitStore` row's `createdAt` + parsed `timeout` duration) has passed — this is DISTINCT from `getDueWaits` (which is `timer`-specific `resumeAt` due-ness). `failExpiredWait` is the SAME atomic-claim discipline as the resume mechanisms (mutually exclusive with them — whichever claims the wait row first wins) but marks the step `"failed"` instead of `"completed"`, and for an `approval` wait also sets the referenced `ApprovalTask.status = "expired"`. **Use `engine.getExpiredWaits(now?)`/`engine.failExpiredWait(runId, stepId)` (the `Engine`-bound versions) in production** — the bound `failExpiredWait` also finalizes the whole `RunRecord` as `"failed"` (snapshot capture, concurrency-queue release), which the standalone function alone does not do.

### Seam 2 — Wait-block-id vocabulary (architecture §4.4 step 1, spec §15.3)

**Consumer:** S3 (`@aart/blocks-core`'s `wait.*`/`human.approval` block implementations).

The engine recognizes exactly these 7 block ids as wait-triggering (a hardcoded, engine-owned mapping — NOT derived from any `BlockManifest` field, since the frozen manifest shape has no `type` discriminant):

```
wait.for_signal | wait.until | wait.for_webhook | wait.for_external_job | wait.for_queue | wait.manual | human.approval
```

**S3 MUST register its block implementations for these 7 ids under exactly these strings.** When the engine dispatches a step whose `uses` matches one of these ids, it does **not** call that block's `execute()` function at all — it intercepts before dispatch and runs its own wait-entry logic (`wait/wait-machine.ts`'s `enterWait`), constructing the `WaitCondition` directly from the step's resolved `with:` fields (see `wait/wait-blocks.ts`'s `buildWaitConditionFromBlock` for the exact field mapping per id — e.g. `wait.for_signal` reads `with.name`/`with.correlationId`/`with.timeout`). **Practical implication for S3:** these 7 blocks' `BlockManifest`s still need real, correct metadata (description, capability set — expected empty per spec §31.1's risk table, input/output schema) for the metadata-completeness test S3 owns, but their `execute` function is effectively dead code from the engine's dispatch perspective — S3 may still implement a reasonable `execute` (e.g. for direct unit testing in isolation) but should not assume the engine ever calls it.

`human.approval` additionally causes the engine to write an `ApprovalTask` row (via `AartStore.approvals.put`) itself, using `with.title`/`with.description` — S3's `human.approval` block manifest should declare `title`/`description` (and optional `timeout`) as its documented input shape to match.

**Signal-correlation convention for `queue`/`external_job` (architecture §4.4.1's early-arrival/signal-matching), consumed by whatever produces the `Signal` a `queue`/`external_job`-webhook-subpath wait resolves against:** since `WaitCondition`'s `queue`/`external_job` members have no literal `name` field, this session adopted (documented in `wait/wait-blocks.ts`'s `waitSignalCorrelation`): `queue`'s own `queue` field serves as the `Signal.name`-equivalent; `external_job`'s `provider` field serves as the name-equivalent and `jobId` as the `correlationId`-equivalent. **Whatever S2 trigger adapter/queue-consumer constructs the resolving `Signal` must populate `Signal.name`/`correlationId` to match this exact convention**, or correlation will silently never match.

### Seam 3 — Run-intake function (architecture §4.3)

**Consumer:** S2 (`@aart/server`'s trigger adapters — "trigger adapters call into the engine's run-intake function," per S2's own consumed-interfaces note in the implementation plan).

```ts
function triggerRun(config: EngineConfig, input: TriggerRunInput): Promise<RunRecord>
// same as the bound engine.triggerRun(input) — see Seam 4.

interface TriggerRunInput {
  workflow: Workflow
  trigger: Trigger
  inputs: Record<string, unknown>
  params?: Record<string, unknown>
  environment?: string          // see Seam 5's params.environment note
  approved?: boolean            // defaults true — a real composition root should pass governance's actual computed value
  approvalMode?: RunRecord["approvalMode"]  // defaults "dev"
}
```

Resolves the workflow's `concurrency` policy (see Amendment A16) BEFORE creating a `RunRecord`. Returns the created `RunRecord` (`status: "pending"`) on `allow`/`queue`/`cancel_existing`; **throws `ConcurrencyRejectedError`** on `reject_new` — S2 is expected to catch this and turn it into whatever rejected-trigger response/`rejected_triggers` record its own DoD requires (architecture §6.2 persistence is S2's scope, not this session's). `triggerRun` does **not** persist the `Workflow` itself — the caller (S2, at authoring/promotion time) is expected to have already called `store.workflows.put(workflow)`; `executeRun`/resume paths read it back via `store.workflows.get` for a run that hasn't captured a snapshot yet.

**`triggerRun` enqueues onto `AartStore.jobQueue` itself** (unless the run is held behind a `queue`-policy concurrency conflict) — S2's worker claims from `job_queue` as normal (`listClaimable`/`setClaim`/lease renewal/reclaim — all S2's own scope, architecture §4.7); S1 never touches claim/lease/release.

### Seam 4 — `createEngine(config): Engine` — the constructor-injection composition surface

**Consumer:** every composition root (S2/`@aart/server`, `@aart/cli`, `@aart/mcp`) that instantiates the engine for real; also `@aart/governance`(S4) for what it must supply.

```ts
function createEngine(config: EngineConfig): Engine

interface EngineConfig {
  store: AartStore                                   // from @aart/store — any adapter
  redact: RedactFn                                    // @aart/types — S4's real redactRecord in production; identityRedactFn (this package) in tests
  capabilityCheck: CapabilityCheck                    // @aart/types — S4's real implementation in production; alwaysAllowCapabilityCheck (this package) as the stub
  getGrantedCapabilities?: GetGrantedCapabilities      // (workflow, environment) => string[] | Promise<string[]> — NOT a frozen type, this package's own DI seam pairing with capabilityCheck; S4 supplies the real policy computation here. Defaults to alwaysEmptyGrantedCapabilities.
  resolveSecret?: SecretResolver                       // @aart/expr's injected secret-resolver shape — S4/whoever owns the secret adapter supplies the real one; defaults to a resolver that throws SecretResolutionError if actually invoked
  blocks: BlockRegistry                                // Record<string, BlockImplementation> — S3/S7's real catalog in production
  forEachArrayLimit?: number                           // default 10,000
  schemaVersion?: number                                // defaults to CURRENT_ENGINE_SCHEMA_VERSION (currently 1)
  now?: () => Date
  computeRetryDelayMs?: (attempt: number, backoff: string | undefined) => number
}

interface Engine {
  triggerRun(input: TriggerRunInput): Promise<RunRecord>
  executeRun(runId: string): Promise<RunRecord>
  cancelRun(runId: string): Promise<RunRecord>
  resumeBySignal(signal: Signal): Promise<ResumeOutcome>
  resumeManual(runId: string, stepId: string, payload?: unknown): Promise<ResumeOutcome>
  resumeApproval(runId: string, stepId: string, task: {...}): Promise<ResumeOutcome>
  resumeTimerWait(runId: string, stepId: string): Promise<ResumeOutcome>
  resumeExternalJobResult(runId: string, stepId: string, resultPayload: unknown): Promise<ResumeOutcome>
  getDueWaits(now?: Date): Promise<DueWait[]>
  listExternalJobWaits(): Promise<Array<{...}>>
  getExpiredWaits(now?: Date): Promise<Array<{...}>>
  failExpiredWait(runId: string, stepId: string): Promise<ResumeOutcome>
}
```

Every `Engine`-bound resume method **continues execution past the resumed step** (re-derives `step.if`/`then`/`else`/`next` and runs the step-loop forward to the next wait/terminal status) — this is the version S2's ticker and trigger adapters should call, not the standalone claim-only functions in Seam 1. `failExpiredWait` is the one exception: there's no "next step" for a failed wait to continue to, so the bound version finalizes the whole `RunRecord` as `"failed"` directly instead.

### Seam 5 — `RunRecord.params` internal-bookkeeping keys (not new schema fields — see AMENDMENTS.md's discipline on why)

This session stashes 3 keys into the existing free-form `RunRecord.params` bag rather than proposing new `RunRecord` schema fields for engine-internal bookkeeping (spec §19.1: "`params` never affect approval or gates" — an intentionally open bag for exactly this kind of operational data):

- `params.concurrencyKey: string` — the resolved `workflow.concurrency.key` value for this run, set by `triggerRun` whenever the workflow declares a `concurrency` block.
- `params.waitingOnConcurrency: boolean` — `true` while a `queue`-policy run is held behind another non-terminal run of the same key (not yet enqueued to `job_queue`); flipped to `false` by `releaseQueuedRuns` when released.
- `params.environment: string` — threaded through from `TriggerRunInput.environment` (architecture ADR-06: environment context is resolved per claimed run, never a process-start global) — read back on every subsequent step dispatch (including after a resume) to resolve `getGrantedCapabilities(workflow, environment)`.

**Anyone reading `RunRecord.params` for other purposes (dashboard, reports, evidence renderers) should treat these 3 keys as engine-internal** — not part of any user-facing "run parameters" surface, even though they share the same bag as whatever operational params a trigger caller supplies.

### Seam 6 — isolated-vm sandbox primitive (ADR-08), for whoever authors `node`-type blocks

**Consumer:** S3/S7/future pack authors building a `node`-type `BlockImplementation`.

```ts
function runNodeSandbox(options: NodeSandboxOptions): Promise<unknown>
interface NodeSandboxOptions {
  code: string              // a JS FUNCTION BODY (not a full program) — wrapped as `function(input) { <code> }`
  resolvedInputs: unknown
  memoryLimitMb?: number    // default 8
  timeoutMs?: number        // default 5000
}
```

This is a directly-callable, standalone primitive — the engine's own step-dispatch loop does **not** special-case "this is a node block" (the frozen `BlockManifest` has no `type` discriminant to key off, and block-type dispatch for node/command/connector/native/workflow is otherwise uniform: the engine just calls `execute(resolvedInputs, ctx)`). A `node`-type block's own `BlockImplementation.execute` is expected to call `runNodeSandbox(...)` internally with that block's JS source. See `packages/engine/src/sandbox/node-sandbox.ts`'s module doc comment for the fuller design rationale.

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
