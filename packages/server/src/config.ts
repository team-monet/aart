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
  /**
   * D2a security hardening, breaking-change bind default (AMENDMENTS.md
   * A59) — which interface `aart server` binds. Unset -> `DEFAULT_HTTP_HOST`
   * (`"127.0.0.1"`, loopback-only, this session's new default — see that
   * constant's own doc comment for the full rationale). Set to `"0.0.0.0"`
   * (or a specific routable IP) to accept connections from other hosts/
   * containers — required for any deployment where a different process
   * (a worker's Docker network alias, a dashboard container, a genuinely
   * remote `aart push`) needs to reach this server. Threaded from
   * `--host`/`AART_HOST` (`@aart/cli`'s `real-server-port.ts`/`commands/
   * process.ts` — flag wins over env, mirroring `--environment`/
   * `AART_ENVIRONMENT`'s established precedent).
   */
  host?: string;
}

export interface ServerConfig extends SharedRuntimeConfig, TickerConfig, PoisonGuardConfig, BackpressureConfig, ServerHttpConfig {
  /** Runs the ticker loop in-process alongside the HTTP API — true for `aart server`, also true for `aart dev` (one process, architecture §0.2). Set false if a caller wants to host the HTTP API without also owning the (single-instance, architecture §4.4.3) ticker — e.g. a test harness. Defaults to true. */
  runTicker?: boolean;
  /** architecture §7.2's PR-merge-as-approval ingestion — see triggers/adapters.ts's `ingestGithubPrMergeApproval` doc comment for why this mapping is a documented integration point rather than a guessed convention. Omit to leave PR-merge ingestion a no-op. */
  resolveGithubApprovalTarget?: (payload: unknown) => { runId: string; stepId: string } | undefined;
  /** AMENDMENTS.md A45 — restricts which `Deployment`-sourced trigger bindings (webhook/github/slack/poll ingress, both the HTTP layer and the ticker's poll loop) this server instance activates, by `Environment` id. Threaded straight into `loadTriggerBindingsFromDeployments`'s own `filter.environmentId` (triggers/registry.ts) everywhere this config loads bindings. Unset (the default) activates every deployment's trigger across every environment — a documented dev convenience, not a production isolation guarantee. `@aart/cli`'s `--environment <name>` (real-server-port.ts) resolves the human-readable name to this id before constructing this config. */
  environmentId?: string;
  /**
   * D1 "remotes + push" (AMENDMENTS.md A56); scope widened by D2a security
   * hardening (AMENDMENTS.md A59) — the shared bearer token gating EVERY
   * mutation route on this server EXCEPT the three `/webhooks/*` routes
   * (separate, per-binding HMAC verification, `secretResolver` above,
   * completely untouched). Two tiers, unchanged from D1/D1-fix-pass in
   * shape, just applied uniformly now instead of to three routes alone
   * (see `deploy-token.ts`'s `checkAnyDeployToken`, and http/server.ts's
   * `requireDeployToken`/`requireDeployTokenIfConfigured`):
   *   - fail-closed (`POST /bundles/ingest`, `POST /bundles/plan`, `POST
   *     /environments`) — unset leaves these refusing every request
   *     unconditionally; there is no "auth disabled" state for this tier.
   *   - conditionally gated (every other mutation route, `POST
   *     /workflows/:id/promote` included) — unset leaves these OPEN
   *     (unchanged pre-D2a behavior, so a tokenless local/dev/TEST-DRIVE
   *     deployment keeps working); set, they require the same valid Bearer
   *     the fail-closed tier does.
   * Resolved ONCE at startup by the caller (`@aart/cli`'s
   * `resolveDeployToken`, secrets.ts) and threaded in here — this config
   * never re-resolves it itself, matching how `secretResolver` above is
   * already an injected value, not a self-resolving one.
   */
  deployToken?: string;
  /**
   * D2a security hardening, token rotation (AMENDMENTS.md A59) — a SECOND
   * valid bearer token, checked alongside `deployToken` above by every
   * gated route (`checkAnyDeployToken`, deploy-token.ts) so an operator can
   * roll a compromised/expiring token without a hard cutover: publish the
   * new value here as `deployTokenNext` (callers may start using it
   * immediately, both tokens accepted), then once every caller has
   * switched, promote it to `deployToken` proper and clear this field.
   * Resolved the same way as `deployToken` (`@aart/cli`'s
   * `resolveDeployTokenNext`, secrets.ts, reading `AART_DEPLOY_TOKEN_NEXT`)
   * — unset (the default) changes nothing: `checkAnyDeployToken` with only
   * one configured token behaves byte-identically to the pre-rotation
   * `checkDeployToken` single-token check.
   */
  deployTokenNext?: string;
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
/** D1 "remotes + push" (AMENDMENTS.md A56) — hard request-body cap for `POST /bundles/ingest` and `POST /bundles/plan` (http/server.ts, `Router.post`'s `maxBodyBytes` option). Bundles are 100% JSON text (bundle.ts's own doc comment) — 10MB is generous headroom for a real workflow closure while still bounding memory a single deploy-surface request can force this process to buffer. */
export const MAX_BUNDLE_INGEST_BYTES = 10 * 1024 * 1024;
/**
 * D2a security hardening (AMENDMENTS.md A59) — the GLOBAL default body cap
 * `Router.handle` (http/router.ts) now applies to every route that doesn't
 * pass its own `maxBodyBytes` (previously: no cap at all, unless a route
 * opted in — see `RouteOptions.maxBodyBytes`'s own doc comment history).
 * Control-plane bodies (trigger inputs, approval decisions, correction
 * records, eval suite definitions, ...) are small JSON payloads by
 * construction; 1MB is generous headroom for any of them while still
 * bounding the memory an unauthenticated-until-this-session, now
 * conditionally-gated caller could force this process to buffer per
 * request. The two bundle routes keep their own, much larger, explicit
 * `MAX_BUNDLE_INGEST_BYTES` cap above — this default only applies where no
 * explicit `maxBodyBytes` is given.
 */
export const DEFAULT_MAX_BODY_BYTES = 1_048_576;
/**
 * D2a security hardening, breaking-change bind default (AMENDMENTS.md A59,
 * John-ratified 2026-07-12) — `aart server` now binds loopback-ONLY by
 * default, not every interface. Rationale: with D2a's own auth middleware
 * (this file's `deployToken`) closing the "every mutation route is
 * unauthenticated" gap, the remaining honest default for a process nobody
 * explicitly asked to expose is "reachable only from THIS machine," matching
 * the "trusted local = localhost+tokenless" framing this ruling adopted —
 * a tokenless local/dev/TEST-DRIVE server stays fully usable from
 * `localhost`, and a genuinely remote/production deployment must now opt in
 * explicitly via `--host`/`AART_HOST` (real-server-port.ts, commands/
 * process.ts) — see DEPLOY.md's "Network binding" section for the full
 * migration note (docker-compose.yml's `server` service, and any bare-
 * process/systemd deployment, must add `--host 0.0.0.0` or a specific
 * routable IP, or it silently becomes unreachable from any OTHER container/
 * host on upgrade).
 */
export const DEFAULT_HTTP_HOST = "127.0.0.1";
