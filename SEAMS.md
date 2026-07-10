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
}
```

Every `Engine`-bound resume method **continues execution past the resumed step** (re-derives `step.if`/`then`/`else`/`next` and runs the step-loop forward to the next wait/terminal status) — this is the version S2's ticker and trigger adapters should call, not the standalone claim-only functions in Seam 1.

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
