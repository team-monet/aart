#!/usr/bin/env node
// Publish bundle (root AMENDMENTS.md A33 -> A35). `packages/cli`'s plain
// `"build": "tsc -b"` transpiles only — every `import` of a workspace
// @aart/* package survives verbatim into dist/, and three of them
// (@aart/mcp, @aart/store, @aart/types) are marked `"private": true`, so
// `npm install` of the published tarball 404s (A33's reproduced finding).
//
// Fix: bundle the ENTIRE workspace-internal @aart/* closure into
// dist/bin.js and dist/index.js with esbuild, so the published artifact is
// self-contained w.r.t. private packages. Genuine third-party dependencies
// (zod, playwright, isolated-vm, ...) are deliberately left EXTERNAL, not
// inlined — they're real, independently-installable npm packages already
// correctly declared in package.json "dependencies"; inlining them would
// buy nothing and actively risks breaking playwright (known to not survive
// bundling — it locates its own driver/browser assets via runtime
// require.resolve) and isolated-vm (a native .node addon — can't be
// text-inlined by a JS bundler at all, full stop). Native/un-bundleable
// packages are EXTERNAL for correctness; the rest are external by choice,
// to keep this bundle's job scoped to exactly the problem A33 found (a
// private-package boundary), nothing more.
//
// Assumes `tsc -b` has already run (this package's own "build" script,
// which — since packages/cli/tsconfig.json correctly references
// ../mcp/../store/../types — recursively builds the entire upstream
// @aart/* graph first). This script bundles from each package's already
// -built dist/, it doesn't build them itself.
import { readFileSync, chmodSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const BUNDLE_ENTRY_OUTPUTS = new Set(["bin.js", "bin.js.map", "index.js", "index.js.map"]);

/**
 * `tsc -b` (run just before this script, see the "build:publish" script
 * definition) emits one .js/.js.map PER SOURCE FILE across all of dist/
 * (dist/cli.js, dist/commands/*.js, dist/stubs/server.js, ...) — normal for
 * plain transpilation, but every one of them is now dead weight: bin.js and
 * index.js are self-contained bundles that inline all of it, nothing will
 * ever import the individual files again, yet package.json's "files":
 * ["dist"] would still publish them. Removes every .js/.js.map EXCEPT the
 * two bundle entry outputs. Deliberately leaves every .d.ts/.d.ts.map
 * completely alone — those are still exactly what "types": "./dist/
 * index.d.ts" resolves through for a consuming project, untouched by
 * bundling (esbuild only ever touched bin.js/index.js).
 */
function removeDeadPerFileOutputs(dir) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      removeDeadPerFileOutputs(full);
      continue;
    }
    const isJsOrMap = entry.endsWith(".js") || entry.endsWith(".js.map");
    if (isJsOrMap && !BUNDLE_ENTRY_OUTPUTS.has(entry)) {
      unlinkSync(full);
    }
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.resolve(__dirname, "..");

const pkgJson = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));
const declaredDeps = new Set(Object.keys(pkgJson.dependencies ?? {}));

// Every third-party (non-@aart) package actually imported anywhere in the
// transitive @aart/* closure this CLI bundles (verified by hand against
// every package.json in packages/*, then cross-checked below against
// esbuild's own metafile — the empirical source of truth — rather than
// trusted blind). @modelcontextprotocol/sdk is imported via deep subpaths
// (e.g. "@modelcontextprotocol/sdk/server/mcp.js"), hence the wildcard.
const EXTERNAL = [
  "@anthropic-ai/sdk",
  "@modelcontextprotocol/sdk",
  "@modelcontextprotocol/sdk/*",
  "ajv",
  "isolated-vm",
  "js-yaml",
  "playwright",
  "yaml",
  "zod",
];

// AMENDMENTS.md A45: `node:sqlite` (packages/store/src/adapters/sqlite/db.ts
// — chosen specifically to avoid a native-addon dependency, see that file's
// own header comment) is a genuine Node builtin, but it's still
// EXPERIMENTAL on this workspace's Node floor (verified directly: `node
// -e "require('node:module').builtinModules.includes('sqlite')"` -> false
// on Node v22.22.2) — `node:module`'s own `builtinModules` list doesn't yet
// carry it, so it isn't caught by the general `node:${m}` derivation below.
// Without this, the cross-check three lines down would demand "sqlite" be
// added to package.json "dependencies" — which would be actively WRONG
// (there is no installable npm package by that name; a real `npm install`
// of the published tarball would 404 trying to fetch it, reproducing
// exactly the class of bug this whole script exists to prevent, A33).
// Listed explicitly so a genuinely-missing real dependency still fails this
// build the way it should, while this one correctly doesn't.
const EXPERIMENTAL_BUILTINS_NOT_YET_IN_MODULE_BUILTINS = ["node:sqlite"];
const builtins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`), ...EXPERIMENTAL_BUILTINS_NOT_YET_IN_MODULE_BUILTINS]);

async function main() {
  const result = await esbuild.build({
    entryPoints: [path.join(pkgDir, "src/bin.ts"), path.join(pkgDir, "src/index.ts")],
    outdir: path.join(pkgDir, "dist"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    external: EXTERNAL,
    sourcemap: true,
    metafile: true,
    logLevel: "info",
    allowOverwrite: true,
  });

  // Empirical cross-check, not a hand-maintained assumption: walk what
  // esbuild ACTUALLY left external across both bundled outputs, and make
  // sure package.json "dependencies" accounts for every one of them (minus
  // Node builtins, which aren't npm dependencies). A package imported by
  // some future change to the @aart/* closure that isn't in EXTERNAL would
  // get bundled instead (probably breaking, for a native addon) or, if
  // added to EXTERNAL but not to "dependencies", would reproduce exactly
  // A33's bug for a new package instead of the three original ones — this
  // check exists so that mistake fails the build instead of shipping.
  const encountered = new Set();
  for (const output of Object.values(result.metafile.outputs)) {
    for (const imp of output.imports ?? []) {
      if (imp.kind === "external" || imp.external) encountered.add(imp.path);
    }
  }

  const encounteredPackageNames = new Set(
    [...encountered]
      .filter((spec) => !builtins.has(spec))
      .map((spec) => {
        // scoped package: first two path segments; unscoped: first segment.
        const parts = spec.split("/");
        return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
      })
  );

  const missingFromPackageJson = [...encounteredPackageNames].filter((name) => !declaredDeps.has(name));
  if (missingFromPackageJson.length > 0) {
    console.error(
      `[build-publish] FAILED — the bundle actually imports ${missingFromPackageJson.join(", ")} as external, ` +
        `but package.json "dependencies" does not declare ${missingFromPackageJson.length === 1 ? "it" : "them"}. ` +
        "This would reproduce A33's bug for a new package. Add it to \"dependencies\" (or, if it should be bundled " +
        "instead, remove it from this script's EXTERNAL list)."
    );
    process.exitCode = 1;
    return;
  }

  const declaredButUnused = [...declaredDeps].filter((name) => !encounteredPackageNames.has(name));
  if (declaredButUnused.length > 0) {
    console.warn(
      `[build-publish] note: package.json declares ${declaredButUnused.join(", ")} as a dependency, but the bundle ` +
        "never actually imported it as external — dead dependency, or only reached via a dynamic path esbuild " +
        "couldn't see statically. Worth a look, not failing the build over it."
    );
  }

  // No workspace @aart/* package should survive as an external import —
  // that's the entire point of this bundle. If one does, something in
  // EXTERNAL is wrong (or a new @aart/* package was added without being
  // caught by the wildcard-free bundle-everything-else default).
  const leakedWorkspacePackages = [...encountered].filter((spec) => spec.startsWith("@aart/"));
  if (leakedWorkspacePackages.length > 0) {
    console.error(
      `[build-publish] FAILED — workspace package(s) ${leakedWorkspacePackages.join(", ")} were left external instead ` +
        "of bundled. The published tarball would 404 on install for these, same as A33's original finding."
    );
    process.exitCode = 1;
    return;
  }

  removeDeadPerFileOutputs(path.join(pkgDir, "dist"));
  chmodSync(path.join(pkgDir, "dist/bin.js"), 0o755);

  console.log(
    `[build-publish] OK — bundled ${result.metafile ? Object.keys(result.metafile.outputs).length : 2} output(s). ` +
      `External (real npm dependencies, not inlined): ${[...encounteredPackageNames].sort().join(", ")}.`
  );
}

main().catch((err) => {
  console.error("[build-publish] FAILED —", err);
  process.exitCode = 1;
});
