// Import/approval-flow wiring — architecture §11.2, spec §16.2/§44.1-44.2.
//
// Package-boundary note (this session's brief): "pack approval flows
// through S4's ApprovalTask mechanism — S7 owns the pack-specific
// hashing/manifest logic, S4 owns the generic approval write." Neither
// function below writes an ApprovalTask or touches `approvalStatus` beyond
// the hardcoded "unapproved" `buildPackManifest` already sets — approving
// a pack is exclusively governance's (S4) `writePackApprovalDecision`
// (`packages/governance/src/pack-approval.ts`), a distinct write path over
// the SAME `store.packManifests` row this module creates. `@aart/governance`
// is a stub in this worktree (S4's real implementation lives on a sibling
// branch) — this module has no dependency on it, compile-time or
// otherwise; see SEAMS.md for the convergence point S9 verifies at merge.
import type { AartStore, Logger } from "@aart/store";
import type { PackManifest } from "@aart/types";
import { buildPackManifest, npmPackageNameFor, parsePackManifestYaml } from "./manifest.js";
import type { PackageManagerAdapter } from "./package-manager.js";

export interface AuthorPackInput {
  readonly manifestYaml: string;
  readonly blockSources: Readonly<Record<string, string>>;
}

/**
 * Workspace-authored pack path — spec §16.2's "agent authors pack" →
 * "AART records content hash" (the two steps this function performs, in
 * that order). Everything after that in the §16.2 diagram ("human reviews
 * → human approves → runtime loads pack") is governance's, not this
 * function's.
 */
export async function authorPack(store: AartStore, input: AuthorPackInput, logger?: Logger): Promise<PackManifest> {
  const raw = parsePackManifestYaml(input.manifestYaml);
  const manifest = buildPackManifest(raw, input.blockSources);
  await store.packManifests.put(manifest);
  logger?.info("pack authored and registered", { pack: manifest.name, version: manifest.version, approvalStatus: manifest.approvalStatus });
  return manifest;
}

export class PackNameMismatchError extends Error {}

/**
 * npm-distributed pack path (ADR-12, architecture §11.3) — "`aart pack add
 * <name>` wraps a package-manager install + manifest registration."
 * `name` is the pack's OWN short logical name (e.g. "github"); this
 * function derives the "aart-pack-<name>" npm package name itself, so
 * callers never type the ADR-12 prefix by hand.
 *
 * Mechanically identical to `authorPack` from the content-hash/
 * approvalStatus step onward — both funnel through the SAME
 * `buildPackManifest` constructor, which has no `approvalStatus`
 * parameter at all. That is what makes "installing alone never sets
 * approval_status to anything but unapproved" (this session's DoD) and
 * spec §44.2's "an imported pack lands unapproved IDENTICALLY to a
 * workspace-authored one — no separate, weaker approval path" true by
 * construction: both call paths converge on one constructor that cannot
 * produce any other `approvalStatus`, rather than two independently-
 * maintained code paths that merely happen to agree today.
 */
export async function installPack(store: AartStore, name: string, packageManager: PackageManagerAdapter, logger?: Logger): Promise<PackManifest> {
  const npmPackageName = npmPackageNameFor(name);
  const files = await packageManager.install(npmPackageName);
  const raw = parsePackManifestYaml(files.manifestYaml);
  if (raw.name !== name) {
    throw new PackNameMismatchError(`npm package "${npmPackageName}" declares manifest name "${raw.name}", expected "${name}"`);
  }
  const manifest = buildPackManifest(raw, files.blockSources);
  await store.packManifests.put(manifest);
  logger?.info("pack installed from registry and registered", {
    pack: manifest.name,
    version: manifest.version,
    approvalStatus: manifest.approvalStatus,
    npmPackageName,
  });
  return manifest;
}
