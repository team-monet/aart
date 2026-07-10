// @aart/server — control plane, worker runtime, trigger subsystem, bundle
// production, environments/deployments/promotion (architecture §0.1-0.3,
// §6, §14). See SEAMS.md for the exact signatures @aart/cli's thin
// `bundle`/`worker`/`server` commands (architecture §1 note) call into.

// --- composition-root entry points (the CLI-command seams) ---
export { startServer, type ServerHandle } from "./http/server.js";
export { startWorker, type StartWorkerOptions, type WorkerHandle } from "./worker/worker.js";
export { produceBundle, writeBundleToDisk, type Bundle, type BundleManifest, type ProduceBundleParams } from "./bundle/bundle.js";

// --- config ---
export * from "./config.js";
export { systemClock, type Clock } from "./clock.js";
export { createServerLogger, type Logger } from "./logger.js";
export { generateId } from "./ids.js";

// --- engine boundary — see engine/boundary.ts's doc comments. createFakeEngine
// is what S2's own tests wire (real RunRecord/job_queue writes, no real
// step execution); createRealEngineBoundary (S10 completion) is the thin
// adapter over a real @aart/engine Engine that a real composition root
// (e.g. a worker process) constructs and injects into startServer/
// startWorker's SharedRuntimeConfig.engine field. ---
export { createFakeEngine, createRealEngineBoundary, type EngineBoundary, type ResumeResult, type StartRunParams, type StartRunResult } from "./engine/boundary.js";

// --- the flagged-run clear write path (dashboard/CLI only, deliberately NOT MCP-exposed — architecture §13.3) ---
export { clearRunFlag, listFlaggedRuns, type ClearRunFlagResult } from "./flags.js";

// --- environments / deployments / promotion (architecture ADR-06/ADR-07) ---
// S9 integration (reconciliation ledger item 2): computeApprovalState/
// computePromotionState/evaluatePromotionForEnvironment/PromotionRecord/
// REQUIRED_GATES_BY_MODE are @aart/governance's real exports, re-exported
// here (via promotion.js) unchanged - this package no longer carries its
// own mirror. See promotion.ts's own header comment for the full story.
export { registerEnvironment, rollbackDeployment, type RegisterEnvironmentParams, type RollbackResult } from "./environments.js";
export {
  computeApprovalState,
  computePromotionState,
  evaluatePromotionForEnvironment,
  promoteWorkflowVersionToEnvironment,
  requiredGatesForEnvironment,
  REQUIRED_GATES_BY_MODE,
  type GateName,
  type PromotionEvaluation,
  type PromotionRecord,
  type PromoteToEnvironmentParams,
  type PromoteToEnvironmentResult,
} from "./promotion.js";

// --- trigger subsystem (architecture §6) ---
export * from "./triggers/types.js";
export { verifyHmacSignature, computeHmacSignature } from "./triggers/hmac.js";
export { processTriggerIntake, recordRejectedTrigger, resolveTriggerMapping, correlationKeyFor } from "./triggers/intake.js";
export { loadTriggerBindingsFromDeployments, loadScheduleBindings } from "./triggers/registry.js";
export * as triggerAdapters from "./triggers/adapters.js";

// --- scheduler ticker (architecture §4.4.3/§4.7) ---
export { createTicker, type TickerHandle, type TickerOptions, type TickResult } from "./ticker/ticker.js";
export { parseCron, cronMatches, cronFireTimesBetween } from "./ticker/cron.js";

// --- worker liveness internals (exposed for tests/composition; startWorker wires these together already) ---
export { tryClaimNextRun } from "./worker/claim.js";
export { startLeaseHeartbeat } from "./worker/lease.js";
export { runReclaimSweep, type ReclaimSweepResult } from "./worker/reclaim.js";
export { gracefulShutdown } from "./worker/shutdown.js";
export { startHealthServer, type HealthPayload, type HealthServerHandle } from "./worker/health.js";

// --- backpressure / poison-run guard (architecture §6.2) ---
export { isOverBackpressureCeiling, isPoisonFlagged, shouldFlagPoison } from "./poison.js";

// --- bundle closure internals ---
export { computeClosure, resolveClosureRegistryEntries, type ClosureResult, type ResolvedClosure } from "./bundle/closure.js";
