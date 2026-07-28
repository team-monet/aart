// @aart/engine — run lifecycle state machine, step executor, and durable
// wait/resume machine (architecture §4). The architectural core of AART's
// runtime (ADR-02's entire custom-build burden).
//
// Composition root usage: `createEngine({ store, redact, capabilityCheck,
// blocks, ... })` returns a bound `Engine`. Every dependency-injection seam
// this package accepts is documented on `EngineConfig` (types.ts).

export { createEngine, type Engine } from "./engine.js";
export type {
  BlockRegistry,
  DueWait,
  EngineBlockExecutionContext,
  EngineConfig,
  GetGrantedCapabilities,
  ResumeMechanism,
  ResumeOutcome,
  TriggerRunInput,
} from "./types.js";
export { createBlockRegistry } from "./types.js";

// Run lifecycle (architecture §4.1) — also individually importable, for a
// caller that wants the run-intake/execute/cancel functions without
// constructing a full bound `Engine` (e.g. a lightweight test harness).
export { cancelRun, executeRun, triggerRun } from "./run-lifecycle.js";

// The scheduler-ticker seam (architecture §4.4.3/§4.7) — SEAMS.md: S1
// exports `getDueWaits(store, now)` and the wait-claim resume operations;
// S2 owns and runs the interval loop that calls them. `getExpiredWaits`/
// `failExpiredWait` are the wait-TIMEOUT-expiry sibling seam (architecture
// §4.4.1's Expiry note) — a different terminal outcome from resume.
export {
  failExpiredWait,
  getDueWaits,
  getExpiredWaits,
  listExternalJobWaits,
  resumeApproval,
  resumeBySignal,
  resumeExternalJobResult,
  resumeManual,
  resumeTimerWait,
  type WaitMachineConfig,
} from "./wait/wait-machine.js";
export { isWaitBlockId, WAIT_BLOCK_IDS, waitSignalCorrelation, type WaitBlockId } from "./wait/wait-blocks.js";

// Capability dispatch chokepoint (architecture §4.6, ADR-09) — the
// always-allow stub this session ships per its DoD, and the one call site.
export { alwaysAllowCapabilityCheck, alwaysEmptyGrantedCapabilities, checkCapabilityDispatch } from "./capability.js";

// Redaction routing (architecture §4.2/§4.4/§4.6/§7.9) — the identity stub
// this package's own tests wire by default, and the tracking-secret-resolver
// helper a composition root can reuse if it wants the same "which secrets
// were actually touched this segment" bookkeeping outside this package.
export { applyRedaction, createTrackingSecretResolver, identityRedactFn, throwingSecretResolver } from "./redaction.js";

// isolated-vm sandbox for node-type blocks (ADR-08) — a directly-callable
// primitive; see sandbox/node-sandbox.ts's module doc comment for how a
// node-type BlockImplementation's own `execute` is expected to wire this in.
export {
  inspectCommonJsBlockSource,
  inspectCommonJsBlockSourceSync,
  runCommonJsBlockSandbox,
  runNodeSandbox,
  type CommonJsBlockSandboxOptions,
  type NodeSandboxOptions,
} from "./sandbox/node-sandbox.js";

// Engine-code schema-version tag (architecture §4.7).
export {
  assertSchemaVersionCompatible,
  CURRENT_ENGINE_SCHEMA_VERSION,
  isSchemaVersionCompatible,
  SchemaVersionMismatchError,
} from "./schema-version.js";

// ExecutionSnapshot capture (architecture §4.5).
export { captureExecutionSnapshot, isSnapshotCaptured, resolveWorkflowForRun, uncapturedSnapshot } from "./snapshot.js";

// Concurrency policies (architecture §4.3, spec §30.1).
export { decideConcurrency, fingerprintConcurrencyKey, releaseQueuedRuns, resolveConcurrencyKey, type ConcurrencyDecision } from "./concurrency.js";

// Public workflow-result projection shared with @aart/evidence's post-hoc
// correction outcome so materialized RunRecord.outputs never goes stale.
export { materializeWorkflowOutputs } from "./workflow-outputs.js";
export { validateWorkflowOutputs, WorkflowOutputValidationError } from "./output-validation.js";

// Duration-string parsing (`step.timeout`/`WaitCondition.timeout`).
export { parseDurationMs } from "./duration.js";
