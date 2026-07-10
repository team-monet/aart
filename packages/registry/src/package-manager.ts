// npm distribution mechanics — architecture ADR-12/§11.3: "`aart pack add
// <name>` runs `npm install` (or the workspace's package manager) under
// the hood plus registers the pack's manifest."
//
// This session's hard rule: ALL registry tests run against a local fake
// registry / linked packages — NEVER the real npm registry. That
// constraint is enforced here at the seam: `PackageManagerAdapter` is the
// injection point every install path goes through, so a test can supply
// `createFakePackageManager` (an in-memory catalog) instead of ever
// shelling out.
import { promises as fs } from "node:fs";
import { join } from "node:path";

/**
 * What installing (or resolving an already pnpm-workspace-linked) npm
 * package named "aart-pack-<name>" (ADR-12) yields — a manifest file's raw
 * YAML text plus each declared block's implementation source, keyed by
 * block id. Deliberately abstracted behind this interface rather than this
 * package hard-coding one specific installed-package file layout — a real
 * pack's on-disk shape (where exactly its manifest and block source files
 * live inside the installed npm package) is a packaging-convention detail
 * this module doesn't need to hard-code to do its own job (hashing,
 * approval-status wiring), and keeping it abstracted is what makes the
 * "never the real npm registry in tests" rule straightforward to honor.
 */
export interface InstalledPackageFiles {
  readonly manifestYaml: string;
  readonly blockSources: Readonly<Record<string, string>>;
}

export interface PackageManagerAdapter {
  /**
   * Installs (or resolves) an npm package by its FULL npm package name
   * (e.g. "aart-pack-github" — the ADR-12-prefixed form, NOT the pack's
   * own short `name:` field) and returns what's needed to build a
   * PackManifest from it.
   */
  install(npmPackageName: string): Promise<InstalledPackageFiles>;
}

export class PackageNotFoundError extends Error {}

/**
 * Deterministic in-memory fake — what this package's OWN test suite uses
 * exclusively (never a real npm/pnpm install). `catalog` stands in for
 * "the public registry" (or a linked workspace package) for test purposes.
 */
export function createFakePackageManager(catalog: Readonly<Record<string, InstalledPackageFiles>>): PackageManagerAdapter {
  return {
    async install(npmPackageName: string): Promise<InstalledPackageFiles> {
      const entry = catalog[npmPackageName];
      if (!entry) {
        throw new PackageNotFoundError(`no registry entry for "${npmPackageName}"`);
      }
      return entry;
    },
  };
}

/**
 * A "linked package" adapter — resolves an npm package already present on
 * disk (e.g. a pnpm workspace symlink under `node_modules/`, or any
 * directory laid out like an installed pack) by READING its files
 * directly, with no network/install step at all. This is the mechanism
 * this package's own tests use for the "linked package, not the real npm
 * registry" half of this session's test-fixture rule — point it at a
 * fixture directory and it behaves exactly like a real installed package
 * would, without ever touching the network.
 *
 * Expected on-disk layout (this package's own convention, since neither
 * source document specifies one): `<packageRoot>/aart-pack.yaml` (the
 * manifest) plus `<packageRoot>/blocks/<blockId>.js` for each block the
 * manifest declares.
 */
export function createLinkedPackageManager(options: { resolveRoot: (npmPackageName: string) => string }): PackageManagerAdapter {
  return {
    async install(npmPackageName: string): Promise<InstalledPackageFiles> {
      const root = options.resolveRoot(npmPackageName);
      let manifestYaml: string;
      try {
        manifestYaml = await fs.readFile(join(root, "aart-pack.yaml"), "utf8");
      } catch (cause) {
        throw new PackageNotFoundError(`no linked package found for "${npmPackageName}" at ${root}: ${(cause as Error).message}`);
      }
      // Minimal, deliberately-not-full-YAML-parse pass just to discover the
      // declared block ids so their source files can be read — the real
      // parse (with validation) happens once, centrally, in manifest.ts's
      // parsePackManifestYaml; duplicating a second full parser here would
      // be redundant work this function doesn't need to do its own job.
      const blockIds = extractBlockIdsForFileDiscovery(manifestYaml);
      const blockSources: Record<string, string> = {};
      for (const blockId of blockIds) {
        blockSources[blockId] = await fs.readFile(join(root, "blocks", `${blockId}.js`), "utf8");
      }
      return { manifestYaml, blockSources };
    },
  };
}

/** Cheap regex-based extraction of the `blocks:` YAML list's entries, used only to know which `blocks/<id>.js` files to read before the real (validating) YAML parse runs. Not a substitute for `parsePackManifestYaml` — that remains the single source of truth for manifest validity. */
function extractBlockIdsForFileDiscovery(manifestYaml: string): string[] {
  const match = manifestYaml.match(/^blocks:\s*\[(.*)]\s*$/m);
  const captured = match?.[1];
  if (!captured) return [];
  return captured
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
