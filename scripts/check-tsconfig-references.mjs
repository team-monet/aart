#!/usr/bin/env node
// Structural guard (root AMENDMENTS.md A34): `tsc -b` derives build order from
// each package's OWN tsconfig.json "references" array, not from package.json
// "dependencies" and not from the flat list in root tsconfig.build.json. When
// a package.json dependency on a workspace @aart/* package isn't mirrored by
// a matching tsconfig.json reference, `tsc -b` has no edge telling it to
// build the dependency first. From a warm dist/ (or when incidental list
// order in tsconfig.build.json's own "references" happens to build the real
// dependency first anyway) this is invisible — it only surfaces as a
// cascading wall of TS2307 "Cannot find module" errors on a genuinely clean
// build. This defect class has independently bitten this repo three times
// (warm dist masking it, workspace node_modules masking it, test-file
// typechecking never exercising the project-reference graph at all) before
// finally surfacing in an from-clean build. This script asserts the
// package.json <-> tsconfig.json reference graphs agree, so a future PR that
// adds a workspace dependency without wiring the tsconfig reference fails
// fast and legibly here instead of as a 20-line cascading tsc dump.
//
// Plain .mjs, runnable with plain `node`, no build/typecheck required first
// — same rationale as scripts/smoke/*.mjs: this is meant to run BEFORE
// build in CI, so it can't itself depend on the thing it's guarding.
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const packagesDir = path.join(repoRoot, "packages");

/**
 * Minimal JSONC support (tsconfig.json files in this repo use `//` line
 * comments — see packages/blocks-core/tsconfig.json). String-literal-aware,
 * so it doesn't mangle "$schema": "https://..." (a bare substring search for
 * "//" would truncate that URL). Also tolerates a single trailing comma
 * before `}` or `]`, which tsc's own config parser accepts.
 */
function stripJsonComments(text) {
  let out = "";
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false;
        out += ch;
      }
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === "\\") {
        // preserve the escaped character verbatim, don't let it close the string
        out += text[i + 1] ?? "";
        i++;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    out += ch;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

async function readJsonc(filePath) {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(stripJsonComments(raw));
}

async function readJson(filePath) {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw);
}

async function main() {
  const entries = await readdir(packagesDir, { withFileTypes: true });
  const pkgDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();

  // Build package-name -> directory-basename map from every package.json's
  // own declared "name" (don't assume "@aart/foo" always lives in
  // packages/foo — packages/cli's own name is "@team-monet/aart", not
  // "@aart/cli", so this must be derived, not string-sliced).
  const nameToDir = new Map();
  const pkgInfo = new Map(); // dir -> { name, dependencies, devDependencies, tsconfigPath, hasTsconfig }

  for (const dir of pkgDirs) {
    const pkgJsonPath = path.join(packagesDir, dir, "package.json");
    let pkgJson;
    try {
      pkgJson = await readJson(pkgJsonPath);
    } catch (err) {
      console.error(`[check-tsconfig-references] FAILED — packages/${dir}/package.json missing or invalid: ${err.message}`);
      process.exitCode = 1;
      continue;
    }
    nameToDir.set(pkgJson.name, dir);
    pkgInfo.set(dir, {
      name: pkgJson.name,
      dependencies: pkgJson.dependencies ?? {},
      devDependencies: pkgJson.devDependencies ?? {},
    });
  }

  const errors = [];
  const notes = [];

  for (const dir of pkgDirs) {
    const info = pkgInfo.get(dir);
    if (!info) continue; // already reported a package.json error above

    const tsconfigPath = path.join(packagesDir, dir, "tsconfig.json");
    let tsconfig;
    try {
      await stat(tsconfigPath);
    } catch {
      // A package with @aart/* deps and no tsconfig.json at all would be a
      // different, more basic problem — only flag it if it actually has
      // workspace deps to satisfy.
      const workspaceDeps = Object.keys(info.dependencies).filter((d) => nameToDir.has(d) && d.startsWith("@aart/"));
      if (workspaceDeps.length > 0) {
        errors.push(`packages/${dir}: has @aart/* dependencies (${workspaceDeps.join(", ")}) but no tsconfig.json`);
      }
      continue;
    }
    try {
      tsconfig = await readJsonc(tsconfigPath);
    } catch (err) {
      errors.push(`packages/${dir}/tsconfig.json: failed to parse — ${err.message}`);
      continue;
    }

    const references = tsconfig.references ?? [];
    const referencedDirs = new Set(
      references.map((r) => path.basename(r.path)).filter(Boolean)
    );

    // Forward check (blocking): every @aart/* entry in package.json
    // "dependencies" (production — the ones tsc -b's src actually imports
    // from) must have a matching tsconfig.json reference.
    for (const depName of Object.keys(info.dependencies)) {
      if (!depName.startsWith("@aart/")) continue;
      const depDir = nameToDir.get(depName);
      if (!depDir) {
        errors.push(`packages/${dir}/package.json: dependency "${depName}" does not match any workspace package's declared name`);
        continue;
      }
      if (!referencedDirs.has(depDir)) {
        errors.push(
          `packages/${dir}/tsconfig.json: missing { "path": "../${depDir}" } — package.json declares "${depName}" as a dependency`
        );
      }
    }

    // Reverse check: every tsconfig.json reference should correspond to a
    // declared relationship in package.json (either dependencies or
    // devDependencies — e.g. a package used only from *.test.ts is
    // correctly a devDependency, and its tsconfig reference, while not load
    // -bearing for `tsc -b` (test files are excluded from the build), is
    // explainable and not a defect). A reference with NO corresponding
    // entry of any kind is orphaned — likely stale after a refactor, or a
    // genuinely undeclared dependency — and IS blocking.
    for (const refDir of referencedDirs) {
      const refPkg = [...pkgInfo.entries()].find(([d]) => d === refDir);
      const refName = refPkg ? refPkg[1].name : null;
      const inDeps = refName && Object.prototype.hasOwnProperty.call(info.dependencies, refName);
      const inDevDeps = refName && Object.prototype.hasOwnProperty.call(info.devDependencies, refName);
      if (!inDeps && !inDevDeps) {
        errors.push(
          `packages/${dir}/tsconfig.json: references "../${refDir}" but package.json has no dependency or devDependency on it (${refName ?? "unresolvable path"}) — stale reference?`
        );
      } else if (!inDeps && inDevDeps) {
        notes.push(
          `packages/${dir}/tsconfig.json: references "../${refDir}" via devDependency "${refName}" only (not a production dependency) — fine if it's legitimately build-time-only: only used from *.test.ts (tsconfig.base.json excludes test files from the build graph), or the package's dist output is a bundling INPUT that never survives into what's published (e.g. packages/cli's build:publish step, root AMENDMENTS.md A35)`
        );
      }
    }
  }

  if (notes.length > 0) {
    console.log(`[check-tsconfig-references] ${notes.length} informational note(s) (non-blocking):`);
    for (const note of notes) console.log(`  note: ${note}`);
  }

  if (errors.length > 0) {
    console.error(`\n[check-tsconfig-references] FAILED — ${errors.length} tsconfig.json reference mismatch(es):`);
    for (const err of errors) console.error(`  error: ${err}`);
    console.error(
      "\nEach package.json \"dependencies\" entry on a workspace @aart/* package needs a matching tsconfig.json " +
        '"references" path, or `tsc -b` build order silently depends on incidental list position instead of the ' +
        "real dependency graph. Add the missing { \"path\": \"../<pkg>\" } entries (or remove the stale package.json/" +
        "tsconfig.json entry, whichever is actually correct)."
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `[check-tsconfig-references] OK — all ${pkgDirs.length} packages' tsconfig.json reference graphs agree with their package.json dependencies.`
  );
}

main().catch((err) => {
  console.error("[check-tsconfig-references] FAILED —", err);
  process.exitCode = 1;
});
