// DashboardConfig — the composition-root shape `createDashboardServer`
// takes. Mirrors @aart/server's own `ServerConfig`/`StartWorkerOptions`
// pattern (documented tunables with defaults) rather than inventing a
// different shape for this package.
import type { AartStore } from "@aart/store";
import type { ApiClient } from "./api-client.js";
import type { Clock } from "./clock.js";
import type { DashboardDeps } from "./deps.js";

export interface DashboardConfig {
  api: ApiClient;
  /**
   * AMENDMENTS.md A47: OPTIONAL as of this session — every data-bearing
   * route now reads/writes through `api` alone (server.ts's own header
   * comment), so a real `AartStore` is no longer load-bearing for the
   * common (HTTP-backed, `createHttpApiClient`) topology. The two
   * remaining consumers (`/blocks`+`/blocks/:id`'s capability-catalog
   * lookup, and `deps`'s own construction when `deps` is ALSO omitted) are
   * structural only — neither ever performs store I/O (capability-catalog.ts's
   * own doc comment: block manifests are a pure, static, in-memory
   * construction) — so `startDashboard` falls back to an always-valid,
   * never-persisted store (`os.tmpdir()`-rooted) when this is omitted,
   * rather than requiring every caller to know/construct a meaningless
   * path. Still accepted explicitly for the local (`aart dev`,
   * single-process, `createFakeApiClient`) topology, where it IS
   * load-bearing.
   */
  store?: AartStore;
  /**
   * AMENDMENTS.md A47: OPTIONAL as of this session, for the same reason
   * `store` is — `deps`'s remaining router-reachable fields (`redact`,
   * `createReportRenderers`) never touch a store either. Falls back to
   * `createStubDeps` bound to the SAME internal placeholder store used for
   * `store`'s own default, when omitted.
   */
  deps?: DashboardDeps;
  clock?: Clock;
  /** Default 4000 — distinct from @aart/server's control-plane default (8080, SEAMS.md) and the worker health default (8787, ADR-16). */
  port?: number;
  /** Worker health-endpoint URLs (ADR-16) this dashboard polls per registered worker for the §35.3 worker-health page — e.g. `["http://worker-1:8787"]`. Empty by default (no workers registered). */
  workerUrls?: readonly string[];
  /**
   * V2 Wave 2A (activity feed live updates, AMENDMENTS.md A66) — how often
   * `GET /api/events/stream` (server.ts) polls `api.listEvents()` for
   * newly-appended events. Default `DEFAULT_EVENTS_STREAM_POLL_INTERVAL_MS`
   * (1500ms, the ratified design's own specified interval). Overridable
   * mainly so tests can observe a live update without a multi-second
   * real-time wait — production callers should leave this at its default.
   */
  eventsStreamPollIntervalMs?: number;
}

export const DEFAULT_DASHBOARD_PORT = 4000;
export const DEFAULT_EVENTS_STREAM_POLL_INTERVAL_MS = 1500;
