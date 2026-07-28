// Shared engine-level types — @aart/engine's own composition surface on top
// of @aart/types' frozen shapes. Nothing here is a spec/architecture type in
// its own right; this is how this package wires the frozen dependency-
// injection seams (CapabilityCheck, RedactFn, BlockImplementation) together
// into one constructor-injected `Engine` (architecture §4.6/§7.9's
// "constructor injection at process start" framing).
import type { SecretResolver } from "@aart/expr";
import type { AartStore } from "@aart/store";
import type {
  BlockExecutionContext,
  BlockImplementation,
  CapabilityCheck,
  LlmCallMetadata,
  RedactFn,
  RunRecord,
  Signal,
  Trigger,
  Workflow,
} from "@aart/types";

/**
 * S9 integration (reconciliation ledger item 6, SEAMS.md L3): `@aart/llm`'s
 * `llm.*` blocks optional-chain-call `ctx.recordLlmCall?.(metadata)` against
 * exactly this shape (`packages/llm/src/blocks/core.ts`'s
 * `LlmBlockExecutionContext` — structurally identical, declared separately
 * here rather than imported so `@aart/engine` stays block-catalog-agnostic,
 * matching this file's own stated design: "the engine itself is
 * block-catalog-agnostic, it only knows the BlockImplementation contract").
 * Real dispatch (step-executor.ts's `buildBlockContext`) now supplies this
 * method for every block, not just `llm.*` ones — a non-`llm.*` block that
 * never calls it is unaffected (the method is simply never invoked).
 */
export interface EngineBlockExecutionContext extends BlockExecutionContext {
  recordLlmCall?(metadata: LlmCallMetadata): void;
}

/**
 * Every block this engine instance can dispatch to, keyed by `BlockManifest.id`
 * (architecture §2.5). `@aart/blocks-core`/`@aart/llm` (S3/S7) build the real
 * catalog; this package's own tests register small fixture implementations
 * — the engine itself is block-catalog-agnostic, it only knows the
 * `BlockImplementation` contract (architecture §2.5) plus the fixed
 * wait-block-id vocabulary (`wait/wait-blocks.ts`) that gets engine-level
 * special-casing.
 */
export type BlockRegistry = Record<string, BlockImplementation>;

/** Convenience constructor keyed by each implementation's own `manifest.id` — avoids every caller hand-writing the same `Object.fromEntries` line. */
export function createBlockRegistry(implementations: BlockImplementation[]): BlockRegistry {
  const registry: BlockRegistry = {};
  for (const impl of implementations) {
    registry[impl.manifest.id] = impl;
  }
  return registry;
}

/**
 * Resolves the capability grant set for a run's capability-dispatch checks
 * (architecture §4.6). The frozen `CapabilityCheck` type (`@aart/types`) is
 * the pure `(declared, granted) => boolean` predicate; something still has
 * to produce `granted` in the first place — that's this callback's job.
 * `@aart/governance` (S4) owns the real policy computation (approval state +
 * capability closure + standing approvals, architecture §4.6); this
 * package's default (`alwaysEmptyGrantedCapabilities`, capability.ts) pairs
 * with the always-allow `CapabilityCheck` stub so engine's own tests aren't
 * blocked on governance landing.
 *
 * `environment` is threaded through from `TriggerRunInput` (never persisted
 * as its own `RunRecord` field — see `run-lifecycle.ts`'s doc comment on
 * `params.environment` — but available live on every call since a resumed
 * run rehydrates it from `run.params.environment`).
 */
export type GetGrantedCapabilities = (workflow: Workflow, environment: string | undefined) => string[] | Promise<string[]>;

/**
 * Constructor-injected engine configuration (architecture §4.6/§7.9's
 * "accepts ... via constructor injection at process start" framing,
 * applied uniformly to every DI seam this engine consumes). `redact` and
 * `capabilityCheck` are the two frozen-type seams (`RedactFn`,
 * `CapabilityCheck`, both `@aart/types`); everything else here is this
 * package's own composition surface, not a frozen shape.
 */
export interface EngineConfig {
  store: AartStore;
  /**
   * Dependency-injected secret lookup (architecture §3.2's `[DECISION]` —
   * `@aart/expr` never resolves `secrets.*` itself). This engine wraps the
   * supplied resolver in a tracking layer (`redaction.ts`'s
   * `createTrackingSecretResolver`) so every name actually resolved during
   * an execution segment is captured into that segment's `resolvedSecretRefs`
   * set, which is what gets threaded into every `RedactFn` call for that
   * segment (architecture §4.6/§7.9). Also used, identically wrapped, to
   * build each dispatched block's `ctx.resolveSecret` (architecture §2.5).
   * Defaults to a resolver that always throws `SecretResolutionError` — a
   * workflow that never references `secrets.*` never calls it, so this
   * default is only observable if a test/fixture actually exercises secret
   * resolution without configuring one.
   */
  resolveSecret?: SecretResolver;
  /** Constructor-injected, process-lifetime (architecture §4.6/§7.9). The per-run `resolvedSecretRefs` set is threaded fresh on every call by this package — see `redaction.ts`. */
  redact: RedactFn;
  /** Constructor-injected, process-lifetime (architecture §4.6). `@aart/engine`'s own tests default to `alwaysAllowCapabilityCheck` (capability.ts) — the trivial stub this session ships per its DoD; `@aart/governance` wires the real implementation in at the composition root. */
  capabilityCheck: CapabilityCheck;
  /** See `GetGrantedCapabilities` above. Defaults to `alwaysEmptyGrantedCapabilities` (capability.ts), which — paired with the default `alwaysAllowCapabilityCheck` — makes the out-of-the-box engine behavior "allow everything," matching "engine's own tests don't block on governance's real policy logic landing." */
  getGrantedCapabilities?: GetGrantedCapabilities;
  blocks: BlockRegistry;
  /** Optional per-run resolver used to dispatch a Pack implementation pinned by the run snapshot instead of the process-global active version. */
  resolveBlockForRun?: (run: RunRecord, blockId: string) => BlockImplementation | undefined;
  /**
   * Engine/deployment-level config, NOT a per-workflow declaration (architecture
   * §4.2) — this is what keeps a workflow author from raising their own bound.
   * Default: 10,000. Reuses `IterationLimitExceededError` (architecture §4.2/§8),
   * `detail.kind: "forEach"`, distinct from a guarded-back-edge breach
   * (`detail.kind: "guardedBackEdge"`).
   */
  forEachArrayLimit?: number;
  /** Engine-code schema-version tag stamped onto every persisted `WaitCondition`/`RunRecord` this engine instance writes, and checked for compatibility on every resume (architecture §4.7). Defaults to `CURRENT_ENGINE_SCHEMA_VERSION` (schema-version.ts, currently `2`) — override only to simulate a different engine version in tests (the rolling-upgrade/version-skew test fixture deliberately does this). */
  schemaVersion?: number;
  /** Injectable clock, defaults to `() => new Date()`. */
  now?: () => Date;
  /** Pure function computing a retry backoff delay in ms, given the (1-based) attempt number about to be retried and the step's `RetryPolicy`. Defaults to `backoff === "exponential"` doubling from a 50ms base, `0` for any other/absent `backoff` value (spec §30.3 only confirms "exponential"; architecture leaves the rest of the enum open, §A10). Override in tests to return `0` for fast, deterministic retry tests. */
  computeRetryDelayMs?: (attempt: number, backoff: string | undefined) => number;
  /** S9 integration (reconciliation ledger item 8): computes `ExecutionSnapshot.packHashes` at snapshot-capture time (snapshot.ts). Defaults to `alwaysEmptyPackHashes` (today's pre-integration behavior — an empty record) since the frozen `BlockManifest` carries no pack-provenance field this package could use to derive it unassisted; the real composition root wires @aart/registry's `computePackContentHash` here, fed whatever pack-provenance mapping that root's own catalog assembly maintains. */
  computePackHashes?: import("./snapshot.js").ComputePackHashes;
  /**
   * S9 integration (reconciliation ledger item 10, SEAMS.md S3-E1): called
   * once a run reaches a terminal status (`finalizeTerminal`/`cancelRun`,
   * run-lifecycle.ts), AFTER the terminal `RunRecord` is durably persisted
   * and any queued same-key run is released — the same per-run resource-
   * cleanup cadence `@aart/blocks-core`'s browser-session manager asked for
   * ("the engine... once a run reaches a terminal status... should call
   * closeBrowserSession(runId)"). Deliberately a generic
   * `(runId) => void|Promise<void>` hook, not a `@aart/blocks-core` import —
   * this package stays block-catalog-agnostic (types.ts's own framing);
   * the real composition root wires `onRunTerminal: (runId) =>
   * closeBrowserSession(runId)`. Defaults to a no-op. Failures are caught
   * and logged by the caller, never allowed to fail the run's own terminal
   * transition (resource cleanup is best-effort, not correctness-critical).
   */
  onRunTerminal?: (runId: string) => void | Promise<void>;
  /**
   * S9 integration (reconciliation ledger item 7): the effectful-capability
   * set architecture §9.5's dry-run mechanism checks a dispatched block's
   * declared capabilities against (`step-executor.ts`'s `dispatchOnce`).
   * Defaults to `@aart/types`'s `DEFAULT_EFFECTFUL_CAPABILITIES`
   * (`["email.send", "command", "db.write"]` plus the `domain:<pattern>`
   * family via `isEffectfulCapability`) — the same shared source
   * `@aart/evidence`'s own eval-suite-fixture dry-run mechanism now also
   * imports, closing the divergence risk root SEAMS.md's E6 entry flagged.
   */
  effectfulCapabilities?: readonly string[];
}

/** `triggerRun`'s input (architecture §4.3's trigger-intake path; also what S2's trigger adapters call — "trigger adapters call into the engine's run-intake function," implementation plan S2 consumed-interfaces note). */
export interface TriggerRunInput {
  workflow: Workflow;
  trigger: Trigger;
  inputs: Record<string, unknown>;
  /** Per-run execution options (spec §19.1) — merged into `RunRecord.params` alongside this package's own internal bookkeeping keys (`waitingOnConcurrency`, `environment` — see `run-lifecycle.ts`). */
  params?: Record<string, unknown>;
  /** Threaded through to `getGrantedCapabilities` on every step dispatch for this run's lifetime (architecture ADR-06: resolved per claimed run, never a process-start global) — see `GetGrantedCapabilities`'s doc comment on why this isn't a `RunRecord` schema field. */
  environment?: string;
  /** Captured onto `RunRecord.approved`/`approvalMode` verbatim (spec §19.1: "captured once at trigger time," not re-derived later). Defaults to `{ approved: true, approvalMode: "dev" }` — a real composition root supplies governance's actual computed values; engine itself has no opinion on approval policy. */
  approved?: boolean;
  approvalMode?: RunRecord["approvalMode"];
}

/** The three resume mechanisms (architecture §4.4.1's consolidation) that can complete a `resolveWait` call, recorded on the result for callers/tests that want to assert *how* a wait resolved, not just that it did. */
export type ResumeMechanism = "signal-matched" | "scheduler-tick" | "direct-lookup";

export type ResumeOutcome =
  | { kind: "resumed"; run: RunRecord; mechanism: ResumeMechanism }
  /** Duplicate delivery / already-consumed wait — architecture §4.4.2's dedupe no-op. Not an error: this is the exactly-once guarantee working as designed. */
  | { kind: "duplicate"; mechanism: ResumeMechanism }
  /** Zero matching outstanding wait — architecture §4.4.2 step 2: "log unmatched signal for later inspection," not a crash. */
  | { kind: "unmatched"; mechanism: ResumeMechanism };

/**
 * A due wait as returned by `getDueWaits` — architecture §4.4.3/§4.7's named
 * scheduler-ticker seam. Deliberately narrow (just enough for S2's ticker to
 * decide what to do next), not a full `RunRecord`. `[DECISION]` scoped to
 * `timer` waits only, matching `WaitStore.listDue`'s actual (S0-built,
 * conformance-tested) semantics — "every `timer`-type wait whose
 * `resumeAt` has passed." `external_job`'s poll sub-path has no comparable
 * deadline field on the frozen `WaitCondition` shape to check a "due-ness"
 * predicate against (it polls on an interval until the provider reports
 * completion, not until a fixed timestamp) — see `wait/wait-machine.ts`'s
 * `listExternalJobWaits` for the query S2's poll mechanism uses instead,
 * and `resumeExternalJobResult` for the resume call it makes once a poll
 * reports completion.
 */
export interface DueWait {
  runId: string;
  stepId: string;
  wait: Extract<import("@aart/types").WaitCondition, { type: "timer" }>;
}

/** What one call through the block-dispatch pipeline needs beyond the frozen `BlockExecutionContext` (block.ts) — this package constructs the real `BlockExecutionContext` per dispatch (architecture §2.5: "its exact shape is S1's to specify... since the engine is BlockExecutionContext's only caller and constructor"); this internal type is this package's own bookkeeping, never exposed to a block. */
export interface DispatchContext extends BlockExecutionContext {}

// Re-exported for callers that want to build a resolved-secret-refs set the
// same way this package's own step executor does — see redaction.ts.
export type ResolvedSecretRefs = ReadonlySet<string>;

/** A signal-shaped resume request — separated from `@aart/types`' `Signal` only in that callers resuming a `webhook`/`queue`/`external_job`-webhook-subpath wait construct one identically; kept as a type alias for call-site clarity, not a distinct shape. */
export type ResumeSignal = Signal;
