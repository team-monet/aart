// Pack manifest format + construction — architecture §11.1, spec §16.1-16.3.
import type { PackManifest } from "@aart/types";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { computePackContentHash } from "./hash.js";

// Raw manifest shape — architecture §11.1's literal YAML example (name,
// version, capabilities, secrets, blocks) plus spec §16.3's fuller
// connector-capabilities list (auth method, scopes, read/write risk,
// external domains, rate limits, approval requirements, artifact output
// behavior) — none of those extra fields have a frozen shape in
// @aart/types (they're prose-only in spec §16.3, no TS block given), so
// this schema validates only the fields THIS package's own mechanics
// depend on (name/version/blocks; capabilities/secrets default to empty)
// and passes everything else through unvalidated-but-preserved via
// `.passthrough()` — a pack manifest is free to carry the fuller §16.3
// field set, this package just doesn't need to understand those fields to
// do its own job (hashing, approval-status wiring, discovery).
export const RawPackManifestSchema = z
  .object({
    name: z.string().min(1, "pack manifest must declare a name"),
    version: z.string().min(1, "pack manifest must declare a version"),
    capabilities: z.array(z.string()).default([]),
    secrets: z.array(z.string()).default([]),
    blocks: z.array(z.string()).min(1, "pack manifest must declare at least one block"),
  })
  .passthrough();
export type RawPackManifest = z.infer<typeof RawPackManifestSchema>;

export class PackManifestParseError extends Error {}

export function parsePackManifestYaml(yamlText: string): RawPackManifest {
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlText);
  } catch (cause) {
    throw new PackManifestParseError(`pack manifest is not valid YAML: ${(cause as Error).message}`, { cause });
  }
  const result = RawPackManifestSchema.safeParse(parsed);
  if (!result.success) {
    throw new PackManifestParseError(`pack manifest failed validation: ${result.error.message}`, { cause: result.error });
  }
  return result.data;
}

// UNSCOPED pack naming — ADR-12/ADR-18: packs are named "aart-pack-<name>",
// which has NOTHING to do with the `@team-monet/aart` npm scope this
// repo's own CLI package publishes under (ADR-18) — a pack manifest's own
// `name` field (spec §16.3's example: `name: github`) is the SHORT logical
// name; the npm PACKAGE that carries it is the prefixed form.
export const PACK_NPM_PREFIX = "aart-pack-";

export function npmPackageNameFor(packName: string): string {
  return `${PACK_NPM_PREFIX}${packName}`;
}

export class InvalidPackNameError extends Error {}

export function packNameFromNpmPackage(npmPackageName: string): string {
  if (!npmPackageName.startsWith(PACK_NPM_PREFIX)) {
    throw new InvalidPackNameError(`npm package "${npmPackageName}" does not follow the "${PACK_NPM_PREFIX}<name>" convention (ADR-12/ADR-18)`);
  }
  return npmPackageName.slice(PACK_NPM_PREFIX.length);
}

/**
 * The single constructor for a `PackManifest` row (`@aart/types`,
 * architecture §5.3 `pack_manifests` table). `approvalStatus` is not a
 * parameter here — not on this function, not anywhere else in this
 * package — it is hardcoded to `"unapproved"` on every call path
 * (workspace-authored via `authorPack`, npm-installed via `installPack`,
 * import.ts). That is what makes spec §44.2's "an imported pack lands
 * unapproved IDENTICALLY to a workspace-authored one, there is no
 * separate, weaker approval path" true BY CONSTRUCTION — there is no
 * parameter either call path could pass to make it otherwise — rather
 * than true only by two independently-maintained code paths happening to
 * agree today. The only way a `PackManifest` row's `approvalStatus` ever
 * becomes anything else is governance's (S4) `writePackApprovalDecision`
 * — a distinct package, a distinct write path, operating on a manifest
 * this function already produced. See SEAMS.md.
 */
export function buildPackManifest(raw: RawPackManifest, blockSources: Readonly<Record<string, string>>): PackManifest {
  const manifestJson = raw as unknown as Record<string, unknown>;
  return {
    name: raw.name,
    version: raw.version,
    contentHash: computePackContentHash(manifestJson, blockSources),
    manifest: manifestJson,
    approvalStatus: "unapproved",
  };
}

/**
 * Recomputes a pack's manifest with a FRESH content hash from its current
 * (manifest, blockSources) — registry's half of spec §16.2's "any edit
 * breaks approval seal": this produces the "current" side of the
 * comparison; governance's `isPackSealBroken(approvedSnapshot, current)`
 * (S4, `packages/governance/src/pack-approval.ts`) does the comparison.
 * Unlike `buildPackManifest`, this PRESERVES the manifest's own recorded
 * `approvalStatus` (whatever the caller already had on hand for
 * `existing`) rather than resetting it — recomputing a hash to check
 * whether a seal is broken must not itself silently downgrade the
 * approval; that decision belongs to whoever consumes the comparison
 * result (governance), not to this recomputation step.
 */
export function recomputePackManifest(existing: Pick<PackManifest, "approvalStatus">, raw: RawPackManifest, blockSources: Readonly<Record<string, string>>): PackManifest {
  const manifestJson = raw as unknown as Record<string, unknown>;
  return {
    name: raw.name,
    version: raw.version,
    contentHash: computePackContentHash(manifestJson, blockSources),
    manifest: manifestJson,
    approvalStatus: existing.approvalStatus,
  };
}
