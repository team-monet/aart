import type { AartStore } from "@aart/store";
import type { Clock } from "./clock.js";
import type { EngineBoundary } from "./engine/boundary.js";
import type { LogSink } from "./logger.js";

/** Resolves a `secrets.<NAME>`-style reference to its value — the same injected-resolver discipline `@aart/expr`/governance use elsewhere (architecture §3.2/§31.2). Required for real webhook HMAC verification (architecture §6.1: "the HMAC secret is itself a `secrets.<NAME>`-referenced value... never a plaintext config value"). */
export type SecretResolver = (ref: string) => Promise<string | undefined> | string | undefined;

export interface SharedRuntimeConfig {
  store: AartStore;
  engine: EngineBoundary;
  clock?: Clock;
  logSink?: LogSink;
  secretResolver?: SecretResolver;
}

export interface TickerConfig {
  /** Architecture §4.4.3 micro-decision #15: "10s default dev, 5s production (tunable)." Neither value is auto-selected by this package — the caller (aart dev vs aart server, @aart/cli's job) picks which to pass. Defaults to 5000 (the production figure) since an explicit config is the norm for a production-shaped process; @aart/cli's `aart dev` wiring should pass 10_000. */
  tickIntervalMs?: number;
}

export interface AdmissionConfig {
  /** Worker-level admission control (architecture §4.3) — a cap checked before claiming from `job_queue`, independent of any per-workflow `ConcurrencyPolicy`. */
  maxConcurrentRuns?: number;
}

export interface LeaseConfig {
  /** How long a claim's lease is valid without a heartbeat renewal (architecture §4.7). */
  leaseDurationMs?: number;
  /** How often the worker renews its lease on actively-claimed runs. Should be meaningfully shorter than leaseDurationMs. */
  heartbeatIntervalMs?: number;
  /** Bounded retry count before a reclaimed run is flagged `reclaim_exhausted` rather than requeued again (architecture §4.7). */
  maxReclaimCount?: number;
  /** Grace period graceful SIGTERM shutdown waits for in-flight work to reach a checkpoint before forcing release (architecture §4.7). */
  shutdownGraceMs?: number;
  /**
   * S9 integration (reconciliation ledger item 10, SEAMS.md S3-E1) — called
   * once during graceful SIGTERM shutdown (worker/shutdown.ts), AFTER the
   * claim-drain/release loop, as a coarser safety-net alongside the
   * engine's own per-run `onRunTerminal` hook: catches whatever a
   * force-released or crashed run's per-run close missed (e.g. a run still
   * claimed when the grace period elapsed). Deliberately generic
   * (`() => void|Promise<void>`), not a `@aart/blocks-core` import — same
   * layering reasoning as `EngineConfig.onRunTerminal`. The real
   * composition root wires `onShutdown: () => closeAllBrowserSessions()`.
   * Defaults to a no-op. Failures are caught and logged, never allowed to
   * block process exit.
   */
  onShutdown?: () => void | Promise<void>;
}

export interface PoisonGuardConfig {
  /** Consecutive-failure threshold on one correlation key within `windowMs` before the run is flagged `poison` (architecture §6.2). */
  maxConsecutiveFailures?: number;
  windowMs?: number;
}

export interface BackpressureConfig {
  /** `job_queue` pending-count ceiling above which new triggers are shed (architecture §6.2). */
  maxPendingRuns?: number;
}

export interface WorkerConfig extends SharedRuntimeConfig, TickerConfig, AdmissionConfig, LeaseConfig, PoisonGuardConfig {
  /** Stable identity for this worker process — used as `job_queue.claimed_by` and in the `/health` payload. Defaults to a generated id if omitted. */
  workerId?: string;
  /** Port for the worker's own lightweight `GET /health` listener (architecture ADR-16/§16) — separate from the control-plane API. `0` (the Node convention for "pick any free port") is a valid explicit choice; omit to default to 8787. */
  healthPort?: number;
}

export interface ServerHttpConfig {
  port?: number;
}

export interface ServerConfig extends SharedRuntimeConfig, TickerConfig, PoisonGuardConfig, BackpressureConfig, ServerHttpConfig {
  /** Runs the ticker loop in-process alongside the HTTP API — true for `aart server`, also true for `aart dev` (one process, architecture §0.2). Set false if a caller wants to host the HTTP API without also owning the (single-instance, architecture §4.4.3) ticker — e.g. a test harness. Defaults to true. */
  runTicker?: boolean;
  /** architecture §7.2's PR-merge-as-approval ingestion — see triggers/adapters.ts's `ingestGithubPrMergeApproval` doc comment for why this mapping is a documented integration point rather than a guessed convention. Omit to leave PR-merge ingestion a no-op. */
  resolveGithubApprovalTarget?: (payload: unknown) => { runId: string; stepId: string } | undefined;
  /** AMENDMENTS.md A45 — restricts which `Deployment`-sourced trigger bindings (webhook/github/slack/poll ingress, both the HTTP layer and the ticker's poll loop) this server instance activates, by `Environment` id. Threaded straight into `loadTriggerBindingsFromDeployments`'s own `filter.environmentId` (triggers/registry.ts) everywhere this config loads bindings. Unset (the default) activates every deployment's trigger across every environment — a documented dev convenience, not a production isolation guarantee. `@aart/cli`'s `--environment <name>` (real-server-port.ts) resolves the human-readable name to this id before constructing this config. */
  environmentId?: string;
}

export const DEFAULT_TICK_INTERVAL_MS = 5000;
export const DEFAULT_MAX_CONCURRENT_RUNS = 10;
export const DEFAULT_LEASE_DURATION_MS = 30_000;
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
export const DEFAULT_MAX_RECLAIM_COUNT = 3;
export const DEFAULT_SHUTDOWN_GRACE_MS = 30_000;
export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 5;
export const DEFAULT_POISON_WINDOW_MS = 10 * 60 * 1000;
export const DEFAULT_MAX_PENDING_RUNS = 500;
export const DEFAULT_HEALTH_PORT = 8787;
export const DEFAULT_HTTP_PORT = 8080;
