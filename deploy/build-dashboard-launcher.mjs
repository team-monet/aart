#!/usr/bin/env node
// Bundles deploy/serve-dashboard.mjs into a single, self-contained
// deploy/dist/serve-dashboard.mjs — same philosophy as packages/cli/
// scripts/build-publish.mjs (root AMENDMENTS.md A33-A35, A49): inline the
// entire workspace-internal @aart/* closure, leave genuine third-party
// packages EXTERNAL rather than inlined (native/un-bundleable ones —
// isolated-vm, playwright — for correctness; the rest by choice, same
// EXTERNAL list build-publish.mjs already established and empirically
// verified for this exact @aart/* dependency graph, reused rather than
// re-derived).
//
// Run from the repo root after `pnpm run build` (needs packages/dashboard/
// dist and packages/store/dist to already exist — this bundles from
// already-built dist/, it doesn't build them itself, matching build-
// publish.mjs's own documented precondition).
import { chmodSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

// Reuses packages/cli/scripts/build-publish.mjs's own EXTERNAL list
// verbatim: @aart/dashboard's dependency graph (@aart/blocks-core,
// @aart/governance, @aart/llm, @aart/server, @aart/store, @aart/types) is
// a subset of the same @aart/* closure the CLI bundle already walks, so
// the same third-party packages are what it touches — verified by this
// script's own build succeeding with zero "could not resolve" errors, not
// assumed from the list matching.
const EXTERNAL = ["@anthropic-ai/sdk", "@modelcontextprotocol/sdk", "@modelcontextprotocol/sdk/*", "ajv", "isolated-vm", "js-yaml", "playwright", "yaml", "zod"];

// Output lands in packages/cli/dist/ (a NEW file added to that already-
// gitignored build-output directory — packages/cli/src/ itself is never
// touched) rather than under deploy/, deliberately: packages/cli/dist/
// sits directly beside packages/cli/node_modules, which already carries
// every EXTERNAL package below as a real, correctly-linked dependency (the
// SAME reason packages/cli/dist/bin.js's own externals resolve at
// runtime — build-publish.mjs's own EXTERNAL list, reused verbatim). Node
// module resolution walks UP from a file's own directory; deploy/'s own
// location has no such node_modules (pnpm's non-hoisted workspace
// layout — see serve-dashboard.mjs's header comment), so placing the
// OUTPUT there, not just the source, would hit the exact same resolution
// gap one level later, for the externals rather than the workspace
// packages. Piggybacking on packages/cli/dist/'s already-correct
// resolution is simpler and more robust than inventing a second one.
const OUT_FILE = path.join(repoRoot, "packages/cli/dist/serve-dashboard.mjs");

async function main() {
  await esbuild.build({
    entryPoints: [path.join(repoRoot, "deploy/serve-dashboard.mjs")],
    outfile: OUT_FILE,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    external: EXTERNAL,
    sourcemap: true,
    logLevel: "info",
    // deploy/serve-dashboard.mjs's bare "@aart/store"/"@aart/dashboard"/
    // "@aart/governance" imports don't resolve from THIS file's own location
    // (deploy/ has no node_modules of its own) the way they would from
    // inside e.g. packages/dashboard/ (a real dependent). Pointing esbuild's
    // resolver straight at each package's already-built dist entry point
    // sidesteps needing deploy/ to be "a real pnpm workspace member" just to
    // build this one script — their OWN internal imports still resolve
    // normally from THEIR real location once esbuild follows the alias.
    // Only packages serve-dashboard.mjs imports BARE (directly, as a
    // top-level `import` in that file) need an entry here — @aart/governance
    // was already reachable, unaliased, as one of @aart/dashboard's own
    // internal dependencies (packages/dashboard/node_modules/@aart/
    // governance, real pnpm workspace linking) before A51 (AMENDMENTS.md); it
    // needs its OWN alias entry now for the identical reason @aart/store/
    // @aart/dashboard already did, only once serve-dashboard.mjs itself, not
    // just one of its dependencies, started referencing it by bare specifier.
    alias: {
      "@aart/store": path.join(repoRoot, "packages/store/dist/index.js"),
      "@aart/store/sqlite": path.join(repoRoot, "packages/store/dist/adapters/sqlite/index.js"),
      "@aart/dashboard": path.join(repoRoot, "packages/dashboard/dist/index.js"),
      "@aart/governance": path.join(repoRoot, "packages/governance/dist/index.js"),
    },
  });
  chmodSync(OUT_FILE, 0o755);
  console.log(`[build-dashboard-launcher] OK — ${path.relative(repoRoot, OUT_FILE)} is self-contained (workspace @aart/* closure inlined; EXTERNAL packages resolve via packages/cli's own node_modules, right beside it).`);
}

main().catch((err) => {
  console.error("[build-dashboard-launcher] FAILED —", err);
  process.exitCode = 1;
});
