#!/usr/bin/env node
// serve-dashboard.mjs — the `aart dashboard`-equivalent this image's
// entrypoint.sh runs for `docker run <image> dashboard` (AMENDMENTS.md A49).
//
// There is no literal `aart dashboard` CLI subcommand — `@aart/dashboard`
// is a private, workspace-only package (package.json: "private": true),
// deliberately never bundled into the published `@team-monet/aart` CLI
// (see that package's own build:publish script / AMENDMENTS.md A33-A35).
// This script is this deploy kit's own composition-root wrapper, built
// against @aart/dashboard's real, documented public API exactly the way
// TEST-DRIVE.md's own "(e) Starting the dashboard" section already tells a
// human to do it by hand — packaged here so it starts the same way every
// other role in this image does (`docker run <image> dashboard`), reading
// the same AART_ROOT/AART_STORE conventions `aart server`/`aart worker`
// honor, instead of being copy-pasted fresh into a scratch file each time.
//
// Deliberately NOT a change to packages/dashboard itself — this file lives
// outside that package entirely and only ever imports its already-published
// surface (index.ts's own exports), per this session's explicit boundary
// (packages/dashboard is another concurrent session's ownership).
//
// Uses createStubDeps — @aart/dashboard's own DI container, the SAME one
// TEST-DRIVE.md's manual walkthrough uses, with ONE field overridden below:
// `redact` is rebound from createStubDeps's own `identityRedact` default (a
// no-op stand-in stub-deps.ts itself calls "never-invoked-in-production")
// to @aart/governance's real `redactRecord` (AMENDMENTS.md A51, closing the
// gap A50 flagged here) — the same bare reference every other real
// composition root in this codebase binds with zero adapter
// (packages/mcp/src/real-context.ts's createRealEngine/
// createRealGovernancePort both do `redact: redactRecord` directly, since
// redactRecord already matches DashboardDeps.redact's RedactFn signature
// exactly). server.ts's redaction chokepoint (`/api/runs`, `/api/runs/:id`,
// `/api/artifacts`) now has the real algorithm wired into THIS launcher too,
// not a stand-in that never scrubs anything.
//
// Worth being precise about what this fix does and doesn't change:
// server.ts's own chokepoint (`redactRun`) always calls `deps.redact(run,
// new Set())` — an EMPTY resolved-secrets set, by that file's own explicit
// design (defense-in-depth over a RunRecord the engine already redacted at
// write time, not the primary scrub — see server.ts's `redactRun` doc
// comment). `redactRecord` only ever replaces values it's TOLD to look for
// via that second argument; fed an empty set, same as every existing call
// site in this package feeds it, it returns the record unchanged — same
// observable output as `identityRedact` for those specific calls, verified
// directly (AMENDMENTS.md A51), not assumed. Wiring in the real function
// here is still the right fix regardless (a production composition root
// carrying a stub documented as "never-invoked-in-production" is a real gap
// independent of what any ONE call site happens to pass today, and closes
// it for any future caller that DOES thread a real resolved-secrets set
// through) — just don't expect a value planted only in a run's trace to
// visibly disappear from these routes as a result of this specific change;
// see DEPLOY.md's "Ops limits" section for the fuller operational read.
//
// As of AMENDMENTS.md A47, every dashboard READ and WRITE route (trigger a
// run, approve/promote/block a workflow version, decide an approval task,
// corrections, evals, flag-clear) goes through the real @aart/server HTTP
// API this script points `createHttpApiClient(apiUrl)` at, not a
// dashboard-local reimplementation — `deps`/`createStubDeps` only still
// matters here for the two narrower gaps documented in TEST-DRIVE.md's
// "What doesn't work yet" (resuming a run's own wait step, and rendering
// the Run Detail page's HTML report) plus the risk-diff computation
// (deps.semanticRiskDiff, already real — see capability-catalog.ts). This
// script does not attempt to close either remaining gap; it only packages
// what already exists.
// Plain bare specifiers — this SOURCE file is never run directly by node
// inside the image; deploy/build-dashboard-launcher.mjs esbuild-bundles it
// (same philosophy as packages/cli/scripts/build-publish.mjs: inline the
// @aart/* workspace closure, leave genuine third-party packages external)
// into a single self-contained packages/cli/dist/serve-dashboard.mjs, which
// is what entrypoint.sh actually invokes. Two real, verified-by-building
// reasons this needs bundling rather than a plain `node deploy/serve-
// dashboard.mjs`:
//   1. This file lives at /app/deploy/, which has no node_modules of its
//      own in pnpm's non-hoisted workspace layout (each package's
//      dependencies are linked under THAT package's own node_modules —
//      e.g. /app/packages/dashboard/node_modules/@aart/* — never hoisted
//      to the workspace root) — a bare-specifier import from an unbundled
//      copy of this file fails to resolve (ERR_MODULE_NOT_FOUND). This is
//      why build-dashboard-launcher.mjs's own `alias` map has to name every
//      package THIS file imports directly (@aart/store, @aart/dashboard,
//      and — as of A51 — @aart/governance) rather than relying on plain
//      node resolution the way a file with a real node_modules beside it
//      could; see that script's own header comment.
//   2. @aart/store's dist/index.js barrel re-exports its conformance-suite
//      helper (conformance.js), which imports `vitest` — a devDependency,
//      correctly absent from this image's production-only node_modules.
//      Plain `node`, given the unbundled barrel file, eagerly resolves
//      every import that module graph touches merely by loading it, even
//      though createFsStore itself never calls into that code path —
//      esbuild's tree-shaking (this file only imports createFsStore, never
//      anything conformance-suite-related) avoids pulling that import in
//      at all.
import { createFsStore } from "@aart/store";
import { createSqliteStore } from "@aart/store/sqlite";
import { startDashboard, createHttpApiClient, createStubDeps } from "@aart/dashboard";
import { redactRecord } from "@aart/governance";

const root = process.env.AART_ROOT ?? "/data";
const storeKind = process.env.AART_STORE ?? "fs";
const port = process.env.AART_DASHBOARD_PORT ? Number(process.env.AART_DASHBOARD_PORT) : undefined;
const apiUrl = process.env.AART_SERVER_URL ?? "http://localhost:8080";
const workerUrls = (process.env.AART_WORKER_URLS ?? "http://localhost:8787")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (storeKind !== "fs" && storeKind !== "sqlite") {
  console.error(`[dashboard] AART_STORE must be "fs" or "sqlite" (got "${storeKind}").`);
  process.exit(1);
}

// Same two adapters `aart server`/`aart worker` choose between (cli.ts's
// own --store fs|sqlite handling) — the dashboard reads the identical
// on-disk store those processes write to, which is the whole point of
// pointing all three at the same shared volume (see docker-compose.yml).
const store = storeKind === "sqlite" ? await createSqliteStore(`${root}/aart.db`) : createFsStore(root);

const handle = await startDashboard({
  store,
  api: createHttpApiClient(apiUrl),
  // createStubDeps(store)'s own default `redact` (identityRedact) overridden
  // with @aart/governance's real redactRecord — see this file's own header
  // comment (AMENDMENTS.md A51) for why, and what it does/doesn't change.
  deps: { ...createStubDeps(store), redact: redactRecord },
  workerUrls,
  ...(port !== undefined ? { port } : {}),
});

console.log(`[dashboard] listening on :${handle.port} — store=${storeKind}:${root}, api=${apiUrl}, workers=[${workerUrls.join(", ")}]`);

let stopping = false;
async function stop() {
  if (stopping) return; // SIGTERM and SIGINT can both fire in a fast `docker stop`; only close the listener once.
  stopping = true;
  await handle.close();
  console.log("[dashboard] stopped.");
  process.exit(0);
}
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
