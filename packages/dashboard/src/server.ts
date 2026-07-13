// createDashboardServer — wires every view/action module into the HTTP
// router. Mirrors @aart/server's own composition pattern (one server.ts
// wiring many domain modules — flags.ts, promotion.ts, environments.ts —
// together, observed in the S2 sibling worktree) rather than putting route
// logic inline here; this file is thin glue: parse request -> call `api`'s
// (or, for pure rendering, `deps`'s) function -> render or redirect.
//
// AMENDMENTS.md A47: every route below — read OR write — now goes through
// `api: ApiClient` alone. Before this session, only v1's read pages did;
// every writable action (trigger a run, approve/promote/block/mark a
// workflow, decide an approval task, record/act on a correction, create/run
// an eval suite, clear a run's flag) called `deps.X(store, ...)` directly
// against a SEPARATE, locally-constructed `AartStore` handle.
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createFsStore, type AartStore } from "@aart/store";
import { DEFAULT_EVENTS_LIMIT, MAX_EVENTS_LIMIT } from "@aart/server";
import type { ApiClient } from "./api-client.js";
import type { DashboardConfig } from "./config.js";
import { DEFAULT_DASHBOARD_PORT, DEFAULT_EVENTS_STREAM_POLL_INTERVAL_MS } from "./config.js";
import type { Clock } from "./clock.js";
import { systemClock } from "./clock.js";
import type { DashboardDeps } from "./deps.js";
import { createStubDeps } from "./stub-deps.js";
import { Router, sendJson } from "./http/router.js";
import { getBlockManifest, listBlockManifests } from "./capability-catalog.js";
import type { EventLogEntry, RunRecord, RunStatus } from "@aart/types";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

/** `AART_DASHBOARD_FRONTEND_DIR`, checked before any `__dirname`-relative
 * guess: every guess below assumes this package's OWN compiled `server.js`
 * is still physically sitting in `packages/dashboard/dist` at runtime,
 * which is only true when this package is loaded unbundled. The deploy
 * kit's `dashboard` launcher (`deploy/serve-dashboard.mjs`) esbuild-bundles
 * this package's code into `packages/cli/dist/serve-dashboard.mjs` (a
 * SIBLING package's dist dir) for reasons unrelated to this file (pnpm's
 * non-hoisted node_modules layout — see that script's own header comment);
 * once bundled, `__dirname` here resolves to wherever the BUNDLE physically
 * lives, not this source file's original location. The Dockerfile's
 * `runtime-base` stage sets this env var to the one absolute path that's
 * actually correct for that image's own layout (confirmed directly: a real
 * `docker run <image> dashboard` served a 404 for `GET /` before that env
 * var was added, despite `packages/dashboard/dist/frontend/index.html`
 * genuinely existing in the image).
 *
 * Wave 2 fix pass (AMENDMENTS.md A67 FIX 3): the FIRST guess below —
 * `path.join(__dirname, "frontend")` — already, correctly, covers the
 * bundled-into-the-published-CLI layout too, with no candidate-list change
 * needed: `deploy/build-dashboard-launcher.mjs` now copies this package's
 * built SPA (`packages/dashboard/dist/frontend`) to `packages/cli/dist/
 * frontend` — a direct sibling of `serve-dashboard.mjs` itself — and
 * esbuild's ESM bundling rewrites `import.meta.url` (hence `__dirname`,
 * derived from it below) to the BUNDLE's own real runtime file location
 * (verified empirically, not assumed, before relying on it: a small esbuild
 * ESM bundle built from a nested source path and then RUN from a
 * differently-nested output path still reports `import.meta.url` as its
 * own real output path). So when `packages/cli/dist/serve-dashboard.mjs`
 * runs (a real `npm install -g` global install, or `aart watch` spawning
 * it), `__dirname` here is `packages/cli/dist`, and `path.join(__dirname,
 * "frontend")` is exactly `packages/cli/dist/frontend` — the copy's own
 * target. The remaining three guesses stay exactly as they were (dev-layout
 * fallbacks this fix doesn't touch); Docker keeps using the env var
 * override above unconditionally, so it never even reaches this list. */
function getFrontendDir(): string | undefined {
  const override = process.env["AART_DASHBOARD_FRONTEND_DIR"];
  if (override) {
    if (existsSync(path.join(override, "index.html"))) {
      return override;
    }
    // AMENDMENTS.md A52: override SET but invalid (no index.html found
    // there) — warn loudly rather than silently falling through to the
    // __dirname-relative guesses below. An operator who set this env var
    // clearly intended it to be authoritative (the Dockerfile's
    // runtime-base stage is the one real caller today, per this
    // function's own header comment above), so a typo'd/stale path should
    // be visible, not a silent fallback that happens to still resolve
    // correctly in an unbundled dev checkout but would mask a real
    // misconfiguration in a bundled/containerized deploy. Unset stays
    // silent, exactly as before — that's the common, expected case, not a
    // misconfiguration.
    console.warn(`[dashboard] AART_DASHBOARD_FRONTEND_DIR is set to "${override}" but no index.html was found there. Falling back to guessing the frontend directory.`);
  }
  const paths = [
    path.join(__dirname, "frontend"),
    path.join(__dirname, "../frontend/dist"),
    path.resolve(__dirname, "../../frontend/dist"),
    path.resolve(__dirname, "../dist/frontend"),
  ];
  for (const p of paths) {
    if (existsSync(path.join(p, "index.html"))) {
      return p;
    }
  }
  return undefined;
}

function str(body: Record<string, unknown>, key: string, fallback = ""): string {
  const v = body[key];
  return typeof v === "string" ? v : fallback;
}

function parseJsonField(body: Record<string, unknown>, key: string): Record<string, unknown> {
  const raw = str(body, key, "{}");
  try {
    const parsed = JSON.parse(raw || "{}") as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function listRunsFilterFromQuery(query: URLSearchParams): { status?: RunStatus; workflowId?: string } {
  const status = query.get("status");
  const workflowId = query.get("workflowId");
  const filter: { status?: RunStatus; workflowId?: string } = {};
  if (status) filter.status = status as RunStatus;
  if (workflowId) filter.workflowId = workflowId;
  return filter;
}

// The redaction chokepoint (architecture §7.9) — every run-bearing API
// response routes through `deps.redact` before serialization, matching the
// pre-A47 server-rendered surface's "values NEVER shown" invariant (the old
// views/runs.ts's renderRunDetailPage/renderArtifactsPage received an
// already-redacted `run` from their caller; the JSON surface must give the
// same guarantee to whatever renders it now, including the SPA's raw `run`
// field which — unlike `reportHtml` below — has no renderer of its own
// forcing it through redact()). `resolvedSecretRefs` is `new Set()`, the
// same default `packages/evidence/src/redact.ts`'s `applyRedaction` and
// this package's own `createReportRenderers` use for a POST-PERSIST read:
// the engine has already redacted every persisted RunRecord at write time
// (architecture §7.9), so this call is defense-in-depth, not the primary
// scrub — but it IS the chokepoint every consumer must still go through,
// per that same architecture note, and `deps.redact` is real (not the
// identity stub) in production (server composition, not this package).
function redactRun(deps: DashboardDeps, run: RunRecord): RunRecord {
  return deps.redact(run, new Set()) as RunRecord;
}
function redactRuns(deps: DashboardDeps, runs: readonly RunRecord[]): RunRecord[] {
  return runs.map((run) => redactRun(deps, run));
}

// Wave 2 fix pass (AMENDMENTS.md A67 FIX 1, cold-auditor finding) — a
// defensive circuit breaker on drainNewEventsSince's own growing-limit loop
// below, not a real production ceiling (the realistic burst sizes this fix
// targets converge in 1-2 iterations; see that function's own doc comment).
const MAX_DRAIN_ATTEMPTS = 6; // 100 -> 200 -> 400 -> 800 -> 1600 -> 3200: comfortably past @aart/server's own MAX_EVENTS_LIMIT (1000) hard clamp within a handful of round-trips

/**
 * FIX 1 (Wave 2 fix pass, AMENDMENTS.md A67, cold-auditor finding): a single
 * `api.listEvents(cursor, limit)` call only ever returns the NEWEST `limit`
 * events matching `occurredAt >= cursor` (EventLogStore.list's own
 * contract — newest-first, LIMIT applied after the ORDER BY). If more than
 * `limit` events land between two ticks, the events strictly BETWEEN
 * "newest" and "the `limit`-th newest" were silently, PERMANENTLY excluded
 * the moment the old single-page tick advanced `cursor` straight to the
 * newest event's own timestamp — every LATER tick's `occurredAt >= cursor`
 * filter then skips right over them, forever.
 *
 * Fixed by re-querying `since: cursor` (unchanged) with a GROWING limit
 * until either (a) the returned batch is smaller than what was requested —
 * proof nothing was truncated, or (b) growing the limit further stops
 * returning more results. (b) is the real-world case that matters: a real
 * HTTP-backed ApiClient's own `GET /events` hard-clamps at @aart/server's
 * `MAX_EVENTS_LIMIT` (config.ts, 1000) regardless of what's requested, so
 * asking for more than that can never return more than the clamp already
 * gave; a same-process fake ApiClient has no such clamp, so (b) only ever
 * fires against a real deployed server. `since` is never changed between
 * attempts — re-fetching with a bigger limit re-derives the FULL correct
 * answer each time (there is no separate "next page" to append; a bigger
 * limit against the same `since` is always a superset of a smaller one) —
 * so nothing needs to be stitched together across requests.
 *
 * KNOWN, ACCEPTED RESIDUAL LIMIT, flagged here and in AMENDMENTS.md A67 —
 * not silently left unstated: `EventLogStore.list`'s own interface has only
 * `since`+`limit`, no upper-bound/continuation-token parameter at all, so
 * there is no way for this file alone to ask "the next page after the ones
 * I already have" once MAX_EVENTS_LIMIT's hard clamp is reached. If
 * genuinely more than MAX_EVENTS_LIMIT (1000) events land inside ONE
 * tick's own poll window (a sustained >600/s event rate against this
 * stream's default 1.5s poll interval), this drain can only push the
 * newest MAX_EVENTS_LIMIT of them to the LIVE stream THIS tick — and this
 * does NOT self-heal on a later tick (re-review correction, AMENDMENTS.md
 * A67 addendum — an earlier draft of this comment claimed it did): `tick()`
 * (below) always advances `cursor` to `batch[0].occurredAt`, the TRUE
 * newest event returned (unaffected by the cap — both store adapters
 * `ORDER BY occurred_at DESC` before `LIMIT` is applied, so index 0 is
 * always the real newest), so the OLDER events that overflowed this tick's
 * MAX_EVENTS_LIMIT-sized page are permanently skipped by every LATER
 * tick's own `occurredAt >= cursor` filter — the same class of gap FIX 1
 * closed below 1000, re-opened above it. Nothing is lost from the SYSTEM:
 * the overflow stays in the event store and is still returned by `GET
 * /api/events` (backfill) and visible on a dashboard refresh — only the
 * LIVE PUSH skips it, for this session. Closing this completely needs a
 * real store/HTTP pagination-shape change (an oldest-first/range query
 * `EventLogStore.list` doesn't support today — only `since`+`limit`),
 * outside this fix pass's own scope — left as a documented follow-up.
 * Below MAX_EVENTS_LIMIT — the actual bug FIX 1 closes, and the actual
 * scenario the original task described ("if >100 events land in one poll
 * window") — drainage is fully correct: nothing is ever dropped, live or
 * otherwise. The `console.warn` below fires whenever a tick's own drain
 * hits the MAX_EVENTS_LIMIT cap, so this residual is an observable,
 * documented signal, not a silent one.
 */
async function drainNewEventsSince(api: ApiClient, cursor: string, initialLimit: number): Promise<EventLogEntry[]> {
  let limit = initialLimit;
  let batch = await api.listEvents(cursor, limit);
  for (let attempt = 1; batch.length === limit && attempt < MAX_DRAIN_ATTEMPTS; attempt++) {
    const grownLimit = limit * 2;
    const grown = await api.listEvents(cursor, grownLimit);
    if (grown.length === batch.length) {
      // Asking for more didn't return more — either truly nothing further
      // exists since `cursor` (batch.length happened to land exactly on a
      // limit boundary), or a real ApiClient's own GET /events hit
      // @aart/server's hard MAX_EVENTS_LIMIT clamp. Either way, asking for
      // still more cannot help — this IS the final answer. `break` (not an
      // early `return`) so the ONE cap check below — shared with this
      // loop's normal exit — is what tells the two cases apart, rather
      // than silently returning here without ever running that check (a
      // re-review correction, AMENDMENTS.md A67 addendum: an earlier draft
      // returned directly from this branch, which is exactly the shape
      // that let a real cap-hit slip past the warning below undetected).
      batch = grown;
      break;
    }
    limit = grownLimit;
    batch = grown;
  }
  if (batch.length === MAX_EVENTS_LIMIT) {
    // Re-review correction (AMENDMENTS.md A67 addendum): this USED to
    // compare `batch.length` to the CALLER's own last-requested `limit`
    // (which keeps doubling: 100->200->400->...), not to the SERVER's
    // actual hard cap — so once `limit` grew past MAX_EVENTS_LIMIT, a real
    // ApiClient always returned exactly MAX_EVENTS_LIMIT regardless of how
    // much bigger `limit` got, `batch.length === limit` could never be
    // true again, and this warning was dead code for any burst large
    // enough to actually hit the cap (confirmed directly: a burst just
    // over MAX_EVENTS_LIMIT never fired it before this fix). Comparing
    // against MAX_EVENTS_LIMIT itself (imported from @aart/server, the
    // same constant `GET /events`'s own parseEventsLimit clamps to)
    // detects the real condition: this tick's own drain hit the server's
    // hard per-request ceiling, so if more than MAX_EVENTS_LIMIT new
    // events genuinely landed since `cursor`, the oldest of them were not
    // pushed to the live stream this tick (see this function's own
    // "KNOWN, ACCEPTED RESIDUAL LIMIT" doc above) — they remain in the
    // event store and are still available via `GET /api/events` (backfill)
    // or a dashboard refresh, just not on the live push this session.
    console.warn(`[dashboard] GET /api/events/stream: live event stream hit the per-tick cap (${batch.length} events, @aart/server's own MAX_EVENTS_LIMIT) while draining events since ${cursor} — if more than ${MAX_EVENTS_LIMIT} new events landed this tick, the oldest overflow was not pushed on the live stream; those events remain available via GET /api/events (backfill) or a dashboard refresh, not the live push.`);
  }
  return batch;
}

export function buildDashboardRouter(
  store: AartStore,
  api: ApiClient,
  deps: DashboardDeps,
  clock: Clock,
  workerUrls: readonly string[],
  eventsStreamPollIntervalMs: number = DEFAULT_EVENTS_STREAM_POLL_INTERVAL_MS,
): Router {
  const router = new Router();

  // -- API endpoints (JSON only) -------------------------------------------

  router.get("/health", (ctx) => sendJson(ctx.res, 200, { status: "ok" }));
  router.get("/api/health", (ctx) => sendJson(ctx.res, 200, { status: "ok" }));

  router.post("/api/runs/trigger", async (ctx, body) => {
    const inputs = parseJsonField(body, "inputs");
    const environment = str(body, "environment") || undefined;
    const run = await api.triggerRun({
      workflowId: str(body, "workflowId"),
      workflowVersion: str(body, "workflowVersion") || undefined,
      inputs,
      environment
    });
    sendJson(ctx.res, 200, run);
  });

  router.get("/api/runs", async (ctx) => {
    const runs = await api.listRuns(listRunsFilterFromQuery(ctx.query));
    sendJson(ctx.res, 200, redactRuns(deps, runs));
  });

  router.get("/api/runs/:id", async (ctx) => {
    const run = await api.getRun(ctx.params["id"]!);
    if (!run) {
      sendJson(ctx.res, 404, { error: "No such run." });
      return;
    }
    const renderers = deps.createReportRenderers(deps.redact);
    sendJson(ctx.res, 200, {
      run: redactRun(deps, run),
      reportHtml: renderers.html(run)
    });
  });

  router.get("/api/workflows", async (ctx) => {
    const workflows = await api.listWorkflowIds();
    sendJson(ctx.res, 200, workflows);
  });

  router.get("/api/workflows/:id", async (ctx) => {
    const id = ctx.params["id"]!;
    const detail = await api.getWorkflow(id, ctx.query.get("version") ?? undefined);
    if (!detail) {
      sendJson(ctx.res, 404, { error: "No such workflow." });
      return;
    }
    const recentRuns = await api.listRuns({ workflowId: id });
    sendJson(ctx.res, 200, {
      workflow: detail.workflow,
      versions: detail.versions,
      recentRuns
    });
  });

  router.post("/api/workflows/:id/approve", async (ctx, body) => {
    const id = ctx.params["id"]!;
    const action = str(body, "action") === "deprecate" ? "deprecate" : "approve";
    const trustMode = (str(body, "trustMode", "governed") as Parameters<ApiClient["approveOrDeprecateWorkflow"]>[3]) || "governed";
    await api.approveOrDeprecateWorkflow(id, str(body, "version"), action, trustMode);
    sendJson(ctx.res, 200, { success: true });
  });

  router.post("/api/workflows/:id/promote", async (ctx, body) => {
    const id = ctx.params["id"]!;
    await api.promoteWorkflow(id, str(body, "version"), str(body, "environmentId"));
    sendJson(ctx.res, 200, { success: true });
  });

  router.post("/api/workflows/:id/risk-diff", async (ctx, body) => {
    const id = ctx.params["id"]!;
    const fromVersion = str(body, "fromVersion");
    const toVersion = str(body, "toVersion");
    const [from, to] = await Promise.all([api.getWorkflow(id, fromVersion), api.getWorkflow(id, toVersion)]);
    if (!from || !to) {
      sendJson(ctx.res, 404, { error: "One or both workflow versions not found." });
      return;
    }
    const diff = deps.semanticRiskDiff(from.workflow, to.workflow);
    sendJson(ctx.res, 200, diff);
  });

  router.post("/api/workflows/:id/block-promotion", async (ctx, body) => {
    await api.blockPromotion(ctx.params["id"]!, str(body, "version"));
    sendJson(ctx.res, 200, { success: true });
  });
  router.post("/api/workflows/:id/unblock-promotion", async (ctx, body) => {
    await api.unblockPromotion(ctx.params["id"]!, str(body, "version"));
    sendJson(ctx.res, 200, { success: true });
  });
  router.post("/api/workflows/:id/mark-needs-review", async (ctx, body) => {
    await api.markNeedsReview(ctx.params["id"]!, str(body, "version"));
    sendJson(ctx.res, 200, { success: true });
  });
  router.post("/api/workflows/:id/clear-needs-review", async (ctx, body) => {
    await api.clearNeedsReview(ctx.params["id"]!, str(body, "version"));
    sendJson(ctx.res, 200, { success: true });
  });
  router.post("/api/workflows/:id/trigger-improvement", async (ctx, body) => {
    await api.triggerImprovementProposal(ctx.params["id"]!, str(body, "version"));
    sendJson(ctx.res, 200, { success: true });
  });

  router.get("/api/blocks", (ctx) => {
    sendJson(ctx.res, 200, listBlockManifests(store));
  });
  router.get("/api/blocks/:id", (ctx) => {
    const manifest = getBlockManifest(store, ctx.params["id"]!);
    if (!manifest) {
      sendJson(ctx.res, 404, { error: "No such block." });
      return;
    }
    sendJson(ctx.res, 200, manifest);
  });
  router.get("/api/packs", (ctx) => {
    sendJson(ctx.res, 200, { message: "Pending integration" });
  });

  router.get("/api/artifacts", async (ctx) => {
    const runs = await api.listRuns();
    sendJson(ctx.res, 200, redactRuns(deps, runs));
  });

  router.get("/api/waiting-runs", async (ctx) => {
    const waitingRuns = await api.listWaitingRuns();
    sendJson(ctx.res, 200, { waitingRuns, now: clock.now() });
  });

  router.get("/api/approvals", async (ctx) => {
    const approvals = await api.listApprovals("pending");
    sendJson(ctx.res, 200, approvals);
  });

  router.post("/api/approvals/:id/decision", async (ctx, body) => {
    const status = str(body, "status") as "approved" | "rejected" | "needs_changes";
    const trustMode = (str(body, "trustMode", "governed") as Parameters<ApiClient["decideApproval"]>[1]["trustMode"]) || "governed";
    await api.decideApproval(ctx.params["id"]!, { status, reviewer: str(body, "reviewer", "dashboard-operator"), trustMode });
    sendJson(ctx.res, 200, { success: true });
  });

  router.post("/api/corrections", async (ctx, body) => {
    await api.recordCorrection({
      runId: str(body, "runId"),
      stepId: str(body, "stepId"),
      fieldPath: str(body, "fieldPath"),
      observed: parseJsonField(body, "observed"),
      corrected: parseJsonField(body, "corrected"),
      reason: str(body, "reason"),
      reviewer: str(body, "reviewer"),
    });
    sendJson(ctx.res, 200, { success: true });
  });
  router.get("/api/corrections", async (ctx) => {
    const corrections = await api.listCorrections();
    sendJson(ctx.res, 200, corrections);
  });
  router.post("/api/corrections/:key/update-run-output", async (ctx) => {
    const run = await api.updateCorrectionRunOutput(ctx.params["key"]!);
    if (!run) {
      sendJson(ctx.res, 404, { error: "No such correction." });
      return;
    }
    sendJson(ctx.res, 200, run);
  });
  router.post("/api/corrections/:key/create-eval-example", async (ctx, body) => {
    const example = await api.createEvalExampleFromCorrection(ctx.params["key"]!, str(body, "suiteId"));
    if (!example) {
      sendJson(ctx.res, 404, { error: "No such correction." });
      return;
    }
    sendJson(ctx.res, 200, example);
  });
  router.post("/api/corrections/:key/create-issue", async (ctx) => {
    const brief = await api.createIssueForCorrection(ctx.params["key"]!);
    if (!brief) {
      sendJson(ctx.res, 404, { error: "No such correction." });
      return;
    }
    sendJson(ctx.res, 200, brief);
  });

  router.post("/api/evals/suites", async (ctx, body) => {
    await api.createEvalSuite({
      name: str(body, "name"),
      description: str(body, "description") || undefined,
      scorer: { id: `scorer-${Date.now()}`, kind: str(body, "scorerKind", "exact_match") }
    });
    sendJson(ctx.res, 200, { success: true });
  });
  router.post("/api/evals/runs", async (ctx, body) => {
    await api.runEvalSuite(str(body, "suiteId"), str(body, "workflowId"), str(body, "workflowVersion"));
    sendJson(ctx.res, 200, { success: true });
  });
  router.get("/api/evals", async (ctx) => {
    const { suites, runs } = await api.listEvals();
    sendJson(ctx.res, 200, { suites, runs });
  });

  router.get("/api/environments", async (ctx) => sendJson(ctx.res, 200, await api.listEnvironments()));
  router.get("/api/deployments", async (ctx) => sendJson(ctx.res, 200, await api.listDeployments()));
  router.get("/api/trigger-configs", async (ctx) => sendJson(ctx.res, 200, await api.listDeployments()));
  router.get("/api/secrets", async (ctx) => {
    const envs = await api.listEnvironments();
    const result = envs.map((e) => {
      const redactedSecretSource: Record<string, unknown> = {};
      if (e.secretSource) {
        for (const name of Object.keys(e.secretSource)) {
          redactedSecretSource[name] = { status: "bound" };
        }
      }
      return {
        ...e,
        secretSource: redactedSecretSource
      };
    });
    sendJson(ctx.res, 200, result);
  });

  router.get("/api/worker-health", async (ctx) => {
    const workers = await Promise.all(
      workerUrls.map(async (url) => {
        try {
          return { url, health: await api.workerHealth(url) };
        } catch (err) {
          return { url, health: { error: err instanceof Error ? err.message : "unknown error" } };
        }
      }),
    );
    sendJson(ctx.res, 200, workers);
  });

  router.get("/api/flagged-runs", async (ctx) => {
    sendJson(ctx.res, 200, await api.listFlaggedRunsViaApi());
  });
  router.post("/api/flagged-runs/:runId/clear", async (ctx, body) => {
    const result = await api.clearRunFlag(ctx.params["runId"]!, str(body, "clearedBy", "dashboard-operator"));
    if (result.kind !== "cleared") {
      sendJson(ctx.res, 409, { error: result.kind });
      return;
    }
    sendJson(ctx.res, 200, result);
  });

  // -- V2 Wave 2A: activity feed + live updates (AMENDMENTS.md A66) -------
  //
  // Both routes below read the V1 event log (AMENDMENTS.md A61) through
  // `api.listEvents` alone — same "every route goes through `api`" discipline
  // as everything above (this file's own header comment) — never `store`
  // directly. `GET /api/events` is the backfill/initial-load route the
  // frontend's ActivityFeedPage calls once on mount; `GET /api/events/stream`
  // is a read-only Server-Sent-Events broadcast of events NEW since the
  // connection opened. No redaction wrapper (unlike redactRun/redactRuns
  // above) — an EventLogEntry carries only run-lifecycle metadata (id/type/
  // occurredAt/summary + correlation ids), never a step's trace/inputs/
  // outputs (@aart/types' event-log.ts has no such field on the schema at
  // all), the same reasoning AMENDMENTS.md A63 FIX 2 already applied to the
  // real server's own GET /events (open, unauthenticated) — and the same
  // "no redact() call" precedent every other non-RunRecord list route in
  // this file already follows (listEnvironments/listDeployments/etc, above).

  router.get("/api/events", async (ctx) => {
    const since = ctx.query.get("since") ?? undefined;
    const limitParam = ctx.query.get("limit");
    const parsedLimit = limitParam === null || limitParam === "" ? undefined : Number(limitParam);
    const limit = parsedLimit !== undefined && Number.isFinite(parsedLimit) ? parsedLimit : undefined;
    const events = await api.listEvents(since, limit);
    sendJson(ctx.res, 200, events);
  });

  router.get("/api/events/stream", async (ctx) => {
    ctx.res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    ctx.res.flushHeaders?.();
    ctx.res.write(":ok\n\n"); // opens the stream — some proxies/clients wait for the first byte before treating the connection as live

    // Cursor mechanism: `cursor` starts at THIS connection's own open time
    // (`clock.nowIso()`, captured SYNCHRONOUSLY here — no `await` between
    // the `:ok` write above and this line, so no event loop turn can land
    // between them) rather than being derived from an async `listEvents()`
    // "seed" read. That matters: a seed read is itself asynchronous, so an
    // event appended CONCURRENTLY with it (e.g. a client connecting at the
    // exact moment a new event lands) could race the seed's own store read
    // and — if the seed treated whatever it observed as "already sent" —
    // be silently dropped forever. Anchoring the cursor to the connection's
    // own synchronous open time instead makes that race impossible by
    // construction: everything from here on is driven by `since: cursor`
    // (inclusive) on the first tick, which naturally catches anything at or
    // after this exact instant, however it interleaves.
    //
    // `EventLogStore.list`'s own `since` filter is INCLUSIVE
    // (`occurredAt >= since` — @aart/store's adapters/fs/events.ts and
    // adapters/sqlite/stores/events.ts both implement it this way), so
    // `sentIdsAtCursor` tracks which ids AT that exact timestamp have
    // already been sent — a same-millisecond tie (e.g. aart_approve's own
    // 3-event emission, AMENDMENTS.md A63 FIX 4) would otherwise be
    // silently dropped by a plain "occurredAt > cursor" comparison instead
    // of correctly re-checked against what's already gone out. Starts
    // empty: nothing has been sent yet at the connection's own open time.
    let cursor: string = clock.nowIso();
    let sentIdsAtCursor = new Set<string>();
    // FIX 4 (Wave 2 fix pass, AMENDMENTS.md A67, minor): re-entrancy guard —
    // setInterval fires on a fixed wall-clock cadence regardless of whether
    // the PREVIOUS tick's own awaited api.listEvents call (now potentially
    // several sequential round-trips, via drainNewEventsSince's growing-
    // limit loop above) has resolved yet. Without this flag, a slow tick
    // could still be in flight when the next one fires, and two concurrent
    // ticks racing the same `cursor`/`sentIdsAtCursor` mutable state could
    // interleave — reading a half-updated cursor, or writing/advancing out
    // of order (jitter, or a duplicate resend). Skipping an overlapping
    // tick entirely (rather than queueing it) is fine: the next tick after
    // that one will pick up from wherever `cursor` was actually left.
    let tickRunning = false;

    function isNewEvent(event: EventLogEntry): boolean {
      if (event.occurredAt > cursor) return true;
      return event.occurredAt === cursor && !sentIdsAtCursor.has(event.id);
    }

    async function tick(): Promise<void> {
      if (ctx.res.writableEnded) return; // client already disconnected; the close handler below already cleared the interval, but a tick can still be in flight when it fires
      if (tickRunning) return; // a previous tick is still in flight — see the doc comment on `tickRunning` above
      tickRunning = true;
      try {
        const batch = await drainNewEventsSince(api, cursor, DEFAULT_EVENTS_LIMIT);
        // Oldest-of-the-new-batch first: each SSE frame is one sequential
        // client-side "prepend to the top of the feed" (ActivityFeedPage.tsx)
        // — writing newest-first would leave the OLDEST event of this
        // tick's batch on top after every prepend applied, backwards from
        // the intended newest-on-top order.
        const fresh = batch.filter(isNewEvent).reverse();
        for (const event of fresh) {
          if (ctx.res.writableEnded) break;
          ctx.res.write(`data: ${JSON.stringify(event)}\n\n`);
        }
        if (batch.length > 0) {
          const newest = batch[0]!.occurredAt; // drainNewEventsSince's own batch is newest-first, same contract api.listEvents always had
          cursor = newest;
          sentIdsAtCursor = new Set(batch.filter((e) => e.occurredAt === newest).map((e) => e.id));
        }
      } catch (err) {
        // Never let a transient read failure kill the stream or crash the
        // dashboard process (this route's own explicit contract) — log and
        // keep the connection open; the next tick retries independently.
        console.error("[dashboard] GET /api/events/stream: failed to read events:", err);
      } finally {
        tickRunning = false;
      }
    }

    const interval = setInterval(() => {
      void tick();
    }, eventsStreamPollIntervalMs);

    // Idempotent shared cleanup for both ways this connection ends: a
    // normal client disconnect (req "close", already handled before this
    // fix pass) and a response-stream error (res "error", FIX 7 below — a
    // silent network partition or a write against an already-broken socket
    // otherwise surfaces as an UNHANDLED "error" event, which Node treats as
    // fatal and would crash the whole dashboard process, not just this one
    // connection). `closed` guards against both firing (a real disconnect
    // can plausibly trigger both in either order) and double-clearing/
    // double-ending as a result.
    let closed = false;
    function cleanup(): void {
      if (closed) return;
      closed = true;
      clearInterval(interval);
      if (!ctx.res.writableEnded) ctx.res.end();
    }

    // Read-only broadcast: this stream never touches the real server's own
    // ticker (single-instance constraint respected) — it only ever polls
    // `api.listEvents`, the same read every `GET /api/events` backfill call
    // makes. Each connection owns its own interval/cursor; closing one
    // client's tab never affects any other open stream.
    ctx.req.on("close", cleanup);
    ctx.res.on("error", (err) => {
      console.error("[dashboard] GET /api/events/stream: response stream error:", err);
      cleanup();
    });
  });

  return router;
}

export interface DashboardHandle {
  server: Server;
  port: number;
  close(): Promise<void>;
}

function placeholderStore(): AartStore {
  return createFsStore(path.join(tmpdir(), "aart-dashboard-unused-store"));
}

export async function startDashboard(config: DashboardConfig): Promise<DashboardHandle> {
  const clock = config.clock ?? systemClock;
  const store = config.store ?? placeholderStore();
  const deps = config.deps ?? createStubDeps(store, clock);
  const router = buildDashboardRouter(store, config.api, deps, clock, config.workerUrls ?? [], config.eventsStreamPollIntervalMs ?? DEFAULT_EVENTS_STREAM_POLL_INTERVAL_MS);
  
  const frontendDir = getFrontendDir();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;

    // Route to API or health endpoint if matched
    if (pathname.startsWith("/api/") || pathname === "/health") {
      await router.handle(req, res);
      return;
    }

    // Serve static files and fallback to index.html for SPA
    if (frontendDir && req.method === "GET") {
      try {
        // Resolve-then-verify-prefix, not strip-then-join: URL pathnames are
        // always "/"-delimited (WHATWG URL spec) regardless of host OS, so
        // decode/normalize with path.posix first, never plain `path` (which
        // is "\"-delimited on Windows and would treat a decoded literal
        // "\.." as a plain filename character there, not a traversal
        // segment, if normalized with the OS-specific module instead).
        // Stripping a leading "../" prefix (the prior approach) only
        // catches that one shape — it doesn't defend against whatever a
        // resolve() ends up producing after normalization on every
        // platform. Resolving to an absolute path and verifying it's still
        // inside frontendDir is the robust pattern regardless of the exact
        // encoding a traversal attempt uses; a request that fails the check
        // is treated exactly like "file not found" below (SPA fallback to
        // index.html), never a distinguishable error that would confirm to
        // a caller whether the traversal "worked."
        const resolvedRoot = path.resolve(frontendDir);
        const decodedPath = path.posix.normalize(decodeURIComponent(pathname));
        const resolvedPath = path.resolve(resolvedRoot, `.${decodedPath}`);
        const withinRoot = resolvedPath === resolvedRoot || resolvedPath.startsWith(resolvedRoot + path.sep);

        let filePath = withinRoot ? resolvedPath : path.join(resolvedRoot, "index.html");

        let stat;
        try {
          stat = await fs.stat(filePath);
        } catch {
          // File does not exist, use SPA fallback (index.html)
          filePath = path.join(resolvedRoot, "index.html");
          stat = await fs.stat(filePath);
        }

        if (stat.isDirectory()) {
          filePath = path.join(filePath, "index.html");
          stat = await fs.stat(filePath);
        }

        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || "application/octet-stream";

        res.writeHead(200, { "content-type": contentType });
        const content = await fs.readFile(filePath);
        res.end(content);
        return;
      } catch (err) {
        // Generic body — never echo err.message (e.g. an fs error can
        // embed the absolute filesystem path) to the client.
        console.error("[dashboard] static file serve failed:", err);
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("Internal Server Error");
        return;
      }
    }

    // Fallback if frontend build does not exist
    await router.handle(req, res);
  });

  const port = config.port ?? DEFAULT_DASHBOARD_PORT;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, resolve);
  });
  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : port;
  return {
    server,
    port: boundPort,
    // Wave 2 fix pass (AMENDMENTS.md A67 FIX 2, SECONDARY): plain
    // `server.close()` stops accepting NEW connections but waits for every
    // EXISTING connection — including an idle keep-alive one a client is
    // simply holding open, or one of this dashboard's own open SSE streams
    // (GET /api/events/stream, which by design stays open indefinitely) —
    // to close on its own before its callback fires. That made
    // `deploy/serve-dashboard.mjs`'s stop() (which calls this same
    // `close()`) hang on SIGTERM past `aart watch`'s own shutdown grace
    // period, forcing a SIGKILL rather than the clean exit `aart server`/
    // `aart worker` already both achieve. `server.closeAllConnections()`
    // (Node 18.2+, well under this workspace's `engines.node: ">=22"`
    // floor) force-closes every open connection immediately AFTER `close()`
    // has already stopped accepting new ones, so the `close()` callback
    // fires promptly instead of waiting on a keep-alive timeout or an SSE
    // stream that, by design, never closes itself.
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections?.();
      }),
  };
}

export { Router };
