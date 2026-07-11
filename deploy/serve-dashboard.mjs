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
// TEST-DRIVE.md's manual walkthrough uses. Some write actions (approve/
// promote/risk-diff) are wired to real @aart/governance/@aart/server
// exports; others (triggering a run, resuming an approval, rendering a
// report) are still local mirrors pending @aart/dashboard's own
// composition-root wiring pass (TEST-DRIVE.md's "What doesn't work yet",
// AMENDMENTS.md A46's dashboard note) — this script does not attempt to
// change that; it only packages what already exists. See DEPLOY.md's
// "Ops limits" section for the honest read on what this means in
// production.
// Plain bare specifiers — this SOURCE file is never run directly by node
// inside the image; deploy/build-dashboard-launcher.mjs esbuild-bundles it
// (same philosophy as packages/cli/scripts/build-publish.mjs: inline the
// @aart/* workspace closure, leave genuine third-party packages external)
// into a single self-contained deploy/dist/serve-dashboard.mjs, which is
// what entrypoint.sh actually invokes. Two real, verified-by-building
// reasons this needs bundling rather than a plain `node deploy/serve-
// dashboard.mjs`:
//   1. This file lives at /app/deploy/, which has no node_modules of its
//      own in pnpm's non-hoisted workspace layout (each package's
//      dependencies are linked under THAT package's own node_modules —
//      e.g. /app/packages/dashboard/node_modules/@aart/* — never hoisted
//      to the workspace root) — a bare-specifier import from an unbundled
//      copy of this file fails to resolve (ERR_MODULE_NOT_FOUND).
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
  deps: createStubDeps(store),
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
