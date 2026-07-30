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
type PrepareCompletedRun = (
  run: RunRecord,
  stepId: string,
  transactionStore: AartStore,
) => Promise<RunRecord>

function resumeTimerWait(config: WaitMachineConfig, runId: string, stepId: string, resolvedSecretRefs: ReadonlySet<string> | undefined, prepareCompletedRun: PrepareCompletedRun): Promise<ResumeOutcome>
function resumeExternalJobResult(config: WaitMachineConfig, runId: string, stepId: string, resultPayload: unknown, resolvedSecretRefs: ReadonlySet<string> | undefined, prepareCompletedRun: PrepareCompletedRun): Promise<ResumeOutcome>
function resumeBySignal(config: WaitMachineConfig, signal: Signal, resolvedSecretRefs: ReadonlySet<string> | undefined, prepareCompletedRun: PrepareCompletedRun): Promise<ResumeOutcome>
function resumeManual(config: WaitMachineConfig, runId: string, stepId: string, payload: unknown | undefined, resolvedSecretRefs: ReadonlySet<string> | undefined, prepareCompletedRun: PrepareCompletedRun): Promise<ResumeOutcome>
function resumeApproval(config: WaitMachineConfig, runId: string, stepId: string, task: { id: string; status: string; decision?: unknown; reviewer?: string }, resolvedSecretRefs: ReadonlySet<string> | undefined, prepareCompletedRun: PrepareCompletedRun): Promise<ResumeOutcome>

// ResumeOutcome =
//   | { kind: "resumed"; run: RunRecord; mechanism: ResumeMechanism }
//   | { kind: "duplicate"; mechanism: ResumeMechanism }
//   | { kind: "unmatched"; mechanism: ResumeMechanism }
```

**IMPORTANT — these standalone functions only perform the atomic CLAIM, they do NOT continue execution past the resumed step.** They now require `prepareCompletedRun` because control expressions and secret provenance must be resolved against the completed in-memory trace before its first durable write. Omitting it fails before the claim transaction mutates storage. The callback runs inside that claim transaction and receives its `transactionStore`; every store/artifact read or write made during preparation must use this scoped view. Re-entering the top-level `config.store` can deadlock a non-reentrant adapter such as SQLite. A caller constructing this callback must own the full workflow resolver, secret resolver, and taint-preparation pipeline; passing an identity callback is test-only and is not a safe production implementation. To actually advance the run to its next step (or its next wait/terminal status), call the SAME-NAMED method on a constructed `Engine` instance instead (`engine.resumeTimerWait(runId, stepId)` etc. — see Seam 4). The `Engine`-bound versions construct the preparation callback, perform the atomic claim, and run the step-loop forward. S2's ticker and every production composition root must use those bound methods; the standalone functions remain exposed only for engine-internal tests or a future split-process architecture that supplies an equivalent trusted preparer.

`WaitMachineConfig.prepareRevokedIdempotencyConsumer` is the sibling trusted
callback used when that preparation invalidates a global cache entry already
replayed by another persisted run. The bound `Engine` supplies it and repairs
the full transitive consumer lineage inside the active transaction. The active
run and ledger-named producer runs are reconstructed before the ledger is
declared clean; only after an affected key is found does the engine index
retained consumers and follow its reachable graph. The callback returns the
repaired active run so a same-execution cache consumer cannot later overwrite
it with stale in-memory state. It also repairs run-associated artifact bytes
and metadata, approval audits (including authenticated identity), consumed
signal names/correlations/payloads, outstanding-wait audit copies, correction
field paths and values, and activity-event summary/actor fields. A
standalone caller omitting it can delete the cache entry and directly redact
literal consumer data, but cannot reconstruct downstream workflow provenance;
this is another reason standalone resume functions are test/split-process
mechanisms rather than the production composition surface.
Separately, the bound engine performs one literal-only global audit scan for
each newly resolved value in an execution segment. That pass covers unrelated
non-cached runs and their customer-visible audits but never reconstructs their
workflow provenance; expensive reconstruction remains producer/reachable-
consumer-only. Artifact byte/metadata rewrites are recovery-journaled by both
local adapters. SQLite writes immutable blob generations and commits their
internal pointer with the metadata row; rollback keeps the prior pointer, and
startup removes only unreferenced generations while holding the database
writer lock.
`RunStore.getOperationalState(runId)` is also the engine-only exact authority
for active and terminal runs. A terminal entry is a sealed historical archive,
not an executable continuation: settled replay claims are removed, workflow
resolution prefers its frozen definition over a redacted public snapshot or
mutable registry row, and governed corrections update it alongside the public
audit. Waiting exact state remains owned by
`WaitStore.getOperationalRunState(runId, stepId)`.

`WaitStore.list()` returns the redacted audit condition.
`WaitStore.listOperational()` is the engine-only view that opens the complete
AES-256-GCM-sealed condition used for timer/timeout scheduling and external-job
polling; the adapter-local key is persisted mode `0600` so restart does not
break outstanding waits. Every put uses a random, authenticated operation
generation, preventing an earlier loop entry for the same run/step from being
replayed into the current row; legacy v1 seals rotate to v2 on access. SQLite
does not retain a raw `resume_at` shadow.
`WaitStore.getOperationalRunState(runId, stepId)` opens the separately sealed
raw suspended run and its known secret literals. The engine rehydrates both
before resume/expiry; `replaceOperationalRunState(runId, state)` refreshes
late-discovered taint, rotating and resealing the authenticated wait generation
so earlier continuation ciphertext cannot be replayed, without exposing
executable values through `RunStore`.
`WaitStore.findSignalMatches(name, correlationId)` is the engine-only exact
match seam backed by a one-way adapter fingerprint, and
`WaitStore.redactAudit(runId, stepId, wait)` replaces only the audit copy
without changing either the fingerprint or sealed operation. `SignalStore.markConsumed(...,
{ consumedBy: { runId, stepId } })` records internal repair provenance;
`listConsumedByRun(runId)` retrieves only those already-consumed audit copies
so a later secret discovery never consumes an unrelated early-arrival signal.
`replaceAudit(...)` rewrites all public fields (and the fs filename), including
for an unconsumed signal. Such a signal keeps a sealed operational copy plus a
one-way match fingerprint until consumption; `getOperationalSecretValues(id)`
rehydrates the literals that caused its earlier audit rewrite before the
engine completes an early-arrival wait. Each replacement rotates the signal's
authenticated generation. Resume paths call `replaceAudit` for name,
correlation ID, and payload before `markConsumed` clears that protected copy.
`listConsumedWithoutProvenance()` supplies the conservative upgrade path for
already-consumed rows written before migration `0007`.

The filesystem store serializes top-level operations and transactions under a
process-local mutex shared by every handle to the same normalized root. Every
JSON audit row and artifact blob written through a transaction shares one
durable redo journal, including signals and events. Engine run writes merge
the latest persisted taint metadata after entering that critical section, so
retrospective repair and forward execution cannot overwrite one another.
Database adapters remain the authority for multi-process server workers.

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
  canUseCredentialSecrets?: ({run, block}) => boolean  // engine-owned authentication-only trust decision; absent/false means a block's credential request is conservatively treated as data use
  forEachArrayLimit?: number                           // default 10,000
  schemaVersion?: number                                // defaults to CURRENT_ENGINE_SCHEMA_VERSION (currently 2)
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
- `params.environment: string` — threaded through from `TriggerRunInput.environment` (architecture ADR-06: environment context is resolved per claimed run, never a process-start global). Execution reads the exact value from the sealed operational continuation/archive on every subsequent dispatch, including after resume. If later secret discovery matches the environment name, the public `RunRecord.params.environment` is redacted and is never restored merely because the field also controls capability selection.

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

---

## 2026-07-10 — S4 Governance

### `redactRecord` — the redaction chokepoint (architecture §7.9, ADR-10)

**Export:** `redactRecord` from `packages/governance/src/redact.ts`, re-exported at the package root `@aart/governance`.
**Signature:** matches the frozen `RedactFn` type in `@aart/types` (`governance.ts`) EXACTLY — `(record: unknown, resolvedSecretRefs: ReadonlySet<string>) => unknown`. No divergence from the frozen type.

**Consumers per the plan:** S1 (`@aart/engine`) wires this in via **constructor injection** at the composition root (server/CLI/MCP) — engine code imports only the `RedactFn` *type* from `@aart/types`, never this package directly (architecture §4.6/§7.9's one-directional engine→governance rule, carved out for redaction the same way it is for `CapabilityCheck`). S2/S6/S8 may import `redactRecord` directly from `@aart/governance` wherever they persist/emit a record.

**Behavior contract consumers should know:**
- Value-scan-and-replace over the record's full tree (arrays/nested objects included), never a field-name allowlist. Never inspects key names.
- Catches a secret's **verbatim** form, its **JSON-string-escaped** form (e.g. embedded inside a JSON-stringified payload), and its **URL-percent-encoded** form (e.g. embedded in a query string) — all three, per secret value.
- `resolvedSecretRefs` is a flat `ReadonlySet<string>` of resolved secret **values** (not names) — this is what the frozen type's single `Set<string>` parameter can carry, and matches architecture §7.9's "replaces any occurrence of that literal resolved value."
- **Marker format note (read before consuming):** because a flat value-set carries no symbolic NAME, `redactRecord`'s marker is **positional**: `[REDACTED:secret-N]`, N = 1-based order of the set's iteration — NOT `[REDACTED:<NAME>]` as architecture's diagram illustrates (that format needs a name this function's frozen signature doesn't receive). The same secret value repeating anywhere in one record gets the same marker within that call. If you need real `[REDACTED:<NAME>]` markers and have a value→name mapping available, use the sibling export `redactRecordWithNames(record, resolvedSecretRefs: ReadonlyMap<string, string>)` instead (not part of the frozen `RedactFn` type, an additional governance-owned convenience).
- Empty-string secret values are ignored (never globally blanket-replace empty string). An empty `resolvedSecretRefs` set is a documented no-op.
- Pure — never mutates the input record, returns a new tree.

### `checkCapability` — the real `CapabilityCheck` implementation (architecture §4.6, ADR-09)

**Export:** `checkCapability` from `packages/governance/src/capability.ts`, re-exported at the package root `@aart/governance`.
**Signature:** matches the frozen `CapabilityCheck` type in `@aart/types` EXACTLY — `(declared: string[], granted: string[]) => boolean`. `declared ⊆ granted`.

**Consumer:** S1 (`@aart/engine`) replaces its always-allow stub with this at the composition root. Same import-the-type-not-the-package discipline as `redactRecord` above (engine imports `CapabilityCheck` from `@aart/types`, receives an implementation via constructor injection).

**What feeds `granted`:** this package also exports `computeCapabilityClosure(steps, lookup)` (capability.ts) for computing a workflow version's full transitive capability closure (ceiling-function risk, not average) and `getGrantedCapabilities(input)` (capability.ts) for resolving the policy-driven `granted` set from approval state + capability closure + standing approvals — see that module's doc comments. Neither of these two has a fixed signature specified anywhere in the source documents (unlike `checkCapability`/`redactRecord`/`computeApprovalState`/`computePromotionState`, which do); their shapes are this package's own reasonable fill for a genuine design gap, documented in AMENDMENTS.md. Flag to S4 if S1/S9 integration needs a different shape — these are easy to adjust since nothing outside this package's own tests depends on their exact signature yet.

### `computePromotionState` / `evaluatePromotionForEnvironment` — per-environment promotion (architecture §7.1, ADR-07)

**Export:** both from `packages/governance/src/approval.ts`, re-exported at the package root `@aart/governance`.
**Signatures:**
- `computePromotionState(globalApproval: ApprovalState, gates: Gates, requiredGatesForEnvironment: readonly GateName[], environment: string): PromotionRecord` — pure, exactly 4 positional args, never writes the workflow version's global `approval` field.
- `evaluatePromotionForEnvironment(params: { workflow: Pick<Workflow, "promotionBlocked">, globalApproval, gates, requiredGatesForEnvironment, environment }): PromotionEvaluation` — the "promotion path" call site that refuses to produce/refresh a record while `workflow.promotionBlocked` is true. Call THIS, not `computePromotionState` directly, from any integration that needs the blocked-refusal behavior.

**Consumer:** S2's own DoD text references `computePromotionState` directly (environment/deployment record integration) — this is a real cross-session dependency the Appendix dependency table doesn't list as a merge-order constraint (S2 merges before S4 in the suggested order), so S2 should treat this as **interface-level** for now (code against this documented shape) the same way S7's approval-flow dependency on S4 is treated, per the plan's own merge-order note — a same-wave convergence point for S9 if timing doesn't line up.

**`PromotionRecord`'s exact field shape is NOT frozen anywhere in the source documents** ("its exact field shape is ADR-07's/S2's to finalize when environment records are built" — architecture §7.1). The shape below is this package's own reasonable fill, open to revision by S2 without needing an `AMENDMENTS.md` entry (nothing outside this package's own tests currently depends on it):
```ts
interface PromotionRecord {
  environment: string;
  promoted: boolean;
  globalApproval: ApprovalState;
  requiredGates: readonly GateName[];
  unmetGates: readonly GateName[];
}
```
`GateName` is `keyof Gates` (`packages/governance/src/gates.ts`), exported from the package root.

---

## 2026-07-10 — S7 Registry + packs distribution + llm pack

### R1 — Registry → governance pack-seal convergence point (architecture §11.1/§16.2, consumed by S4)

`@aart/registry` (this package) owns computing/recomputing a pack's content hash; `@aart/governance` (S4) owns the seal-broken DECISION on top of it (`isPackSealBroken`, `packages/governance/src/pack-approval.ts`, already landed on S4's branch — read via the sibling worktree, not a real dependency of this package). The division, made concrete:

```ts
// @aart/registry (this package, packages/registry/src/manifest.ts)
function buildPackManifest(raw: RawPackManifest, blockSources: Record<string, string>): PackManifest
// approvalStatus is HARDCODED "unapproved" — no parameter can set it otherwise.

function recomputePackManifest(existing: Pick<PackManifest, "approvalStatus">, raw: RawPackManifest, blockSources: Record<string, string>): PackManifest
// Re-derives contentHash from CURRENT (manifest, blockSources) — this is
// the "current" side of S4's seal-broken comparison. PRESERVES
// existing.approvalStatus (does not itself decide anything).

// @aart/governance (S4, already landed)
function isPackSealBroken(approvedSnapshot: Pick<PackManifest, "contentHash">, current: Pick<PackManifest, "contentHash">): boolean
// true iff approvedSnapshot.contentHash !== current.contentHash.
```

**The convergence S9 should verify at merge:** `recomputePackManifest(...).contentHash` (this package, run against a pack's CURRENT on-disk manifest+blocks) is the correct "current" argument to feed `isPackSealBroken` (S4's package) alongside the `PackManifest` row last written at approval time. Neither function calls the other — this package has zero dependency on `@aart/governance` (which is a stub in this worktree); the two converge purely on the shared `PackManifest.contentHash` field and the shared hash algorithm (SHA-256 over canonicalized-JSON `{ manifest, blocks: [{name, source}, ...] }`, sorted by block id — `packages/registry/src/hash.ts`).

**Update — the combined convenience now exists, not just anticipated:** this session's own briefing named a second S4 export, `packSealChecks`, that a first read of `pack-approval.ts` alone missed — it actually lives in `packages/governance/src/validation/capability.ts` (`CapabilityValidationContext.packSealChecks?: PackSealCheck[]`, `PackSealCheck = { packName: string; sealBroken: boolean }`), consumed by S4's class-3 capability validation (spec §18.3's "pack hash valid" bullet). That file's own doc comment names the exact gap: "[the block→pack mapping] is S7's `@aart/registry` domain." This package closes it directly — `computePackSealChecks(store, packs: {name,version}[], packageManager): Promise<PackSealCheck[]>` (`packages/registry/src/pack-seal.ts`) produces the IDENTICAL shape `CapabilityValidationContext.packSealChecks` expects, field-for-field (independently declared, `@aart/governance` being a stub here — same constraint as `LlmJudgeFn`, see `packages/llm/SEAMS.md`-equivalent entry L2). Deliberately takes explicit `(name, version)` pairs rather than trying to derive "which packs does this workflow use" itself: `AartStore.packManifests` has no "list every known pack" primitive to walk, and a workflow's own resolved/pinned pack version is the more precise input anyway — whoever assembles `CapabilityValidationContext` (S4's `validateWorkflow` orchestration, or S9's integration wiring) already resolves that closure and should pass the pairs straight through.

**No-weaker-approval-path invariant, structurally enforced:** `buildPackManifest` is the ONLY constructor of a `PackManifest`, called by both `authorPack` (workspace-authored) and `installPack` (npm-distributed, ADR-12) in `packages/registry/src/import.ts` — neither caller, nor `buildPackManifest` itself, exposes an `approvalStatus`/`approved` parameter anywhere. Approving a pack is exclusively S4's `writePackApprovalDecision`, a distinct package, a distinct write path, over the same `store.packManifests` row. Tested directly in `import.test.ts` ("an imported pack and a workspace-authored pack land in IDENTICAL unapproved states — spec §44.2").

**S9 resolution (reconciliation ledger item 12) — verified real, wired, and correctly empty; not fully closeable this pass:** this entry's own text above already flagged the exact gap that surfaced at integration time — "a workflow's own resolved/pinned pack version is the more precise input" ASSUMES such a field exists. It doesn't: `Workflow` (frozen `@aart/types`) has no pack-version-pinning field anywhere, and `AartStore.PackManifestStore` (frozen `@aart/store`) has only `get(name, exactVersion)` and `listVersions(name)` (unordered by contract, no "latest" primitive) — so "which `(name, version)` pairs does this workflow use" has no well-defined answer yet, independent of the "list every known pack" gap this entry already named. A second, independent blocker: `computePackSealChecks` is I/O-bound async (a store read + package install per pack), while `@aart/mcp`'s `GovernancePort.validateWorkflow` — the port `createRealGovernancePort` (`packages/mcp/src/real-context.ts`) must satisfy — is deliberately synchronous (same wall `standingApprovals` resolution hits in the same function, see that adapter's own doc comment). Verified (not assumed) that this is nonetheless currently CORRECT to leave unpopulated, not merely deferred: `createRealGovernancePort`'s catalog (`buildRealCatalog`) only folds in `@aart/blocks-core`/`@aart/llm` today (no pack-delivered block exists in any real catalog yet, tracked separately as reconciliation ledger item 13's own gap), so walking any real workflow's steps for a `BlockCatalogEntry.packName` reference always yields the empty set — `validateCapabilities` already treats a missing `packSealChecks` identically to an empty array (`context.packSealChecks ?? []`), so omitting it produces the actually-correct result today, not a placeholder standing in for one. `computePackHashes` (S1↔S7 seam, item 8, resolved earlier this same pass) hit the identical shape of gap and was resolved the same way — this is that same judgment applied consistently, not a new call. Follow-up (beyond this integration pass's mandate): a pack-version-pinning field on `Workflow` or its approval record, plus either an async `GovernancePort.validateWorkflow` or an eagerly-precomputed seal-check cache, once item 13 lands pack-delivered blocks into the real catalog.

### R2 — `findBlocks` / `BlockCatalogEntry` — the seam `@aart/mcp`'s `aart_find_blocks` tool (S5) should call into

Neither source document gives `aart_find_blocks` a literal TS signature (architecture §11.4/spec §44.3 name it only in prose). This package's fill, `packages/registry/src/discovery.ts`:

```ts
export interface BlockCatalogEntry {
  manifest: BlockManifest;   // @aart/types, unmodified — no amendment made
  packName?: string;         // undefined = core built-in, set = pack-delivered
  examples: readonly Example[]; // @aart/types' Example, reused — see note below
}
export function findBlocks(input: { query: string; scope: "local" | "remote"; localCatalog?: readonly BlockCatalogEntry[]; remoteIndex?: readonly RemoteRegistryIndexEntry[] }): BlockSearchResult[]
```

**Design note (considered and rejected: amending `@aart/types`):** spec §44.3 wants per-block `Example[]` in search results, but the frozen `BlockManifest` (`@aart/types`, architecture §2.5) has no `examples` field — only `Workflow` does. Rather than widen the S0-frozen type for a need that's local to how discovery SHAPES its results, `BlockCatalogEntry` composes `BlockManifest` + `examples` locally, in this package only. No `@aart/types` file was touched; no `AMENDMENTS.md` entry was needed for this. `@aart/mcp` (S5) — whoever assembles the actual local catalog (core `@aart/blocks-core` manifests + this package's `store.packManifests`-derived pack blocks) and the remote static index — should build `BlockCatalogEntry[]` the same way and call `findBlocks` rather than re-implementing search.

### R3 — LLM prompt/schema registry resolution result — the seam S1's `ExecutionSnapshot` capture should consume

See `packages/llm/SEAMS.md`-equivalent entry below (L1) — published here too since it's the other named S9 coordination point from this session's brief.

---

## 2026-07-10 — S7 LLM pack

### L1 — Prompt/schema registry resolution result → `ExecutionSnapshot.resolvedVersions` (architecture §4.5/§12.2, consumed by S1)

`@aart/llm`'s `resolvePromptRef`/`resolveSchemaRef` (`packages/llm/src/registry.ts`) resolve a workflow-authored `prompts.<name>` / `schemas.<name>` reference against `store.promptRegistry`/`store.schemaRegistry`, **lazily** — only when an `llm.*` block's `execute()` actually runs (never at workflow parse/run-start; see `registry.test.ts`'s "laziness" describe block for the exact test). Each resolution returns:

```ts
interface PromptResolution { ref: string; name: string; version: string; contentHash: string; body: string }
interface SchemaResolution { ref: string; name: string; version: string; contentHash: string; jsonSchema: unknown }
```

Architecture §4.5/§12.2 requires the resolved **(name, version, contentHash) triple** to be "pinned into `ExecutionSnapshot.resolvedVersions`" — but that field's frozen shape (`@aart/types`, `run.ts`) is `Record<string, string>` (one string value per key), which can't literally hold a 3-tuple. This package's resolution: key = the ref exactly as written in the workflow (e.g. `"prompts.energy_bill_extraction"`), value = `` `${version}+${contentHash}` `` — decoded by splitting on the LAST `+` (not the first): `contentHash` is always formatted `sha256:<hex>` and never contains a `+`, so the last `+` in the encoded string is always the separator this function inserted, even when `version` itself contains a `+` (e.g. semver build metadata like `1.2.0+build.42` — tested explicitly in `registry.test.ts`). Published helpers for S1 to use verbatim rather than re-deriving the convention:

```ts
// packages/llm/src/registry.ts
export function encodeResolvedVersion(r: Pick<PromptResolution | SchemaResolution, "version" | "contentHash">): string
export function decodeResolvedVersion(value: string): { version: string; contentHash: string }
```

**What S1 should do when it wires real `ExecutionSnapshot` capture:** for every `llm.*` step in the run's trace that resolved a prompt/schema, call `resolvedVersions[resolution.ref] = encodeResolvedVersion(resolution)`. If S1's actual capture mechanism wants a different encoding (e.g. it turns out something downstream needs `version` queryable without decoding), that's a small, easy change on this package's side — flag it here rather than S1 silently inventing a second convention.

### L2 — `LlmJudgeFn` — this package's answer to S6's `SEAMS.md` entry E1

S6 (evidence) documented the exact shape its `llm_judge` `Scorer` kind needs (`/Users/johnlee/code/aart-s6/SEAMS.md`, entry E1) before `@aart/llm` existed. This package adopts that shape **verbatim, field-for-field** — not merely "reconcilable," structurally identical:

```ts
// packages/llm/src/blocks/judge.ts — matches S6's documented LlmJudgeInput/LlmJudgeOutput/LlmJudgeFn exactly
export interface LlmJudgeInput { model: string; actual: unknown; expected: unknown; criteria?: string; temperature?: number }
export interface LlmJudgeOutput { passed: boolean; score: number; detail?: string }
export type LlmJudgeFn = (input: LlmJudgeInput) => Promise<LlmJudgeOutput>;
export function createLlmJudge(deps: LlmJudgeDeps): LlmJudgeFn
```

`createLlmJudge(deps)` is what `@aart/evidence`'s `createScorerRegistry({ llmJudge })` (S6's E1) should be wired with at the composition root once both packages are real (today, S6 tests its own scorer registry against `createFakeLlmJudge`, per E1). Since `@aart/evidence` is a stub in this worktree, this package cannot import S6's actual `LlmJudgeFn` type to structurally guarantee assignability at compile time — the two are independently declared, field-for-field identical by inspection (this file vs. S6's E1 text) as of 2026-07-10. **S9 should add a compile-time check at merge** (e.g. a one-line `const _check: import("@aart/evidence").LlmJudgeFn = createLlmJudge(fakeDeps)` in an integration test) to catch silent drift if either side's shape moves before merge. No divergence found as of this writing — flagging the verification step, not a known mismatch.

### L3 — `llm.*` block output convention — a proposed `BlockExecutionContext` extension for S1

The frozen `BlockImplementation.execute: (resolvedInputs, ctx) => Promise<unknown>` (`@aart/types`, architecture §2.5) returns exactly one value, consumed as the step's `outputs` (spec §22.1's own example shows `{{ steps.parse_bill.outputs.text }}` — a step's resolved output must stay a PLAIN value, not wrapped). But `StepTrace.llmCall: LlmCallMetadata` (architecture §19.2) also needs populating from that same call, out-of-band from the plain output. Architecture §2.5 explicitly anticipates `BlockExecutionContext` will be extended by S1 ("its exact shape is S1's to specify... a shape-changing extension by S1 is exactly the kind of post-freeze change the amendment protocol covers"). This package's `llm.*` blocks (`packages/llm/src/blocks/*.ts`) therefore:

1. Return the plain resolved output from `execute()` — correct `{{ steps.X.outputs.field }}` ergonomics, matching every other block.
2. Call `ctx.recordLlmCall?.(metadata)` — an OPTIONAL, defensively-invoked extension point this package proposes but does not require: `interface LlmBlockExecutionContext extends BlockExecutionContext { recordLlmCall?(metadata: LlmCallMetadata): void }` (`packages/llm/src/blocks/core.ts`, re-exported from the package root; `blocks/judge.ts` imports and reuses this SAME interface rather than declaring its own). Against a bare `BlockExecutionContext` (e.g. this package's own tests, or an engine that hasn't added this method yet), the optional-chained call is simply a no-op — the block still executes and returns the correct output, it just has nowhere to hand the metadata.

Each block's CORE logic (`llmCall`, `llmExtract`, `llmClassify`, `llmGenerate`, the judge core) is independently exported and directly returns `{ output, llmCallMetadata }` — fully testable (and tested) without any `BlockExecutionContext` at all, which is how this session verified "`LlmCallMetadata` is populated correctly regardless of which provider handled the call" per its own DoD without needing the engine to exist first. **S1: if `recordLlmCall` isn't the shape you want, this is a proposal, not a fait accompli** — the core functions don't depend on it existing at all, so changing/renaming/reshaping it costs this package nothing beyond updating the thin `execute()` adapters.

**S9 resolution (2026-07-10, reconciliation ledger item 6): ADOPTED as proposed, now wired into real dispatch.** `packages/engine/src/types.ts` declares `EngineBlockExecutionContext extends BlockExecutionContext { recordLlmCall?(metadata: LlmCallMetadata): void }` — structurally identical to this package's `LlmBlockExecutionContext`, declared separately rather than imported so `@aart/engine` stays block-catalog-agnostic (no dependency on `@aart/llm`). `step-executor.ts`'s `buildBlockContext` now supplies a real `recordLlmCall` for every dispatched block (not just `llm.*` ones — a block that never calls it is simply unaffected); `dispatchOnce` captures the metadata and attaches it to the completed `StepTrace.llmCall` field. Redaction required no new call site: `appendTracesAndPersist` already routes the whole `RunRecord` (traces included) through `applyRedaction`/`config.redact` before every persist, so `llmCall`'s fields are swept by the same value-scan-and-replace as everything else. Tests: `packages/engine/src/step-executor.test.ts`'s new "ctx.recordLlmCall wiring" describe block (attaches on success, absent when never called, absent on failed dispatch, redacted like any other field).

---
## 2026-07-10 — S6 Evidence + reports + corrections + evals + familiarity-evals

### E1 — `LlmJudgeFn` — the seam `@aart/evidence`'s `llm_judge` scorer expects `@aart/llm` (S7) to satisfy

`@aart/llm` hasn't started (S7 is a concurrent Wave-1 session). `@aart/evidence`'s `llm_judge` `Scorer` kind (architecture §9.5/§12.3, spec §24.3's "clearly marked non-deterministic" kind) is built against a documented, stubbed boundary rather than a real `@aart/llm` import:

```ts
// packages/evidence/src/evals/scorers/llm-judge.ts
export interface LlmJudgeInput {
  model: string;            // provider/model convention, spec §13.6/§22.4
  actual: unknown;
  expected: unknown;
  criteria?: string;
  temperature?: number;     // always invoked at 0 by createLlmJudgeScorer, architecture §9.5
}
export interface LlmJudgeOutput {
  passed: boolean;
  score: number;
  detail?: string;
}
export type LlmJudgeFn = (input: LlmJudgeInput) => Promise<LlmJudgeOutput>;
```

`createScorerRegistry({ llmJudge?: LlmJudgeFn })` (registry.ts) wires this in — the `llm_judge` scorer kind throws a clear, descriptive error if invoked with no `llmJudge` supplied. **S7 should export a function from `@aart/llm` matching this shape** (its `llm.judge` block's underlying call, per architecture §12.3: "`llm.judge` — used both as a workflow step and, via `@aart/evidence`'s scorer registry, as the LLM-judge `Scorer` kind"). If S7's natural shape differs, reconcile via this file / the amendment protocol rather than `@aart/evidence` silently guessing again. `@aart/evidence`'s own tests use `createFakeLlmJudge` (same file) — a scripted fake, not a real model call.

### E2 — Scorer registry — consumed by `@aart/blocks-core`'s `eval.run`/`eval.score` blocks (S3)

```ts
// packages/evidence/src/evals/scorers/registry.ts
export function createScorerRegistry(options?: { llmJudge?: LlmJudgeFn }): ScorerRegistry;
interface ScorerRegistry {
  readonly kinds: readonly string[];             // the 12 BUILTIN_SCORER_KINDS from @aart/types
  get(kind: string): ScorerRegistryEntry | undefined;
  score(kind: string, actual: unknown, expected: unknown, config?: unknown): Promise<ScorerResult>;
}
```

S3's own DoD note ("Eval (2 — block-level `eval.run`/`eval.score` that call into S6's scorer registry, stubbed if S6 isn't done yet)") names this exact call point. S6 is done — S3 can import `createScorerRegistry`/`ScorerRegistry`/`ScorerResult` from `@aart/evidence` directly rather than stubbing. The 12 individual pure scorer functions (`exactMatch`, `jsonpathExact`, `jsonpathContains`, `regexScorer`, `numericTolerance`, `fieldLevelAccuracy`, `classificationMatch`, `artifactExists`, `screenshotExists`, `noConsoleErrors`, `customNode`) plus `createLlmJudgeScorer` are also individually exported from the same module, for a block that wants one scorer directly without the registry indirection.

### E3 — Report renderers — consumed by `@aart/dashboard` (S8) and `@aart/blocks-core`'s `report.*` blocks (S3)

```ts
// packages/evidence/src/renderers/index.ts
export function createReportRenderers(redact: RedactFn): {
  modelFacing(run: RunRecord, resolvedSecretRefs?: ReadonlySet<string>): ModelFacingReport;
  markdown(run: RunRecord, resolvedSecretRefs?: ReadonlySet<string>): string;
  html(run: RunRecord, resolvedSecretRefs?: ReadonlySet<string>): string;
  prComment(run: RunRecord, resolvedSecretRefs?: ReadonlySet<string>, options?: PrCommentOptions): string;
  json(run: RunRecord, resolvedSecretRefs?: ReadonlySet<string>): string;
  cliText(run: RunRecord, resolvedSecretRefs?: ReadonlySet<string>): string;
};
```

`html`'s output is what architecture §9.1 says serves spec §19.3's "dashboard view" format — S8 should render this directly rather than re-implementing a RunRecord→HTML transform. `redact: RedactFn` is S4's real `redactRecord` once published (see AMENDMENTS/S4's own seam note); wire it in once at the composition root, not per render call.

### E4 — Correction-outcome functions — writable actions consumed by `@aart/dashboard` (S8)

Architecture §13.2: "every writable action in the dashboard calls the SAME underlying functions the MCP/CLI surfaces call... the dashboard is a third client of those functions, not a parallel implementation." These are that function set (`packages/evidence/src/corrections/outcomes.ts` and `correction.ts`), all `(store: AartStore, ...) => Promise<...>`:

```ts
recordCorrection(store, input: RecordCorrectionInput): Promise<Correction>          // capture (correction.ts)
updateRunOutput(store, correction: Correction): Promise<RunRecord>                  // outcome 1/6
createEvalExampleFromCorrection(store, correction, suiteId, options?): Promise<EvalExample>  // outcome 2/6
createIssueForAgent(store, correction: Correction): Promise<ImprovementBrief>       // outcome 3/6
triggerImprovementProposal(store, workflowId, workflowVersion, options?): Promise<ImprovementBrief>  // outcome 4/6
blockPromotion(store, workflowId, workflowVersion): Promise<Workflow>               // outcome 5/6
unblockPromotion(store, workflowId, workflowVersion): Promise<Workflow>             // complement, not one of the 6
markNeedsReview(store, workflowId, workflowVersion): Promise<Workflow>              // outcome 6/6
clearNeedsReview(store, workflowId, workflowVersion): Promise<Workflow>             // complement, not one of the 6
```

S8's dashboard "record correction / create eval / promote / view risk diff" actions (architecture §13.2's writable v2 list) should call these directly, not reimplement store writes. Same applies to whichever session builds `aart_record_correction` (MCP, §34) / `aart correction add` (CLI, §33.3) if that hasn't landed elsewhere yet.

### E5 — `ValidateFn` / `RunSuccessFn` — the seams `@aart/familiarity-evals` expects the REAL `aart_validate` (S4) and engine-backed run success (S1) to satisfy

`@aart/familiarity-evals` is deliberately fully offline-testable (this session's DoD) and does not depend on `@aart/governance` or `@aart/engine` (neither has landed; a familiarity-eval gate depending on either would also be a layering inversion — familiarity-evals is a CI-gate consumer of AART's own surface, not something governance/engine should need to know about). It ships its own small reference implementations for its own tests only:

```ts
// packages/familiarity-evals/src/types.ts
export type ValidateFn = (workflow: unknown) => ValidateResult | Promise<ValidateResult>;
export type RunSuccessFn = (workflow: unknown) => RunSuccessResult | Promise<RunSuccessResult>;
```

`validate.ts`'s `createReferenceValidator(knownBlocks)` covers only spec §18.1 (schema validation) + a structural stand-in for §18.2 (block-reference validation) — it does NOT implement capability/input-safety/deployment validation (§18.3-18.5), which need governance's real policy model. `run-success.ts`'s `createReferenceRunSuccessChecker()` is schema-shape-only (parses + has ≥1 step), not a real execution. **This session's DoD explicitly does not wire CI or run a real-model baseline — that's S9's job** (implementation plan §3/S6 DoD note): S9 should inject governance's real validator and an engine-backed run-success check via these same two function-type seams when it wires the familiarity-evals CI gate (ADR-15's "own CI wiring, separate from a workflow's own promotion-gate CI... triggered by PRs to the `aart` repo itself").

### E6 — Dry-run + connector-fake vocabulary (documented convention, not a function seam)

`@aart/evidence`'s `evals/dry-run.ts` (`ConnectorFakeRegistry`, `isEffectfulCapability`, `DEFAULT_EFFECTFUL_CAPABILITIES = ["email.send", "command", "db.write"]` plus the `domain:<pattern>` family) is `@aart/evidence`'s OWN self-contained implementation of architecture §9.5's dry-run/connector-fake mechanism, scoped to running an eval suite's fixture steps — it does not depend on `@aart/engine` and `@aart/engine` does not depend on it. `@aart/engine`'s REAL dry-run check (architecture §9.5 point 1: `RunRecord.params.dryRun` checked at the dispatch boundary, architecture §4.2) is S1's separate responsibility. The two are meant to converge on the same VOCABULARY (a `dryRun` boolean, the same effectful-capability set, "fake ships alongside real under the same block name") by documented contract, not shared code. **Flagging this for S1/S9's awareness**: if S1's real effectful-capability set diverges from `DEFAULT_EFFECTFUL_CAPABILITIES` above, that's fine (it's a caller-overridable default, not a frozen enum) but worth reconciling explicitly during S9's integration pass so a workflow author's mental model of "what counts as effectful" doesn't differ between an eval dry-run and a real `RunRecord.params.dryRun` run.

**S9 resolution (2026-07-10/11, reconciliation ledger item 7): both closed the gap (S1's real engine-side check genuinely never existed until now — confirmed by grep, not just divergent copies) and converged on SHARED CODE, not just a documented contract.**
- `DEFAULT_EFFECTFUL_CAPABILITIES`/`isEffectfulCapability` moved to `@aart/types` (`packages/types/src/dry-run.ts`) — the single source of truth, matching `BUILTIN_SCORER_KINDS`' existing "open, not a frozen enum" precedent (eval.ts). `@aart/evidence`'s `evals/dry-run.ts` now re-exports both from `@aart/types` (zero call-site churn for its own consumers/tests).
- `@aart/engine`'s real dispatch boundary (`step-executor.ts`'s `dispatchOnce`) now checks `run.params?.dryRun === true` against the dispatched block's declared capabilities via the shared `isEffectfulCapability`; an effectful block's real handler is swapped for a synthetic-success stub (`{ dryRun: true, wouldHaveCalled, args }`, matching architecture §9.5's literal wording) — a non-effectful block, or any block outside `dryRun: true`, is entirely unaffected. `EngineConfig.effectfulCapabilities?` is the caller-overridable seam (defaults to the shared `DEFAULT_EFFECTFUL_CAPABILITIES`).
- **Idempotency decision (resolved, not left open):** a faked dispatch never calls `recordIdempotency` — recording a synthetic result under a real `idempotencyKey` would wrongly short-circuit a LATER genuinely-real invocation of the same step into skipping the actual effectful action the key exists to gate. The idempotency-already-completed CHECK still runs unconditionally (an already-real-completed step's cached result is still correct to replay even inside a dry-run — no new effect happens either way). Tested explicitly: fake first, then a real dispatch of the identical resolved key still calls the real handler.
- **Retry decision (resolved, not left open):** the synthetic stub is still wrapped in the normal `dispatchWithRetry` path — harmless, since a stub that always resolves immediately never exercises the retry branch; no special-casing needed.
- **Not reconciled, deliberately:** `packages/governance/src/validation/input-safety.ts` has its OWN third `isEffectfulCapability`-named local function, for a genuinely different purpose (validation class 4's "effectful capability with no idempotencyKey" WARNING — advisory, never blocking) with a deliberately BROADER definition (a `/write/i` regex, "forward-compatible with future write-shaped capabilities") than the dry-run vocabulary's exact set. Left as its own intentional, differently-scoped heuristic — over-warning about a missing idempotencyKey is a much lower-stakes false-positive than under-covering the dry-run fake/real decision, where an uncovered effectful capability would make a REAL call during a supposed dry run.
- Tests: `packages/engine/src/step-executor.test.ts`'s new "dry-run mode" describe block (fakes each of the 3 named capabilities + `domain:*`, non-effectful blocks unaffected, dryRun-absent unaffected, idempotency-skip verified end-to-end with a real second dispatch).

---

## 2026-07-10 — S3 Core block packs

### S3-E1 — Browser session lifecycle — `closeBrowserSession`/`closeAllBrowserSessions`, expected to be called by S1 (`@aart/engine`) / S2 (`@aart/server` worker)

```ts
// packages/blocks-core/src/lib/browser-session.ts
export async function getOrCreatePage(runId: string): Promise<Page>;          // internal — used by browser.*/web.read blocks only
export function getConsoleErrors(runId: string): string[] | undefined;        // internal — used by assert.no_console_errors only
export function hasSession(runId: string): boolean;
export async function closeBrowserSession(runId: string): Promise<void>;      // <-- the seam
export async function closeAllBrowserSessions(): Promise<void>;               // <-- the seam
```

`BlockExecutionContext` (architecture §2.5, S0-frozen) carries no page/session handle and no run-completion or process-shutdown hook — it's `runId`/`stepId`/`resolveSecret`/`writeArtifact` only. But a real workflow's `browser.*` steps are a SEQUENCE acting on the same logical page (`browser.goto`, then `browser.click`, then `browser.screenshot`), and architecture §4.2 dispatches each step's block independently with no continuity primitive of its own. `@aart/blocks-core` supplies that continuity itself, process-side: one Playwright `BrowserContext`+`Page` per `runId`, created lazily on that run's first `browser.*`/`web.read` call (via a single **lazy**-launched shared headless Chromium — `playwright` is never `import()`-ed until the first browser block actually executes) and reused by every subsequent `browser.*` call in the same run. `assert.no_console_errors` reads the same per-run session's tracked `console.error`/`pageerror` output.

Nothing in `@aart/blocks-core`'s own scope ever calls `closeBrowserSession`/`closeAllBrowserSessions` — this package has no run-completion or process-shutdown signal of its own to act on. **Expected consumer:** the engine (S1) once a run reaches a terminal status, and/or the worker process (S2, architecture §4.7's graceful-shutdown sequence) on `SIGTERM`, should call `closeBrowserSession(runId)` / `closeAllBrowserSessions()` respectively. Until wired in, a run's browser session is only ever cleaned up by explicit test teardown or process exit — this is a real, currently-unclosed resource-lifecycle gap, flagged here rather than silently left for S9's integration pass to discover. If S1/S2's real shape for "a run reached a terminal state" or "the worker is shutting down" doesn't fit a bare `closeBrowserSession(runId)` call (e.g. it wants a registered callback instead of being the caller), reconcile via this file / the amendment protocol rather than either side silently guessing.

**S9 resolution (2026-07-10, reconciliation ledger item 10): RESOLVED — per-run close on terminal transition, coarse SIGTERM safety net, both via generic DI hooks (not a direct `@aart/blocks-core` import from either package, preserving `@aart/engine`'s/`@aart/server`'s existing block-catalog-agnostic layering):**
- `EngineConfig.onRunTerminal?: (runId) => void|Promise<void>` (`packages/engine/src/types.ts`) — called after every durable transition into a terminal status: ordinary finalization, explicit cancellation, and retrospective `completed → failed` cache invalidation discovered at a later dispatch/wait boundary. Best-effort: a throwing hook is caught and swallowed, never fails the run's own (already-persisted) terminal status. Defaults to a no-op.
- `LeaseConfig.onShutdown?: () => void|Promise<void>` (`packages/server/src/config.ts`) — called once from `gracefulShutdown` (`worker/shutdown.ts`), after the claim-drain/force-release loop, as a coarser safety net (catches whatever a force-released or crashed run's per-run close missed). Best-effort: caught and logged, never blocks process exit. Defaults to a no-op.
- **Cadence decision:** per-run close (not periodic/coarse-only) is the primary mechanism, since sessions are already keyed 1:1 by `runId` — closing at the natural terminal-transition chokepoint matches that scoping exactly and avoids keeping Playwright contexts alive across many concurrent runs. The SIGTERM-time `closeAllBrowserSessions()` is a true safety net for the abnormal case (force-release, process crash), not the primary cleanup path.
- The real composition root wires `onRunTerminal: (runId) => closeBrowserSession(runId)` and `onShutdown: () => closeAllBrowserSessions()`, importing `@aart/blocks-core` only at that one integration point.
- Tests: `packages/engine/src/run-lifecycle.test.ts` (fires on completion and cancellation, throwing hook doesn't fail the run), `packages/engine/src/engine.test.ts` (a completed cache consumer later invalidated to failed emits a post-commit `run.failed` event), and `packages/server/src/worker/worker.test.ts` (fires once during graceful shutdown, throwing hook doesn't block `stop()`).

### S3-E2 — Block catalog composition — `createBlockCatalog`/`getBlockCatalog`, expected to be called by S1 (`@aart/engine`'s dispatch loop) and/or S9 (integration composition root)

```ts
// packages/blocks-core/src/catalog.ts
export interface BlocksCoreDeps {
  scorerRegistry?: ScorerRegistryPort;   // eval/scorer-registry-port.ts — injected into eval.run/eval.score
  reportRenderers?: ReportRenderersPort; // artifact-report/report-renderers-port.ts — injected into report.summarize/markdown/json
}
export function createBlockCatalog(deps?: BlocksCoreDeps): BlockImplementation[]; // all 51 blocks
export function getBlockCatalog(): BlockImplementation[];                        // createBlockCatalog({}) convenience default
export function getBlockGroupCounts(): Record<string, number>;
```

This is `@aart/blocks-core`'s single assembly point — the array `@aart/engine`'s dispatch loop (architecture §4.2, "dispatch to block") needs to resolve a `step.uses` block id against. Every `BlockManifest`/`BlockImplementation` in the returned array is real and complete regardless of `deps` (manifest construction never depends on injection — only calling `execute()` on `eval.run`/`eval.score` without a resolvable `ScorerRegistryPort` throws `ScorerRegistryUnavailableError`). Once S9 merges S6's real `@aart/evidence`, the composition root should call `createBlockCatalog({ scorerRegistry: createScorerRegistry(...), reportRenderers: createReportRenderers(...) })` using S6's real exports (SEAMS.md E2/E3 above) — no block rewrite needed, per this session's own injected-boundary brief. Until that wiring exists, `getBlockCatalog()`/`createBlockCatalog({})` still work today: eval blocks lazy-`import("@aart/evidence")` at call time and throw a clear error while it's still S0's stub; report blocks lazy-`import` the same way but fall back to a real local renderer (`createFallbackReportRenderers`) instead of throwing.

---

## 2026-07-10 — S5 MCP + CLI + model-native surface

### Pure-consumer status — no new interface published for a Wave-1 sibling to consume

S5 (`@aart/mcp`, `@aart/cli`) is the terminal, purely-downstream session in
the Wave-1 dependency graph (implementation plan §9/Appendix: S3/S5/S7 are
mutually unconstrained; nothing in Wave 1 depends on S5's exports). Every
export this session adds is either (a) internal to `@aart/mcp`/`@aart/cli`,
or (b) a documented STUB standing in for a real Wave-1 sibling's package
until S9 merge time — the reverse direction from what this file otherwise
logs. This entry is for **S9's benefit at merge time**: exactly which of
this session's modules need a real import swapped in, and the load-bearing
interpretive decisions made where neither source document gave an exact
shape — same protocol S0/S1/S2/S4/S6/S7 already used in this file/
AMENDMENTS.md for their own genuine gaps.

### Stub-swap points — what S9 should replace at merge

Every stub implements the EXACT signature its sibling's real, landed (or
documented) export uses — see each file's own module doc comment for the
verified source read. Swapping is a constructor-injection change in
`packages/mcp/src/context.ts`'s `createAartContext` (and
`packages/cli/src/cli-context.ts`'s `createCliContext` for the CLI-only
`ServerPort`), not a redesign:

| Port (`packages/mcp/src/types.ts`) | This session's stub | Real replacement at merge |
|---|---|---|
| `EnginePort` | `packages/mcp/src/stubs/engine.ts` (`createStubEngine`) | `@aart/engine`'s `createEngine(config)` (S1) |
| `GovernancePort` | `packages/mcp/src/stubs/governance.ts` (`createStubGovernance`) | `@aart/governance`'s real exports (S4 — already landed on branch `s4-governance`, worktree `/Users/johnlee/code/aart-s4`; verified against source 2026-07-10) |
| `EvidencePort` | `packages/mcp/src/stubs/evidence.ts` (`createStubEvidence`) | `@aart/evidence`'s `createReportRenderers`/correction-outcome functions (S6) |
| `RegistryPort` | `packages/mcp/src/stubs/registry.ts` (`createStubRegistry`) over `packages/mcp/src/catalog.ts`'s placeholder block catalog | `@aart/registry`'s real `findBlocks` (S7) fed the real `@aart/blocks-core` (S3) + pack-manifest catalog |
| `ServerPort` (CLI-only, `packages/cli/src/stubs/server.ts`) | `createStubServerPort` | `@aart/server`'s `startServer`/`startWorker`/`produceBundle`/`writeBundleToDisk`/`clearRunFlag`/`listFlaggedRuns` (S2) |

S4's governance stub is the ONE case where a real, landed implementation
already exists in a sibling worktree at the time this session ran —
`computeApprovalState`/`computePromotionState`/`evaluatePromotionForEnvironment`/
`REQUIRED_GATES_BY_MODE`/`AART_APPROVE_TOOL_NAME`/`MODES_WITH_AART_APPROVE`/
`isAartApproveRegisteredForMode` are mirrored **verbatim** (same algorithm,
same signature, copied from S4's actual `packages/governance/src/{approval,gates}.ts`).
`validateWorkflow`/`semanticRiskDiff`/`redact` are **simplified**
(schema-class-only validation; step-level-only diff, no capability-closure
risk-tier delta; no secondary-form [JSON-escaped/URL-encoded] redaction
matching) since full fidelity needs a real block catalog this worktree
doesn't have. See `packages/mcp/src/stubs/governance.ts`'s module doc
comment for the exact mirrored/simplified line, function by function.

### Load-bearing interpretive decisions (genuine gaps — neither source document gives an exact shape)

- **`aart_register_block` registers a WORKFLOW draft, not a block implementation.** Confirmed by architecture §10.2's own worked example ("Draft registered. Next: `aart_validate`.") and the v0.x prototype's identical-in-spirit `aa_register_block` ("Register. Call aa_register_block. It saves as draft.", `/Users/johnlee/code/aa-runtime/src/agent/guide.ts`). A registered workflow is additionally dispatchable as a `workflow`-type block from other workflows (S1 SEAMS.md Seam 6's uniform block-type dispatch), presumably the origin of the tool's literal name.
- **`ApprovalTask` has no `workflowId`/`workflowVersion` fields** (frozen shape: `runId`+`stepId` only; spec §23.4 confirms `ApprovalTask.status` is "a decision on ONE RUN's approval step"). But `aart_request_approval`/`aart_approve` also need to cover workflow-VERSION-level `humanReview`-gate approval (spec §17.5's whole authority matrix is framed around approving a workflow, not a running step). Resolved via a documented sentinel encoding — `runId: "version-review:<workflowId>@<workflowVersion>"`, `stepId: "humanReview"` — see `packages/mcp/src/handlers/governance.ts`'s module doc comment for the full reasoning. **Flag to S9/John:** if a cleaner mechanism emerges once S4's real approval-task flows are wired end to end, this sentinel convention should be revisited — it's this session's own fill for a genuine type-shape gap, not a frozen contract.
- **`aart_deploy_workflow`/`aart deploy` auto-creates the target `Environment`** (by name, empty config) if one doesn't already exist — nothing in this session's scope, or any sibling's documented seam, provides an environment-authoring surface, yet architecture §10.1's progressive-disclosure note ("register only once at least one Environment record exists") presumes one can come to exist. Per-environment required gates also reuse this session's `requiredGatesByMode` table (mode-based, not truly per-environment) — ADR-07 leaves a genuinely per-environment policy unspecified anywhere. See `packages/mcp/src/handlers/deployment.ts`'s module doc comment.
- **Four CLI commands beyond spec §33's literal bash-block list, each independently evidenced elsewhere in the source documents (not invented):** `aart bundle` (architecture §0.3/§1: "`aart bundle` ... is a `@aart/cli` command"); `aart flag clear`/`aart flag list` (architecture §13.3/A33: the CLI/dashboard-only exception to the three-client principle); `aart approve` (spec §17.5's authority matrix names CLI as an approval surface in EVERY trust mode — the only surface left once `aart_approve` is mode-gated out of MCP in strict/production, so without this command those two modes would have no approval path through anything this session builds); `aart mcp` (spec §27.2's own worked example, `npx @team-monet/aart mcp` — the exact command `aart init-agent`'s generated config invokes).
- **`@modelcontextprotocol/sdk`** (real, official MCP SDK, v1.29.0) is a genuine new external dependency of `@aart/mcp`, used only by the thin `mcp-stdio.ts` adapter (`aart mcp`'s actual runtime, wired to the real `npx @team-monet/aart mcp` entry point). Every mode-gating/envelope/dispatch behavior this session is graded on runs through protocol-agnostic `listTools()`/`callTool()` functions (`tools/server.ts`) with zero SDK involvement — the SDK adapter is a thin, separately-verified (typecheck/build, plus a light connect/close smoke test against fake stdio streams) wiring layer on top, not where the tested logic lives.

### Same-function-reference, structurally guaranteed

`packages/cli/src/commands/*.ts` import handler functions directly from
`@aart/mcp` (e.g. `authoring.ts` imports `runWorkflowHandler`/
`validateWorkflowHandler`/`registerWorkflowHandler`; `governance.ts` imports
`approveHandler`/`diffWorkflowHandler`/`promoteWorkflowHandler`/
`recordCorrectionHandler`; `evals.ts` imports `runEvalHandler`;
`deployment.ts` imports `deployWorkflowHandler`) and call them with zero
wrapping — the MCP tool and the CLI command dispatch to the literal same
function object. `packages/cli/src/index.ts` re-exports these same bindings
verbatim (not copies) specifically so S9's same-function-reference
integration check has something concrete to import and assert `===`
against, alongside `packages/cli/src/cli.test.ts`'s own direct comparison
test (`aart run` vs. calling `runWorkflowHandler` directly).

### For whoever builds the real `@aart/blocks-core` catalog (S3) or `@aart/registry` discovery index (S7)

`packages/mcp/src/catalog.ts`'s `BUILTIN_BLOCK_CATALOG` is a PLACEHOLDER (24
block manifests covering every block id spec §14.2's example and §32.5's
alias table name explicitly) — not a port of S3's real manifests. At merge,
`RegistryPort`'s real implementation should assemble its catalog from
`@aart/blocks-core`'s real manifests + `@aart/registry`'s pack-manifest-derived
blocks, per S7's own SEAMS.md (R2) note on this exact point.

---

## 2026-07-11 — S8 Dashboard

`@aart/dashboard` is a leaf consumer (architecture: "a client of nearly everyone else's output"), so this entry is mostly the reverse of the usual seam entry — not "here's what to code against," but "here's exactly what this package expects from S2/S4/S6, and the genuine gaps found while building against their published (or, in two cases, observed-but-unpublished) seams." **S9 and each named sibling should read the gap list below before reconciling.**

### What this package needs from S2 (`@aart/server`) — confirmed, no new asks

Built directly against S2's own SEAMS.md HTTP route list and `flags.ts`/`worker/health.ts` (read from the S2 sibling worktree to confirm exact behavior). `ApiClient` (`packages/dashboard/src/api-client.ts`) matches every route 1:1 — no route this package needs is undocumented on S2's side. One possible future enrichment, not a blocker: `GET /workflows` currently returns bare `{ workflowIds: string[] }`; the Workflows detail page (`/workflows/:id`) has to fall back to a direct `store.workflows.getLatest()` read for name/version/approval/gates since there's no richer HTTP shape yet. Not requesting a change — flagging in case S2/S9 want to enrich that route later.

**S9 verification (reconciliation ledger item 13):** re-checked against the real, merged `@aart/server` (`packages/server/src/http/server.ts`'s actual route table, not just this entry's own prose) — confirmed still accurate, not stale. `GET /workflows -> { workflowIds }` is exactly what the real route returns; no richer per-workflow route exists. This package's existing workaround (list page uses the confirmed route, detail page reads the store directly) is therefore the CORRECT resolution already, not a gap needing S9 to close — no code change made here.

**Correction (root AMENDMENTS.md A43) — the above conclusion is SUPERSEDED, not stale-but-harmless.** It held only because nothing had yet exercised the actual failure mode: the dashboard's detail-page store handle and the real `aart server`'s own store handle are two independently-configured `AartStore` instances that can (and, in a real founder test drive, did) point at different `.aart` directories — one silently empty, one correct — with no error anywhere, list and detail pages disagreeing about whether a workflow exists. "The workaround is correct" was true only in the single-process-single-store-instance shape every test up to that point exercised. `GET /workflows/:id -> {workflow, versions}` (404 `{error}` if unknown; `?version=` for a specific version) now exists (`packages/server/src/http/server.ts`, right after the bare-ids route above) and `packages/dashboard/src/server.ts`'s `/workflows/:id` reads through `ApiClient.getWorkflow` like every other v1 page, not `store` directly — restoring this package's own stated architecture `[DECISION]` ("reading directly from @aart/store via @aart/server's HTTP API," `api-client.ts`'s header comment) rather than the store-direct exception this seam used to carry.

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

**S9 resolution (reconciliation ledger item 13) — Blocks closed for real, Packs verified still genuinely open:**

- **Blocks page: RESOLVED.** `@aart/blocks-core` (S3) and `@aart/llm` (S7) have both landed in the merged repo — the blocker this entry named ("no data source exists at all") no longer holds. This package now depends on both directly (`package.json`) and builds the real 56-block catalog (`capability-catalog.ts`'s `listBlockManifests`, built primarily for the risk-diff item below and reused here). `renderBlocksPage` (`views/blocks-packs.ts`) now takes `readonly BlockManifest[]` and renders id/category/capabilities/description for every real block, sorted by id. `views/blocks-packs.test.ts` and `server.test.ts` updated accordingly.
- **Packs page: VERIFIED STILL OPEN, not silently carried over.** Re-checked both named blockers against the real, merged code (not assumed from this entry's own prior text): `PackManifestStore` (`packages/store/src/types.ts`) still has only `get(name, exactVersion)`/`put`/`listVersions(name)` — no enumerate-all method — and `@aart/server`'s real route table (`packages/server/src/http/server.ts`) still has no `/packs` route. Identical root blocker to reconciliation ledger item 12 (root AMENDMENTS.md A27's sibling entry / this file's own R1 "S9 resolution" note) — both need the same missing primitive. Left honestly pending, same as before.

**New real data source, not previously listed here — semantic risk diff (also item 13):** `views/workflows.ts`'s former `computeSimpleStepDiff`/`StepDiff` (a structural added/removed-block-id approximation, its own doc comment already calling itself "a deliberately SIMPLIFIED stand-in... until the real capability-closure-based diff can be wired in") is deleted and replaced by `deps.semanticRiskDiff`, bound in `stub-deps.ts` to `@aart/governance`'s real `semanticRiskDiff`, fed a real capability-closure lookup built from the same `@aart/blocks-core`/`@aart/llm` catalog (`capability-catalog.ts`'s `buildCapabilityClosureLookup`). Deliberately does NOT import `@aart/mcp`'s `real-context.ts` (which has an near-identical lookup) — architecture's three-client principle means this package calls the same UNDERLYING `@aart/governance`/`@aart/blocks-core` functions @aart/mcp does, not that it depends on @aart/mcp's own composition-root code; @aart/mcp is a protocol-server package, not a shared library. `renderRiskDiffPage` now renders the real `SemanticRiskDiff` shape (added/removed/modified steps, capabilityChanged, newCapabilities/newSecrets/newDomains, riskFrom/riskTo/riskIncreased) instead of a bare added/removed block-id list. `views/workflows.test.ts`/`server.test.ts` updated with real block ids (`http.request`/`command.run`) proving the capability-closure resolution is genuine (asserts `newCapabilities` contains `command.run`'s real declared capability), not just that the route still returns 200.

**Still explicitly NOT resolved by the above (flagged so it isn't assumed closed):** `triggerRun`/`resumeApproval` (this file's own note above) and evidence's report renderers/scorer registry/runEvalSuite remain this package's own local mirrors, not bound to `@aart/engine`/`@aart/evidence`'s real implementations — that wiring landed for `@aart/mcp`'s composition root (`real-context.ts`, reconciliation ledger items 3/5) but does NOT automatically reach this package, since `DashboardDeps` is its own separate DI container per the three-client principle. Tracked as a distinct, real, not-yet-done follow-up beyond this integration pass's item-13 scope (which named specifically "Packs-page data source," "GET /workflows enrichment," and "structural risk-diff → real semantic diff").

### `resumeApproval` stub — honestly scoped to the atomic claim only

This package's `resumeApproval` (backing "approve human tasks", §35.2) performs the documented dedupe-protected atomic claim (architecture §4.4.2's direct-lookup extension: `AartStore.runs.hasDedupeKey`/`recordDedupeKey` inside one `transact()`) and a minimal run-state update (`status -> "running"`, resolved wait removed) — it deliberately does **not** re-derive `step.if`/`then`/`else`/`next` and run the step-loop forward, which is the real bound `Engine.resumeApproval`'s job (S1). Swaps for the real one at S9 merge with zero call-site change (same `(runId, stepId, task) => Promise<ResumeOutcome>` shape, S1's Seam 1/4).

### This package's own HTTP surface, for whoever wires topology at S9

`@aart/dashboard` is its own standalone `node:http` server (`startDashboard(config)`, default port 4000 — distinct from S2's control-plane 8080 and worker health's 8787), reading via an injected `ApiClient` (real implementation is a plain `fetch` client against a live `aart server`) and writing via the `DashboardDeps` DI container documented in `deps.ts`. Full route list (all in `server.ts`): `GET /`, `/health`, `/runs[/:id][/trigger]`, `/workflows[/:id][/approve|/promote|/risk-diff|/block-promotion|/unblock-promotion|/mark-needs-review|/clear-needs-review|/trigger-improvement]`, `/blocks`, `/packs`, `/artifacts`, `/waiting-runs`, `/approvals[/:id/decision]`, `/corrections[/new][/:key/update-run-output|/create-eval-example|/create-issue]`, `/evals[/new][/suites|/runs]`, `/environments`, `/deployments`, `/trigger-configs`, `/secrets`, `/worker-health`, `/flagged-runs[/:runId/clear]`. Not mounted into S2's reserved `/dashboard/*` path (S2's own SEAMS.md note: "S8's own content is not implemented here") — that wiring, if wanted, is S9's to do.
