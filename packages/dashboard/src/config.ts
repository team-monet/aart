// DashboardConfig — the composition-root shape `createDashboardServer`
// takes. Mirrors @aart/server's own `ServerConfig`/`StartWorkerOptions`
// pattern (documented tunables with defaults) rather than inventing a
// different shape for this package.
import type { AartStore } from "@aart/store";
import type { ApiClient } from "./api-client.js";
import type { Clock } from "./clock.js";
import type { DashboardDeps } from "./deps.js";

export interface DashboardConfig {
  store: AartStore;
  api: ApiClient;
  deps: DashboardDeps;
  clock?: Clock;
  /** Default 4000 — distinct from @aart/server's control-plane default (8080, SEAMS.md) and the worker health default (8787, ADR-16). */
  port?: number;
  /** Worker health-endpoint URLs (ADR-16) this dashboard polls per registered worker for the §35.3 worker-health page — e.g. `["http://worker-1:8787"]`. Empty by default (no workers registered). */
  workerUrls?: readonly string[];
}

export const DEFAULT_DASHBOARD_PORT = 4000;
