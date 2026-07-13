// ApiClient — the read AND write boundary architecture §13.1's `[DECISION]`
// names: "server-rendered... reading directly from @aart/store via
// @aart/server's HTTP API." This interface matches S2's (`@aart/server`)
// documented HTTP route list EXACTLY (SEAMS.md "@aart/server's HTTP API
// surface — for @aart/dashboard (S8)") — every method here corresponds to
// one confirmed S2 route, nothing invented.
//
// AMENDMENTS.md A47: extended from a read-only boundary to a read+write one
// — every dashboard write action (trigger a run, approve/promote a
// workflow, decide an approval task, record/act-on a correction, create/run
// an eval suite, clear a run's flag) now has a corresponding method here
// too, closing the store-divergence bug class (root AMENDMENTS.md A43) for
// writes the same way it was already closed for reads: the dashboard's
// server.ts router no longer touches `AartStore`/`DashboardDeps` for ANY
// data-bearing action, read or write — see server.ts's own header comment.
//
// Two implementations:
//  - createHttpApiClient(baseUrl): the real one, for pointing at a live
//    `aart server` process.
//  - createFakeApiClient(store): reads/writes the SAME data directly
//    against an AartStore — the natural fit for `aart dev`'s single-process
//    local topology (architecture §14's Local mode) and for this package's
//    own tests, which have no live S2 process to hit (S2 is a concurrent
//    Wave-1 sibling on its own branch, not present in this worktree).
//
// Worker health (ADR-16/§16) is intentionally a separate per-URL method,
// not baked into one fixed base URL — architecture §13.3: "worker health
// surfaces the ADR-16 health endpoint... per registered worker," i.e. N
// workers, N independent health listeners.
import type { AartStore } from "@aart/store";
import {
  createFakeEngine,
  decideApprovalTask,
  findCorrectionByKey,
  promoteWorkflowVersionToEnvironment,
  approveOrDeprecateWorkflow as serverApproveOrDeprecateWorkflow,
  createEvalSuite as serverCreateEvalSuite,
  runEvalSuiteForWorkflow,
  type PromoteToEnvironmentResult,
} from "@aart/server";
import {
  blockPromotion as evidenceBlockPromotion,
  clearNeedsReview as evidenceClearNeedsReview,
  createEvalExampleFromCorrection as evidenceCreateEvalExampleFromCorrection,
  createIssueForAgent as evidenceCreateIssueForAgent,
  markNeedsReview as evidenceMarkNeedsReview,
  recordCorrection as evidenceRecordCorrection,
  triggerImprovementProposal as evidenceTriggerImprovementProposal,
  unblockPromotion as evidenceUnblockPromotion,
  updateRunOutput as evidenceUpdateRunOutput,
  type RecordCorrectionInput as EvidenceRecordCorrectionInput,
} from "@aart/evidence";
import { systemClock } from "./clock.js";
import { HttpError } from "./http/router.js";
import { generateId } from "./ids.js";
import type {
  ApprovalTask,
  Correction,
  Deployment,
  EvalExample,
  EvalRun,
  EvalSuite,
  Environment,
  EventLogEntry,
  ImprovementBrief,
  RejectedTrigger,
  RunRecord,
  RunStatus,
  Scorer,
  TrustMode,
  WaitCondition,
  Workflow,
} from "@aart/types";

export interface WaitingRunEntry {
  runId: string;
  stepId: string;
  wait: WaitCondition;
  createdAt: string;
}

/** `GET /workflows/:id`'s real shape (`packages/server/src/http/server.ts`) — the full record for one version (latest by default, or a specific one via `getWorkflow`'s own `version` param) plus every known version, so the Workflow detail page (frontend/src/pages/WorkflowsPage.tsx) never needs a second round trip to render version history. */
export interface WorkflowDetail {
  workflow: Workflow;
  versions: string[];
}

export interface HealthPayload {
  status: "ok";
  claimedRuns: number;
  uptime: number;
  version: string;
}

export type DecideApprovalInput = { status: ApprovalTask["status"]; reviewer: string; decision?: unknown; trustMode?: TrustMode };

/** `POST /approvals/:id/decision`'s real shape (`packages/server/src/approvals.ts`'s `decideApprovalTask`) — a genuine per-run wait resume, or a workflow-version-level gate decision (the gate DECODED from the task's own `stepId`, never a hardcoded one — root AMENDMENTS.md A46's flagged bug, closed at its source server-side by A47). */
export type DecideApprovalResult =
  | { kind: "workflow_version"; task: ApprovalTask; workflowId: string; workflowVersion: string; gates: Workflow["gates"]; approval: Workflow["approval"] }
  | { kind: "run_step"; task: ApprovalTask; resume?: unknown };

export interface TriggerRunParams {
  workflowId: string;
  workflowVersion?: string;
  inputs: Record<string, unknown>;
  environment?: string;
}

export interface CreateEvalSuiteParams {
  name: string;
  description?: string;
  scorer: Scorer;
}

export interface RunEvalSuiteResult {
  evalRun: EvalRun;
  results: Array<{ exampleId: string; actual: unknown; result: { passed: boolean; score: number; detail?: string } }>;
}

export type ClearRunFlagResult = { kind: "cleared"; run: RunRecord } | { kind: "not_found" } | { kind: "no_flag" };

export interface ApiClient {
  listRuns(filter?: { status?: RunStatus; workflowId?: string }): Promise<RunRecord[]>;
  getRun(id: string): Promise<RunRecord | undefined>;
  listWaitingRuns(): Promise<WaitingRunEntry[]>;
  listFlaggedRunsViaApi(): Promise<RunRecord[]>;
  listWorkflowIds(): Promise<string[]>;
  /** The full record for one workflow (latest version, or `version` if given) plus its version history — `undefined` if the workflow (or that specific version) doesn't exist. Backs the Workflow detail page (frontend/src/pages/WorkflowsPage.tsx). */
  getWorkflow(id: string, version?: string): Promise<WorkflowDetail | undefined>;
  listEnvironments(): Promise<Environment[]>;
  listDeployments(): Promise<Deployment[]>;
  listRejectedTriggers(): Promise<RejectedTrigger[]>;
  /**
   * V2 Wave 2A (activity feed + live updates, AMENDMENTS.md A66) — the
   * `GET /events`/`GET /events/stream` source both this dashboard's own
   * `/api/events` (backfill) and `/api/events/stream` (SSE broadcast) routes
   * read through. Newest-first, matching `EventLogStore.list`'s own
   * contract (`@aart/store`'s `types.ts`) — `since`/`limit` are independent,
   * freely-combinable optional filters, passed straight through by both
   * implementations below (no dashboard-level re-derivation of the real
   * server's own `?limit=` default/clamp policy, `@aart/server`'s
   * `parseEventsLimit` — that policy is the HTTP route's defense against an
   * unauthenticated caller requesting the entire log in one shot; the local/
   * embedded fake-client topology below is a same-process direct store read
   * with no such exposure, so it stays a plain passthrough, same as every
   * other `list*` method on this fake client).
   */
  listEvents(since?: string, limit?: number): Promise<EventLogEntry[]>;
  controlPlaneHealth(): Promise<{ status: string }>;
  workerHealth(workerUrl: string): Promise<HealthPayload>;

  // -- AMENDMENTS.md A47: write actions -------------------------------------
  listApprovals(status?: ApprovalTask["status"]): Promise<ApprovalTask[]>;
  decideApproval(taskId: string, input: DecideApprovalInput): Promise<DecideApprovalResult>;
  triggerRun(params: TriggerRunParams): Promise<RunRecord>;
  approveOrDeprecateWorkflow(workflowId: string, version: string, action: "approve" | "deprecate", trustMode: TrustMode): Promise<Workflow>;
  promoteWorkflow(workflowId: string, version: string, environmentId: string, triggerConfig?: Record<string, unknown>): Promise<PromoteToEnvironmentResult>;
  blockPromotion(workflowId: string, version: string): Promise<Workflow>;
  unblockPromotion(workflowId: string, version: string): Promise<Workflow>;
  markNeedsReview(workflowId: string, version: string): Promise<Workflow>;
  clearNeedsReview(workflowId: string, version: string): Promise<Workflow>;
  triggerImprovementProposal(workflowId: string, version: string): Promise<ImprovementBrief>;
  listCorrections(filter?: { runId?: string; stepId?: string }): Promise<Correction[]>;
  recordCorrection(input: { runId: string; stepId: string; fieldPath: string; observed: unknown; corrected: unknown; reason: string; reviewer: string }): Promise<Correction>;
  /** `undefined` when `key` doesn't resolve to a known Correction (404) — mirrors `getRun`/`getWorkflow`'s own not-found convention so the dashboard's route handler can render its existing "No such correction." page without a pre-fetch. */
  updateCorrectionRunOutput(key: string): Promise<RunRecord | undefined>;
  createEvalExampleFromCorrection(key: string, suiteId: string): Promise<EvalExample | undefined>;
  createIssueForCorrection(key: string): Promise<ImprovementBrief | undefined>;
  listEvals(): Promise<{ suites: EvalSuite[]; runs: EvalRun[] }>;
  createEvalSuite(input: CreateEvalSuiteParams): Promise<EvalSuite>;
  runEvalSuite(suiteId: string, workflowId: string, workflowVersion: string): Promise<RunEvalSuiteResult>;
  clearRunFlag(runId: string, clearedBy: string): Promise<ClearRunFlagResult>;
}

// ---------------------------------------------------------------------------
// Real HTTP implementation
// ---------------------------------------------------------------------------

/**
 * `extraHeaders` (D2b "remote reads," AMENDMENTS.md, this session) — this
 * function had NO way to attach a header at all before this change (unlike
 * its `postJson`/`postJsonOrThrow` siblings below, which have carried an
 * `extraHeaders` param since D1's fix pass, AMENDMENTS.md A57); every
 * pre-D2b call site omits it and gets byte-identical behavior. Needed now
 * because `GET /runs`/`GET /runs/:id` (`@aart/server`'s `http/server.ts`)
 * became the first GET routes this codebase conditionally deploy-token-gates
 * (D2b's own "gate the run-read routes" ruling) — `listRuns`/`getRun` below
 * are the two callers that actually pass one.
 */
async function getJson<T>(url: string, extraHeaders?: Record<string, string>): Promise<T> {
  const res = await fetch(url, extraHeaders ? { headers: extraHeaders } : undefined);
  if (!res.ok) throw new HttpError(res.status, `GET ${url} -> ${res.status}`);
  return (await res.json()) as T;
}

/** `extraHeaders` (D1 fix pass, AMENDMENTS.md A57) — merged in ON TOP OF the fixed `content-type` header, never replacing it; `undefined`/omitted is byte-identical to this function's pre-A57 behavior. */
async function postJson<T>(url: string, body: unknown, extraHeaders?: Record<string, string>): Promise<{ status: number; body: T }> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...extraHeaders }, body: JSON.stringify(body ?? {}) });
  const parsed = (await res.json()) as T;
  return { status: res.status, body: parsed };
}

async function postJsonOrThrow<T>(url: string, body: unknown, extraHeaders?: Record<string, string>): Promise<T> {
  const { status, body: parsed } = await postJson<T & { error?: string }>(url, body, extraHeaders);
  // AMENDMENTS.md A58 — HttpError, not a bare Error: carries `status`
  // through so a caller (this package's own Router.handle, http/router.ts)
  // can preserve the REAL upstream status (a 401 from a token-gated real
  // aart server, most notably — see promoteWorkflow below) on /api/* routes
  // instead of every non-2xx response collapsing into a generic HTML 500.
  if (status < 200 || status >= 300) throw new HttpError(status, `POST ${url} -> ${status}${parsed?.error ? `: ${parsed.error}` : ""}`);
  return parsed;
}

/**
 * `baseUrl` should point at a live `aart server`'s HTTP API (default port
 * 8080 per S2's `ServerConfig.port` default, documented in SEAMS.md — not
 * hardcoded here, caller supplies it).
 *
 * `deployToken` (D1 fix pass, AMENDMENTS.md A57; scope widened by D2a
 * security hardening, AMENDMENTS.md A59; widened again by D2b "remote
 * reads," AMENDMENTS.md, this session; widened a third time by the D2b/V1
 * fix pass, AMENDMENTS.md A63 FIX 1) — this dashboard-server ->
 * runtime-server hop's OWN deploy token, attached as `Authorization: Bearer
 * <token>` on EVERY write call this client makes, AND (as of D2b, extended
 * by A63 FIX 1) the three now-conditionally-gated reads, `listRuns`/
 * `getRun`/`listFlaggedRunsViaApi` (`deployAuthHeaders`, below — renamed
 * from A59's own `writeAuthHeaders` now that it covers reads too, same
 * value, same construction). The server's `requireDeployTokenIfConfigured`
 * (`@aart/server`'s `http/server.ts`) conditionally requires this exact
 * header on nearly every mutation route, plus (D2b/A63) `GET /runs`, `GET
 * /runs/:id`, and `GET /flagged-runs`, once `AART_DEPLOY_TOKEN` is
 * configured server-side — an unauthenticated dashboard hop would 401 on
 * every one of those the moment an operator sets that env var, unless this
 * client attaches the identical token. As of A57 this was scoped to
 * `promoteWorkflow` alone, because promote was the ONE route the server
 * conditionally gated at the time — see `requireDeployTokenIfConfigured`'s
 * own doc comment for the full trust-boundary rationale, now generalized to
 * every write route this client calls PLUS the three run-read routes. Resolved
 * ONCE by this function's own caller (`deploy/serve-dashboard.mjs`) and
 * passed in here — this client never re-resolves it itself, matching how
 * `@aart/cli`'s `secretResolver`/`resolveDeployToken` are likewise resolved
 * once by their own callers, not self-resolving. `createHttpApiClient`'s own
 * public signature is UNCHANGED (still `(baseUrl, deployToken?)`) —
 * `deploy/serve-dashboard.mjs` needs no update; the same already-resolved
 * token now simply reaches further.
 */
export function createHttpApiClient(baseUrl: string, deployToken?: string): ApiClient {
  const base = baseUrl.replace(/\/$/, "");
  // D2a security hardening (AMENDMENTS.md A59) — renamed from
  // `promoteAuthHeaders` (A57's own name, when this was promote-only) to
  // reflect its now-general scope; D2b "remote reads" (AMENDMENTS.md, this
  // session) renamed it AGAIN, from `writeAuthHeaders` to `deployAuthHeaders`
  // — the exact same value/construction, unchanged, but the name itself
  // stopped being accurate once `listRuns`/`getRun` (both reads) started
  // needing it too (GET /runs, GET /runs/:id are now conditionally gated —
  // see server.ts's own "Read surface" registration comment for the full
  // rationale). Applied to every write call below, plus those two reads.
  const deployAuthHeaders: Record<string, string> | undefined = deployToken ? { authorization: `Bearer ${deployToken}` } : undefined;
  return {
    async listRuns(filter) {
      const params = new URLSearchParams();
      if (filter?.status) params.set("status", filter.status);
      if (filter?.workflowId) params.set("workflowId", filter.workflowId);
      const qs = params.toString();
      const { runs } = await getJson<{ runs: RunRecord[] }>(`${base}/runs${qs ? `?${qs}` : ""}`, deployAuthHeaders);
      return runs;
    },
    async getRun(id) {
      const res = await fetch(`${base}/runs/${encodeURIComponent(id)}`, deployAuthHeaders ? { headers: deployAuthHeaders } : undefined);
      if (res.status === 404) return undefined;
      if (!res.ok) throw new HttpError(res.status, `GET /runs/${id} -> ${res.status}`);
      const { run } = (await res.json()) as { run: RunRecord };
      return run;
    },
    async listWaitingRuns() {
      const { waits } = await getJson<{ waits: WaitingRunEntry[] }>(`${base}/waiting-runs`);
      return waits;
    },
    async listFlaggedRunsViaApi() {
      // deployAuthHeaders (D2b/V1 fix pass, AMENDMENTS.md A63 FIX 1) — GET
      // /flagged-runs joined GET /runs/GET /runs/:id's conditionally-gated
      // tier (server.ts) in this fix pass; omitting the token here would
      // 401 against a token-configured real server the moment an operator
      // sets AART_DEPLOY_TOKEN, exactly the gap this fix closes.
      const { runs } = await getJson<{ runs: RunRecord[] }>(`${base}/flagged-runs`, deployAuthHeaders);
      return runs;
    },
    async listWorkflowIds() {
      const { workflowIds } = await getJson<{ workflowIds: string[] }>(`${base}/workflows`);
      return workflowIds;
    },
    async getWorkflow(id, version) {
      const qs = version ? `?version=${encodeURIComponent(version)}` : "";
      const res = await fetch(`${base}/workflows/${encodeURIComponent(id)}${qs}`);
      if (res.status === 404) return undefined;
      if (!res.ok) throw new HttpError(res.status, `GET /workflows/${id} -> ${res.status}`);
      return (await res.json()) as WorkflowDetail;
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
    async listEvents(since, limit) {
      const params = new URLSearchParams();
      if (since) params.set("since", since);
      if (limit !== undefined) params.set("limit", String(limit));
      const qs = params.toString();
      // deployAuthHeaders attached here too (V2 Wave 2A) even though `GET
      // /events` is deliberately left OPEN/unauthenticated on the real
      // server regardless of deployToken configuration (AMENDMENTS.md A63
      // FIX 2 — an EventLogEntry carries only run-lifecycle metadata, never
      // trace/inputs/outputs, the same open-always tier as `/deployments`).
      // Sending the token anyway is harmless (an open route ignores a
      // Bearer header it doesn't require) and keeps this client uniform
      // with every other read it makes against a route that MIGHT be
      // gated (listRuns/getRun/listFlaggedRunsViaApi, D2b/A63 FIX 1) — a
      // future session that gates /events too would need no change here.
      const { events } = await getJson<{ events: EventLogEntry[] }>(`${base}/events${qs ? `?${qs}` : ""}`, deployAuthHeaders);
      return events;
    },
    async controlPlaneHealth() {
      return getJson<{ status: string }>(`${base}/health`);
    },
    async workerHealth(workerUrl) {
      return getJson<HealthPayload>(`${workerUrl.replace(/\/$/, "")}/health`);
    },

    async listApprovals(status) {
      const qs = status ? `?status=${encodeURIComponent(status)}` : "";
      const { tasks } = await getJson<{ tasks: ApprovalTask[] }>(`${base}/approvals${qs}`);
      return tasks;
    },
    async decideApproval(taskId, input) {
      return postJsonOrThrow<DecideApprovalResult>(`${base}/approvals/${encodeURIComponent(taskId)}/decision`, input, deployAuthHeaders);
    },
    async triggerRun(params) {
      const { run } = await postJsonOrThrow<{ kind: string; run?: RunRecord }>(`${base}/runs/trigger`, params, deployAuthHeaders);
      if (!run) throw new Error(`POST /runs/trigger: server accepted the run but did not return it`);
      return run;
    },
    async approveOrDeprecateWorkflow(workflowId, version, action, trustMode) {
      const { workflow } = await postJsonOrThrow<{ workflow: Workflow }>(`${base}/workflows/${encodeURIComponent(workflowId)}/approve`, { version, action, trustMode }, deployAuthHeaders);
      return workflow;
    },
    async promoteWorkflow(workflowId, version, environmentId, triggerConfig) {
      return postJsonOrThrow<PromoteToEnvironmentResult>(`${base}/workflows/${encodeURIComponent(workflowId)}/promote`, { version, environmentId, triggerConfig }, deployAuthHeaders);
    },
    async blockPromotion(workflowId, version) {
      const { workflow } = await postJsonOrThrow<{ workflow: Workflow }>(`${base}/workflows/${encodeURIComponent(workflowId)}/block-promotion`, { version }, deployAuthHeaders);
      return workflow;
    },
    async unblockPromotion(workflowId, version) {
      const { workflow } = await postJsonOrThrow<{ workflow: Workflow }>(`${base}/workflows/${encodeURIComponent(workflowId)}/unblock-promotion`, { version }, deployAuthHeaders);
      return workflow;
    },
    async markNeedsReview(workflowId, version) {
      const { workflow } = await postJsonOrThrow<{ workflow: Workflow }>(`${base}/workflows/${encodeURIComponent(workflowId)}/mark-needs-review`, { version }, deployAuthHeaders);
      return workflow;
    },
    async clearNeedsReview(workflowId, version) {
      const { workflow } = await postJsonOrThrow<{ workflow: Workflow }>(`${base}/workflows/${encodeURIComponent(workflowId)}/clear-needs-review`, { version }, deployAuthHeaders);
      return workflow;
    },
    async triggerImprovementProposal(workflowId, version) {
      return postJsonOrThrow<ImprovementBrief>(`${base}/workflows/${encodeURIComponent(workflowId)}/trigger-improvement`, { version }, deployAuthHeaders);
    },
    async listCorrections(filter) {
      const params = new URLSearchParams();
      if (filter?.runId) params.set("runId", filter.runId);
      if (filter?.stepId) params.set("stepId", filter.stepId);
      const qs = params.toString();
      const { corrections } = await getJson<{ corrections: Correction[] }>(`${base}/corrections${qs ? `?${qs}` : ""}`);
      return corrections;
    },
    async recordCorrection(input) {
      const { correction } = await postJsonOrThrow<{ correction: Correction }>(`${base}/corrections`, input, deployAuthHeaders);
      return correction;
    },
    async updateCorrectionRunOutput(key) {
      // D2a security hardening (AMENDMENTS.md A59) — a raw fetch (not
      // postJson/postJsonOrThrow), so deployAuthHeaders is spread into this
      // call's own headers object structurally rather than passed as a
      // third function argument.
      const res = await fetch(`${base}/corrections/${encodeURIComponent(key)}/update-run-output`, { method: "POST", headers: { ...deployAuthHeaders } });
      if (res.status === 404) return undefined;
      if (!res.ok) throw new HttpError(res.status, `POST /corrections/${key}/update-run-output -> ${res.status}`);
      const { run } = (await res.json()) as { run: RunRecord };
      return run;
    },
    async createEvalExampleFromCorrection(key, suiteId) {
      const res = await fetch(`${base}/corrections/${encodeURIComponent(key)}/create-eval-example`, {
        method: "POST",
        headers: { "content-type": "application/json", ...deployAuthHeaders },
        body: JSON.stringify({ suiteId }),
      });
      if (res.status === 404) return undefined;
      if (!res.ok) throw new HttpError(res.status, `POST /corrections/${key}/create-eval-example -> ${res.status}`);
      const { example } = (await res.json()) as { example: EvalExample };
      return example;
    },
    async createIssueForCorrection(key) {
      const res = await fetch(`${base}/corrections/${encodeURIComponent(key)}/create-issue`, { method: "POST", headers: { ...deployAuthHeaders } });
      if (res.status === 404) return undefined;
      if (!res.ok) throw new HttpError(res.status, `POST /corrections/${key}/create-issue -> ${res.status}`);
      return (await res.json()) as ImprovementBrief;
    },
    async listEvals() {
      return getJson<{ suites: EvalSuite[]; runs: EvalRun[] }>(`${base}/evals`);
    },
    async createEvalSuite(input) {
      const { suite } = await postJsonOrThrow<{ suite: EvalSuite }>(`${base}/evals/suites`, input, deployAuthHeaders);
      return suite;
    },
    async runEvalSuite(suiteId, workflowId, workflowVersion) {
      return postJsonOrThrow<RunEvalSuiteResult>(`${base}/evals/runs`, { suiteId, workflowId, workflowVersion }, deployAuthHeaders);
    },
    async clearRunFlag(runId, clearedBy) {
      const { status, body } = await postJson<ClearRunFlagResult>(`${base}/runs/${encodeURIComponent(runId)}/flag/clear`, { clearedBy }, deployAuthHeaders);
      if (status !== 200 && status !== 404 && status !== 409) throw new HttpError(status, `POST /runs/${runId}/flag/clear -> ${status}`);
      return body;
    },
  };
}

// ---------------------------------------------------------------------------
// Store-backed fake — local/embedded topology + this package's own tests.
//
// AMENDMENTS.md A47: writes now go straight through the SAME real,
// authoritative functions the HTTP client's server-side endpoints call
// (`@aart/server`'s `decideApprovalTask`/`approveOrDeprecateWorkflow`/
// `promoteWorkflowVersionToEnvironment`/`createEvalSuite`/
// `runEvalSuiteForWorkflow`/`findCorrectionByKey`, `@aart/evidence`'s
// correction-outcome functions) rather than a dashboard-local reimplementation
// of each — this is what makes the local (`aart dev`, single-process)
// topology and the HTTP-backed one call the literal same code, not two
// parallel copies that could silently drift (the exact class of bug root
// AMENDMENTS.md A46 found in the FORMER dashboard-local `decideApprovalAction`).
// `triggerRun` is the one exception: no real `@aart/engine` `Engine`
// instance is available to a bare `AartStore` here, so this uses the same
// `createFakeEngine` boundary this package's own HTTP server falls back to
// in tests (`@aart/server`'s own `test-helpers.ts` — a real RunRecord
// persisted + enqueued, no real step execution), matching this package's
// own pre-A47, already-documented "trigger a run... still local mirrors"
// scope note (TEST-DRIVE.md's "What doesn't work yet").
// ---------------------------------------------------------------------------

export function createFakeApiClient(store: AartStore, options: { workerHealth?: Map<string, HealthPayload> } = {}): ApiClient {
  // Adapts this package's own (narrower) Clock into @aart/server's Clock
  // shape for createFakeEngine — server's Clock additionally requires
  // `setTimeout` (its own ticker/lease/reclaim timer-driven logic needs
  // it), which `EngineBoundary.startRun`/`resumeDirect` (the only two
  // methods this fake engine's `triggerRun`/`decideApproval` call) never
  // do (verified by reading `engine/boundary.ts`'s `createFakeEngine`
  // directly) — same adapter pattern this package's own (now-superseded)
  // `promoteWorkflowVersionToEnvironment` wiring in stub-deps.ts already
  // established for the identical reason.
  const fakeEngine = createFakeEngine(store, { ...systemClock, setTimeout: () => ({ cancel() {} }) });
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
    async getWorkflow(id, version) {
      const workflow = version ? await store.workflows.get(id, version) : await store.workflows.getLatest(id);
      if (!workflow) return undefined;
      const versions = await store.workflows.listVersions(id);
      return { workflow, versions };
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
    async listEvents(since, limit) {
      return store.events.list({ since, limit });
    },
    async controlPlaneHealth() {
      return { status: "ok" };
    },
    async workerHealth(workerUrl) {
      const health = options.workerHealth?.get(workerUrl);
      if (!health) throw new Error(`no fake worker health registered for ${workerUrl}`);
      return health;
    },

    async listApprovals(status) {
      return store.approvals.list(status ? { status } : undefined);
    },
    async decideApproval(taskId, input) {
      const result = await decideApprovalTask(store, fakeEngine, taskId, input);
      switch (result.kind) {
        case "not_found":
          throw new Error(`approval task not found: ${taskId}`);
        case "missing_reviewer":
          throw new Error("reviewer is required");
        case "invalid_gate":
          throw new Error(`A human decision cannot set gate "${result.gate}" — only humanReview, riskReview are decided via approval tasks.`);
        case "workflow_not_found":
          throw new Error(`Workflow ${result.workflowId}@${result.workflowVersion} not found.`);
        case "workflow_version":
          return { kind: result.kind, task: result.task, workflowId: result.workflowId, workflowVersion: result.workflowVersion, gates: result.gates, approval: result.approval };
        case "run_step":
          return { kind: result.kind, task: result.task, resume: result.resume };
      }
    },
    async triggerRun(params) {
      const workflow = params.workflowVersion ? await store.workflows.get(params.workflowId, params.workflowVersion) : await store.workflows.getLatest(params.workflowId);
      if (!workflow) throw new Error(`workflow not found: ${params.workflowId}${params.workflowVersion ? `@${params.workflowVersion}` : ""}`);
      const trigger = { type: "manual" as const, id: generateId("trig"), source: "dashboard", payload: {}, receivedAt: systemClock.nowIso() };
      const result = await fakeEngine.startRun({ workflowId: workflow.id, workflowVersion: workflow.version, trigger, mappedInputs: params.inputs, environment: params.environment });
      if (result.kind === "rejected") throw new Error(result.reason);
      const run = await store.runs.get(result.runId);
      if (!run) throw new Error(`triggerRun: run ${result.runId} was not persisted`);
      return run;
    },
    async approveOrDeprecateWorkflow(workflowId, version, action, trustMode) {
      const result = await serverApproveOrDeprecateWorkflow(store, workflowId, version, action, trustMode);
      if (result.kind === "not_found") throw new Error(`workflow not found: ${workflowId}@${version}`);
      return result.workflow;
    },
    async promoteWorkflow(workflowId, version, environmentId, triggerConfig) {
      return promoteWorkflowVersionToEnvironment(store, { workflowId, workflowVersion: version, environmentId, triggerConfig });
    },
    async blockPromotion(workflowId, version) {
      return evidenceBlockPromotion(store, workflowId, version);
    },
    async unblockPromotion(workflowId, version) {
      return evidenceUnblockPromotion(store, workflowId, version);
    },
    async markNeedsReview(workflowId, version) {
      return evidenceMarkNeedsReview(store, workflowId, version);
    },
    async clearNeedsReview(workflowId, version) {
      return evidenceClearNeedsReview(store, workflowId, version);
    },
    async triggerImprovementProposal(workflowId, version) {
      return evidenceTriggerImprovementProposal(store, workflowId, version);
    },
    async listCorrections(filter) {
      return store.corrections.list(filter);
    },
    async recordCorrection(input) {
      return evidenceRecordCorrection(store, input as EvidenceRecordCorrectionInput);
    },
    async updateCorrectionRunOutput(key) {
      const correction = await findCorrectionByKey(store, key);
      if (!correction) return undefined;
      return evidenceUpdateRunOutput(store, correction);
    },
    async createEvalExampleFromCorrection(key, suiteId) {
      const correction = await findCorrectionByKey(store, key);
      if (!correction) return undefined;
      return evidenceCreateEvalExampleFromCorrection(store, correction, suiteId);
    },
    async createIssueForCorrection(key) {
      const correction = await findCorrectionByKey(store, key);
      if (!correction) return undefined;
      return evidenceCreateIssueForAgent(store, correction);
    },
    async listEvals() {
      const [suites, runs] = await Promise.all([store.evals.listSuites(), store.evals.listRuns()]);
      return { suites, runs };
    },
    async createEvalSuite(input) {
      return serverCreateEvalSuite(store, input);
    },
    async runEvalSuite(suiteId, workflowId, workflowVersion) {
      const result = await runEvalSuiteForWorkflow(store, suiteId, workflowId, workflowVersion);
      if (result.kind === "suite_not_found") throw new Error(`eval suite not found: ${suiteId}`);
      if (result.kind === "workflow_not_found") throw new Error(`workflow not found: ${workflowId}@${workflowVersion}`);
      return { evalRun: result.evalRun, results: result.results };
    },
    async clearRunFlag(runId, clearedBy) {
      const run = await store.runs.get(runId);
      if (!run) return { kind: "not_found" };
      if (!run.flag || run.flag.clearedAt) return { kind: "no_flag" };
      const updated: RunRecord = { ...run, flag: { ...run.flag, clearedBy, clearedAt: systemClock.nowIso() } };
      await store.runs.put(updated);
      return { kind: "cleared", run: updated };
    },
  };
}
