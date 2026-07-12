// Remote-observability handlers — aart_remote_status, aart_remote_why,
// aart_remote_runs, aart_remote_run. D2b "remote reads" (AMENDMENTS.md, this
// session, John-ratified 2026-07-12) — Wave 1 of "let an authoring agent SEE
// a deployed server so it can debug/improve deployed workflows" (D1's own
// "remotes + push," AMENDMENTS.md A56, shipped the WRITE half — pushing a
// bundle; this is the READ half). The WRITE-against-remote half
// (`aart_remote_approve`) is explicitly DEFERRED to Wave 2 — not built here.
//
// All four tools need ZERO new server routes — every one reads through a
// route `@aart/server`'s HTTP API already serves for real (GET /workflows/:id,
// /deployments, /runs, /runs/:id, /approvals, /environments), via the shared
// `fetchFromRemote` (remote-client.ts) this session generalized from
// `deployToRemoteHandler`'s own pre-existing inline fetch (D1, AMENDMENTS.md
// A56/A57) below in this same package.
//
// CRITICAL REDACTION FACT (verified directly, real-context.ts:389-394): the
// ONE redaction chokepoint this codebase's real evidence rendering goes
// through is `createReportRenderers(redactRecord)` — exposed on
// `AartContext` as `ctx.evidence.modelFacingReport`/`markdownReport`. A
// remote-fetched RunRecord handed to an agent RAW (no render) would ship
// whatever the remote server itself already returns unredacted-relative-to-
// this-package's-own-chokepoint — `aart_remote_run` (below) is the ONE tool
// here that renders a full RunRecord, and it routes through that exact same
// seam `aart_get_report` already uses locally (execution.ts's
// `getReportHandler`), never a second way to turn a RunRecord into a
// report. Per this session's own brief: this is a CONSISTENCY/inheritance
// move (the render-time scrub is a defense-in-depth no-op today — resolved
// secret VALUES are never persisted onto a RunRecord in the first place,
// `@aart/evidence`'s `redact.ts` doc comment) and inherits the blocking
// `lint:redaction` CI gate, NOT new protection — not overclaimed as such in
// this file's tool descriptions (definitions.ts).
import type { ApprovalState, ApprovalTask, Deployment, Environment, Gates, RunRecord, RunStatus, Workflow } from "@aart/types";
import type { AartStore } from "@aart/store";
import { findCurrentVersion } from "@aart/server";
import type { AartContext } from "../context.js";
import { describeUnreachableRemote, fetchFromRemote, isRecord, remoteErrorMessage, remoteNotFoundError, type FetchFromRemoteResult } from "../remote-client.js";
import type { HandlerResult } from "../response.js";

const GATE_NAMES: readonly (keyof Gates)[] = ["validate", "readiness", "evals", "riskReview", "humanReview"];

// ---------------------------------------------------------------------------
// aart_remote_status — local-vs-remote drift, across one or every configured
// remote.
// ---------------------------------------------------------------------------

export interface RemoteStatusInput {
  workflowId: string;
  /** One named remote, or every configured remote (ctx.remotes.list()) when omitted. */
  remote?: string;
}

interface GateFieldDiff {
  field: string;
  local: unknown;
  remote: unknown;
}

/** FIELD-BY-FIELD, not just a version-equality check — a remote can show the SAME version string with DIFFERENT gate/approval state (e.g. re-approved locally after the same version was already pushed) — that drift is exactly what this tool exists to surface, and a bare "versions match" verdict would hide it. */
function diffApprovalAndGates(local: { approval: ApprovalState; gates: Gates }, remote: { approval: ApprovalState; gates: Gates }): GateFieldDiff[] {
  const diffs: GateFieldDiff[] = [];
  if (local.approval !== remote.approval) diffs.push({ field: "approval", local: local.approval, remote: remote.approval });
  for (const gate of GATE_NAMES) {
    if (local.gates[gate] !== remote.gates[gate]) diffs.push({ field: `gates.${gate}`, local: local.gates[gate], remote: remote.gates[gate] });
  }
  return diffs;
}

interface RemoteStatusRow {
  remote: string;
  reachable: boolean;
  error?: string;
  environment?: string;
  local: { version: string; approval: ApprovalState; gates: Gates };
  remoteWorkflow?: { version: string; approval: ApprovalState; gates: Gates };
  versionsMatch?: boolean;
  gateDiff?: GateFieldDiff[];
  /** Every Deployment row on this remote for `workflowId`, across every environment that remote knows about — GET /deployments returns everything (it ignores query params, confirmed server.ts:772), filtered CLIENT-SIDE here to this workflowId. Raw, un-enriched `environmentId` (Deployment carries no environment NAME) — deliberately not resolved to a name via a second GET /environments call per remote per row here; aart_remote_why (below) does that enrichment for the one (remote, environment) pair it actually needs. */
  deployments: Array<Pick<Deployment, "environmentId" | "workflowVersion" | "promoted" | "createdAt" | "bundleHash">>;
}

async function statusForOneRemote(ctx: AartContext, remoteName: string, workflowId: string, local: RemoteStatusRow["local"]): Promise<RemoteStatusRow> {
  const remoteEntry = await ctx.remotes.get(remoteName);
  if (!remoteEntry) {
    // Only reachable when `remote` was named explicitly for something not in
    // remotes.json — every name ctx.remotes.list() itself returns resolves
    // via ctx.remotes.get by construction, so this is a defensive guard on
    // the single-named-remote path, not the common case.
    return { remote: remoteName, reachable: false, error: remoteNotFoundError(remoteName), local, deployments: [] };
  }
  const token = await ctx.remotes.resolveToken(remoteName);

  const [workflowResponse, deploymentsResponse] = await Promise.all([
    fetchFromRemote(remoteEntry, `/workflows/${encodeURIComponent(workflowId)}`, { token }),
    fetchFromRemote(remoteEntry, "/deployments", { token }),
  ]);

  const networkError = workflowResponse.networkError ?? deploymentsResponse.networkError;
  if (networkError !== undefined) {
    return { remote: remoteName, reachable: false, error: describeUnreachableRemote(remoteName, remoteEntry, networkError), local, deployments: [] };
  }

  const row: RemoteStatusRow = { remote: remoteName, reachable: true, environment: remoteEntry.environment, local, deployments: [] };

  if (workflowResponse.status === 404) {
    // Legitimate, not an error: nothing has ever been pushed/registered for
    // this workflowId on this remote yet.
  } else if (!workflowResponse.ok) {
    row.error = `GET /workflows/${workflowId} on remote "${remoteName}" failed: ${remoteErrorMessage(workflowResponse.body, workflowResponse.status)}`;
  } else {
    const body = workflowResponse.body as { workflow?: Workflow } | undefined;
    if (body?.workflow) {
      const remoteWorkflow = { version: body.workflow.version, approval: body.workflow.approval, gates: body.workflow.gates };
      row.remoteWorkflow = remoteWorkflow;
      row.versionsMatch = local.version === remoteWorkflow.version;
      if (row.versionsMatch) row.gateDiff = diffApprovalAndGates(local, remoteWorkflow);
    }
  }

  if (deploymentsResponse.ok && isRecord(deploymentsResponse.body) && Array.isArray((deploymentsResponse.body as { deployments?: unknown }).deployments)) {
    const allDeployments = (deploymentsResponse.body as { deployments: Deployment[] }).deployments;
    row.deployments = allDeployments
      .filter((d) => d.workflowId === workflowId)
      .map((d) => ({ environmentId: d.environmentId, workflowVersion: d.workflowVersion, promoted: d.promoted, createdAt: d.createdAt, bundleHash: d.bundleHash }));
  }

  return row;
}

export async function remoteStatusHandler(ctx: AartContext, input: RemoteStatusInput): Promise<HandlerResult> {
  const localWorkflow = await ctx.store.workflows.getLatest(input.workflowId);
  if (!localWorkflow) {
    return { ok: false, error: `Workflow "${input.workflowId}" not found locally. Register it first — call aart_register_block, then aart_validate.` };
  }
  const local: RemoteStatusRow["local"] = { version: localWorkflow.version, approval: localWorkflow.approval, gates: localWorkflow.gates };

  const remoteNames = input.remote ? [input.remote] : Object.keys(await ctx.remotes.list());
  const remotes = await Promise.all(remoteNames.map((name) => statusForOneRemote(ctx, name, input.workflowId, local)));

  return { ok: true, workflowId: input.workflowId, remotes };
}

// ---------------------------------------------------------------------------
// aart_remote_why — what's live on one (remote, workflow) pair, and why.
// ---------------------------------------------------------------------------

export interface RemoteWhyInput {
  remote: string;
  workflowId: string;
}

/**
 * A minimal, in-memory adapter satisfying ONLY the one `AartStore` member
 * `findCurrentVersion` (`@aart/server`, `bundle/plan.ts`) actually reads —
 * `store.deployments.list(filter)` — backed by a REMOTE-fetched
 * `Deployment[]` array instead of a real backing store. This is how this
 * handler calls the REAL "which deployment is live" tie-break (this
 * session's own brief: "do NOT re-derive a heuristic") against data that
 * arrived over HTTP rather than through a real `AartStore`, without
 * `findCurrentVersion` itself needing to know or care where its data came
 * from — the same "fake the interface, not the algorithm" shape this
 * package's own `stubs/*.ts` already use elsewhere for a different reason
 * (simulating an expensive real dependency; here there's no real store at
 * all, just a remote HTTP response already in hand). Every OTHER `AartStore`
 * member is deliberately left unimplemented (cast through `unknown`) —
 * nothing in `findCurrentVersion`'s own body touches them, and a real call
 * reaching one would be a bug in this adapter or in `findCurrentVersion`
 * itself, not something to silently paper over with a fuller fake.
 */
function fakeStoreOverDeployments(deployments: readonly Deployment[]): AartStore {
  return {
    deployments: {
      list: async (filter?: { environmentId?: string; workflowId?: string }) =>
        deployments.filter((d) => (filter?.environmentId === undefined || d.environmentId === filter.environmentId) && (filter?.workflowId === undefined || d.workflowId === filter.workflowId)),
    },
  } as unknown as AartStore;
}

/**
 * `findCurrentVersion` returns only the WINNING VERSION STRING, not the row
 * it picked — this handler also needs that row's `bundleHash`/`createdAt`
 * ("pushedAt") for its own "what's live" report, which `findCurrentVersion`'s
 * own contract doesn't expose. Mirrors `findCurrentVersion`'s own tie-break
 * EXACTLY (`bundle/plan.ts`: most-recently-created active row, `id` as the
 * secondary sort key on a `createdAt` collision), narrowed to rows that
 * ALREADY match the version `findCurrentVersion` picked — a second-order
 * "which of possibly-several rows sharing that exact version" selection
 * (only reachable if the same version was pushed more than once into the
 * same environment), not a re-derivation of "which VERSION is live" itself
 * (this handler always calls the real `findCurrentVersion` FIRST for that).
 */
function pickLiveDeploymentRow(deployments: readonly Deployment[], environmentId: string, workflowId: string, liveVersion: string): Deployment | undefined {
  const candidates = deployments.filter((d) => d.environmentId === environmentId && d.workflowId === workflowId && d.workflowVersion === liveVersion && d.promoted !== false);
  return [...candidates].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).at(-1);
}

const ATTRIBUTION_NOTE =
  "aart does not track which credential pushed a bundle or promoted a deployment (D2b, this session). Only human/token APPROVAL decisions carry an authenticatedAs (D2a security hardening, AMENDMENTS.md A59) — whoPushed/whoPromoted are reported null rather than guessed.";

export async function remoteWhyHandler(ctx: AartContext, input: RemoteWhyInput): Promise<HandlerResult> {
  const remoteEntry = await ctx.remotes.get(input.remote);
  if (!remoteEntry) return { ok: false, error: remoteNotFoundError(input.remote) };
  const token = await ctx.remotes.resolveToken(input.remote);

  const environmentsResponse = await fetchFromRemote(remoteEntry, "/environments", { token });
  if (environmentsResponse.networkError !== undefined) {
    return { ok: false, error: describeUnreachableRemote(input.remote, remoteEntry, environmentsResponse.networkError) };
  }
  if (!environmentsResponse.ok) {
    return { ok: false, error: `GET /environments on remote "${input.remote}" failed: ${remoteErrorMessage(environmentsResponse.body, environmentsResponse.status)}` };
  }
  const environments =
    isRecord(environmentsResponse.body) && Array.isArray((environmentsResponse.body as { environments?: unknown }).environments)
      ? (environmentsResponse.body as { environments: Environment[] }).environments
      : [];
  const environment = environments.find((e) => e.name === remoteEntry.environment);
  if (!environment) {
    return {
      ok: true,
      remote: input.remote,
      workflowId: input.workflowId,
      environment: remoteEntry.environment,
      live: false,
      note: `Environment "${remoteEntry.environment}" (this remote's own configured target — "aart remote list") is not registered on remote "${input.remote}" yet, so nothing can be live there. Register it there first: "aart environment register ${remoteEntry.environment} --trust-mode <mode>" run against the remote (e.g. over ssh), or the token-gated POST /environments.`,
      deployments: [],
      approvals: [],
      whoPushed: null,
      whoPromoted: null,
      attributionNote: ATTRIBUTION_NOTE,
    };
  }

  const deploymentsResponse = await fetchFromRemote(remoteEntry, "/deployments", { token });
  if (deploymentsResponse.networkError !== undefined) {
    return { ok: false, error: describeUnreachableRemote(input.remote, remoteEntry, deploymentsResponse.networkError) };
  }
  if (!deploymentsResponse.ok) {
    return { ok: false, error: `GET /deployments on remote "${input.remote}" failed: ${remoteErrorMessage(deploymentsResponse.body, deploymentsResponse.status)}` };
  }
  const allDeployments =
    isRecord(deploymentsResponse.body) && Array.isArray((deploymentsResponse.body as { deployments?: unknown }).deployments)
      ? (deploymentsResponse.body as { deployments: Deployment[] }).deployments
      : [];
  const scopedDeployments = allDeployments.filter((d) => d.workflowId === input.workflowId && d.environmentId === environment.id);

  // The authoritative "which version is live" answer (this session's own
  // brief: use the real function, do NOT re-derive a heuristic) — backed by
  // a fake store wrapping the REMOTE-fetched deployments above (see
  // fakeStoreOverDeployments's own doc comment).
  const liveVersion = await findCurrentVersion(fakeStoreOverDeployments(scopedDeployments), input.workflowId, environment.id);

  if (liveVersion === undefined) {
    return {
      ok: true,
      remote: input.remote,
      workflowId: input.workflowId,
      environment: remoteEntry.environment,
      live: false,
      note:
        scopedDeployments.length > 0
          ? `Evidence has been pushed for "${input.workflowId}" into "${remoteEntry.environment}" on remote "${input.remote}", but nothing is currently promoted (active) there — see "deployments" below for the dormant (promoted:false) row(s). Promote one to activate it.`
          : `No deployment of "${input.workflowId}" has ever been pushed into "${remoteEntry.environment}" on remote "${input.remote}".`,
      deployments: scopedDeployments,
      approvals: [],
      whoPushed: null,
      whoPromoted: null,
      attributionNote: ATTRIBUTION_NOTE,
    };
  }

  const liveRow = pickLiveDeploymentRow(scopedDeployments, environment.id, input.workflowId, liveVersion);

  const workflowResponse = await fetchFromRemote(remoteEntry, `/workflows/${encodeURIComponent(input.workflowId)}?version=${encodeURIComponent(liveVersion)}`, { token });
  if (workflowResponse.networkError !== undefined) {
    return { ok: false, error: describeUnreachableRemote(input.remote, remoteEntry, workflowResponse.networkError) };
  }
  let gates: Gates | undefined;
  let approval: ApprovalState | undefined;
  if (workflowResponse.ok) {
    const body = workflowResponse.body as { workflow?: Workflow } | undefined;
    gates = body?.workflow?.gates;
    approval = body?.workflow?.approval;
  }

  const approvalsResponse = await fetchFromRemote(remoteEntry, "/approvals", { token });
  if (approvalsResponse.networkError !== undefined) {
    return { ok: false, error: describeUnreachableRemote(input.remote, remoteEntry, approvalsResponse.networkError) };
  }
  const approvals: Array<{ gate: string; reviewer?: string; authenticatedAs?: string; decidedAt?: string; status: string }> = [];
  if (approvalsResponse.ok) {
    const body = approvalsResponse.body as { tasks?: ApprovalTask[] } | undefined;
    for (const task of body?.tasks ?? []) {
      // decodeWorkflowVersionApprovalSubject (@aart/governance, via
      // ctx.governance) is the SAME decode this codebase's own
      // /approvals/:id/decision route uses (server.ts) to recover which
      // (workflowId, workflowVersion, gate) an ApprovalTask's
      // (runId, stepId) sentinel encodes — reused here rather than
      // re-deriving that encoding a third time.
      const decoded = ctx.governance.decodeWorkflowVersionApprovalSubject(task.runId, task.stepId);
      if (decoded && decoded.workflowId === input.workflowId && decoded.workflowVersion === liveVersion) {
        approvals.push({ gate: decoded.gate, reviewer: task.reviewer, authenticatedAs: task.authenticatedAs, decidedAt: task.decidedAt, status: task.status });
      }
    }
  }

  return {
    ok: true,
    remote: input.remote,
    workflowId: input.workflowId,
    environment: remoteEntry.environment,
    live: true,
    liveVersion,
    // Deployment.promoted undefined means "active" (store-records.ts's own
    // documented convention) — liveRow is expected to always be found here
    // (findCurrentVersion only returns a version when at least one
    // promoted!==false row backs it, and pickLiveDeploymentRow applies the
    // identical filter narrowed to that version), `true` is the correct
    // fallback in the defensive case it somehow isn't.
    promoted: liveRow?.promoted ?? true,
    bundleHash: liveRow?.bundleHash,
    pushedAt: liveRow?.createdAt,
    gates,
    approval,
    approvals,
    deployments: scopedDeployments,
    whoPushed: null,
    whoPromoted: null,
    attributionNote: ATTRIBUTION_NOTE,
  };
}

// ---------------------------------------------------------------------------
// aart_remote_runs — compact run list; aart_remote_run — single run detail
// (the redaction/report-rendering seam).
// ---------------------------------------------------------------------------

export interface RemoteRunsInput {
  remote: string;
  status?: RunStatus;
}

interface RemoteRunSummary {
  runId: string;
  workflowId: string;
  workflowVersion: string;
  status: RunStatus;
  startedAt: string;
  updatedAt: string;
  headline: string;
}

/** A cheap, LOCAL derivation from a run's own status/error fields — deliberately NOT a `ctx.evidence.modelFacingReport` render (that seam is reserved for `aart_remote_run`'s single-run detail view below, per this session's own brief: "do not build a second way to render a run"). A list of possibly many runs must stay a compact summary — token budget, and minimizing what crosses the wire — not N full report renders. */
function deriveHeadline(run: Pick<RunRecord, "status" | "error">): string {
  if (run.status === "failed") {
    const reason = run.error ? run.error.slice(0, 140) : "no error message recorded";
    return `failed: ${reason}`;
  }
  return run.status;
}

/** GET /runs and GET /runs/:id are the two routes D2b's own run-read gating (server.ts, this session) conditionally requires a deploy token for — a 401 here almost always means this remote has AART_DEPLOY_TOKEN configured and either this remote's own `tokenRef` isn't set locally, or it resolves to the wrong value. A dedicated remedy, distinct from the generic `remoteErrorMessage` wording, since "the server rejected this" and "you're missing a token you need to configure locally" call for different fixes. */
function describeRunReadFailure(remoteName: string, response: FetchFromRemoteResult): string {
  if (response.status === 401) {
    return `Remote "${remoteName}" requires a deploy token to read run data and either none is configured for this remote, or it's wrong (D2b's own conditional /runs read-gating — DEPLOY.md's "Gating matrix"). Set one: "aart remote add ${remoteName} <url> --environment <envName> --token-ref secrets.<NAME>" (or edit remotes.json directly) to match the value the remote's own AART_DEPLOY_TOKEN expects.`;
  }
  return `GET /runs on remote "${remoteName}" failed: ${remoteErrorMessage(response.body, response.status)}`;
}

export async function remoteRunsHandler(ctx: AartContext, input: RemoteRunsInput): Promise<HandlerResult> {
  const remoteEntry = await ctx.remotes.get(input.remote);
  if (!remoteEntry) return { ok: false, error: remoteNotFoundError(input.remote) };
  const token = await ctx.remotes.resolveToken(input.remote);

  // GET /runs supports ?status= server-side (server.ts) — mapped directly,
  // no client-side filtering needed.
  const qs = input.status ? `?status=${encodeURIComponent(input.status)}` : "";
  const response = await fetchFromRemote(remoteEntry, `/runs${qs}`, { token });
  if (response.networkError !== undefined) {
    return { ok: false, error: describeUnreachableRemote(input.remote, remoteEntry, response.networkError) };
  }
  if (!response.ok) {
    return { ok: false, error: describeRunReadFailure(input.remote, response) };
  }

  const runs = isRecord(response.body) && Array.isArray((response.body as { runs?: unknown }).runs) ? (response.body as { runs: RunRecord[] }).runs : [];
  const summaries: RemoteRunSummary[] = runs.map((run) => ({
    runId: run.runId,
    workflowId: run.workflowId,
    workflowVersion: run.workflowVersion,
    status: run.status,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    headline: deriveHeadline(run),
  }));

  return { ok: true, remote: input.remote, runs: summaries };
}

export interface RemoteRunInput {
  remote: string;
  runId: string;
  format?: "model" | "markdown";
}

export async function remoteRunHandler(ctx: AartContext, input: RemoteRunInput): Promise<HandlerResult> {
  const remoteEntry = await ctx.remotes.get(input.remote);
  if (!remoteEntry) return { ok: false, error: remoteNotFoundError(input.remote) };
  const token = await ctx.remotes.resolveToken(input.remote);

  const response = await fetchFromRemote(remoteEntry, `/runs/${encodeURIComponent(input.runId)}`, { token });
  if (response.networkError !== undefined) {
    return { ok: false, error: describeUnreachableRemote(input.remote, remoteEntry, response.networkError) };
  }
  if (response.status === 404) {
    return { ok: false, error: `Run "${input.runId}" not found on remote "${input.remote}".` };
  }
  if (!response.ok) {
    return { ok: false, error: describeRunReadFailure(input.remote, response) };
  }

  const body = response.body as { run?: RunRecord } | undefined;
  if (!body?.run) {
    return { ok: false, error: `Remote "${input.remote}" returned an unexpected response for GET /runs/${input.runId} — no "run" field.` };
  }

  // The redaction/report-rendering seam (see this file's own module doc
  // comment) — routes the remote-fetched RunRecord through the EXACT SAME
  // render path aart_get_report uses for a LOCAL run (execution.ts's
  // getReportHandler), never a second, parallel way to turn a RunRecord
  // into a report.
  const report = ctx.evidence.modelFacingReport(body.run);
  const result: HandlerResult = { ok: true, remote: input.remote, runId: input.runId, report };
  if (input.format === "markdown") result.markdown = ctx.evidence.markdownReport(body.run);
  return result;
}
