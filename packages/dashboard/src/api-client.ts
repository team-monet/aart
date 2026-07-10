// ApiClient — the read boundary architecture §13.1's `[DECISION]` names:
// "server-rendered... reading directly from @aart/store via @aart/server's
// HTTP API." This interface matches S2's (`@aart/server`) documented HTTP
// route list EXACTLY (SEAMS.md "@aart/server's HTTP API surface — for
// @aart/dashboard (S8)") — every method here corresponds to one confirmed
// S2 route, nothing invented.
//
// Two implementations:
//  - createHttpApiClient(baseUrl): the real one, for pointing at a live
//    `aart server` process.
//  - createFakeApiClient(store): reads the SAME data directly from an
//    AartStore — the natural fit for `aart dev`'s single-process local
//    topology (architecture §14's Local mode) and for this package's own
//    tests, which have no live S2 process to hit (S2 is a concurrent
//    Wave-1 sibling on its own branch, not present in this worktree).
//
// Worker health (ADR-16/§16) is intentionally a separate per-URL method,
// not baked into one fixed base URL — architecture §13.3: "worker health
// surfaces the ADR-16 health endpoint... per registered worker," i.e. N
// workers, N independent health listeners.
import type { AartStore } from "@aart/store";
import type { Deployment, Environment, RejectedTrigger, RunRecord, RunStatus, WaitCondition } from "@aart/types";

export interface WaitingRunEntry {
  runId: string;
  stepId: string;
  wait: WaitCondition;
  createdAt: string;
}

export interface HealthPayload {
  status: "ok";
  claimedRuns: number;
  uptime: number;
  version: string;
}

export interface ApiClient {
  listRuns(filter?: { status?: RunStatus; workflowId?: string }): Promise<RunRecord[]>;
  getRun(id: string): Promise<RunRecord | undefined>;
  listWaitingRuns(): Promise<WaitingRunEntry[]>;
  listFlaggedRunsViaApi(): Promise<RunRecord[]>;
  listWorkflowIds(): Promise<string[]>;
  listEnvironments(): Promise<Environment[]>;
  listDeployments(): Promise<Deployment[]>;
  listRejectedTriggers(): Promise<RejectedTrigger[]>;
  controlPlaneHealth(): Promise<{ status: string }>;
  workerHealth(workerUrl: string): Promise<HealthPayload>;
}

// ---------------------------------------------------------------------------
// Real HTTP implementation
// ---------------------------------------------------------------------------

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return (await res.json()) as T;
}

/** `baseUrl` should point at a live `aart server`'s HTTP API (default port 8080 per S2's `ServerConfig.port` default, documented in SEAMS.md — not hardcoded here, caller supplies it). */
export function createHttpApiClient(baseUrl: string): ApiClient {
  const base = baseUrl.replace(/\/$/, "");
  return {
    async listRuns(filter) {
      const params = new URLSearchParams();
      if (filter?.status) params.set("status", filter.status);
      if (filter?.workflowId) params.set("workflowId", filter.workflowId);
      const qs = params.toString();
      const { runs } = await getJson<{ runs: RunRecord[] }>(`${base}/runs${qs ? `?${qs}` : ""}`);
      return runs;
    },
    async getRun(id) {
      const res = await fetch(`${base}/runs/${encodeURIComponent(id)}`);
      if (res.status === 404) return undefined;
      if (!res.ok) throw new Error(`GET /runs/${id} -> ${res.status}`);
      const { run } = (await res.json()) as { run: RunRecord };
      return run;
    },
    async listWaitingRuns() {
      const { waits } = await getJson<{ waits: WaitingRunEntry[] }>(`${base}/waiting-runs`);
      return waits;
    },
    async listFlaggedRunsViaApi() {
      const { runs } = await getJson<{ runs: RunRecord[] }>(`${base}/flagged-runs`);
      return runs;
    },
    async listWorkflowIds() {
      const { workflowIds } = await getJson<{ workflowIds: string[] }>(`${base}/workflows`);
      return workflowIds;
    },
    async listEnvironments() {
      const { environments } = await getJson<{ environments: Environment[] }>(`${base}/environments`);
      return environments;
    },
    async listDeployments() {
      const { deployments } = await getJson<{ deployments: Deployment[] }>(`${base}/deployments`);
      return deployments;
    },
    async listRejectedTriggers() {
      const { rejected } = await getJson<{ rejected: RejectedTrigger[] }>(`${base}/rejected-triggers`);
      return rejected;
    },
    async controlPlaneHealth() {
      return getJson<{ status: string }>(`${base}/health`);
    },
    async workerHealth(workerUrl) {
      return getJson<HealthPayload>(`${workerUrl.replace(/\/$/, "")}/health`);
    },
  };
}

// ---------------------------------------------------------------------------
// Store-backed fake — local/embedded topology + this package's own tests.
// ---------------------------------------------------------------------------

export function createFakeApiClient(store: AartStore, options: { workerHealth?: Map<string, HealthPayload> } = {}): ApiClient {
  return {
    async listRuns(filter) {
      return store.runs.list(filter);
    },
    async getRun(id) {
      return store.runs.get(id);
    },
    async listWaitingRuns() {
      return store.waits.list();
    },
    async listFlaggedRunsViaApi() {
      const failed = await store.runs.list({ status: "failed" });
      return failed.filter((r) => r.flag && !r.flag.clearedAt);
    },
    async listWorkflowIds() {
      return store.workflows.listWorkflowIds();
    },
    async listEnvironments() {
      return store.environments.list();
    },
    async listDeployments() {
      return store.deployments.list();
    },
    async listRejectedTriggers() {
      return store.rejectedTriggers.list();
    },
    async controlPlaneHealth() {
      return { status: "ok" };
    },
    async workerHealth(workerUrl) {
      const health = options.workerHealth?.get(workerUrl);
      if (!health) throw new Error(`no fake worker health registered for ${workerUrl}`);
      return health;
    },
  };
}
