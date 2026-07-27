// Pack manifest format + construction — architecture §11.1, spec §16.1-16.3.
import type { PackManifest } from "@aart/types";
import { valid as validSemver } from "semver";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { computePackContentHash } from "./hash.js";

const PACK_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const SAFE_ASSET_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const safeAssetSegment = (kind: string) =>
  z
    .string()
    .regex(SAFE_ASSET_SEGMENT_PATTERN, `${kind} must start with a letter or number and contain only letters, numbers, dot, underscore, or hyphen`)
    .refine((value) => value !== "." && value !== "..", `${kind} cannot be "." or ".."`);

// Raw manifest shape — architecture §11.1's literal YAML example (name,
// version, capabilities, secrets, blocks) plus spec §16.3's fuller
// connector-capabilities list (auth method, scopes, read/write risk,
// external domains, rate limits, approval requirements, artifact output
// behavior) — none of those extra fields have a frozen shape in
// @aart/types (they're prose-only in spec §16.3, no TS block given), so
// this schema validates only the fields THIS package's own mechanics
// depend on (name/version/blocks/workflows; capabilities/secrets default to empty)
// and passes everything else through unvalidated-but-preserved via
// `.passthrough()` — a pack manifest is free to carry the fuller §16.3
// field set, this package just doesn't need to understand those fields to
// do its own job (hashing, approval-status wiring, discovery).
export const RawPackManifestSchema = z
  .object({
    name: z
      .string()
      .regex(
        PACK_NAME_PATTERN,
        "pack name must start with a lowercase letter or number and contain only lowercase letters, numbers, dot, underscore, or hyphen",
      ),
    version: z
      .string()
      .refine((version) => validSemver(version) !== null, "pack version must be valid SemVer"),
    displayName: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    categories: z.array(z.string().min(1)).default([]),
    tags: z.array(z.string().min(1)).default([]),
    author: z
      .union([
        z.string().min(1),
        z.object({
          name: z.string().min(1),
          url: z.string().url().optional(),
        }),
      ])
      .optional(),
    license: z.string().min(1).optional(),
    repository: z.string().url().optional(),
    homepage: z.string().url().optional(),
    compatibility: z
      .object({
        aart: z.string().min(1).optional(),
        node: z.string().min(1).optional(),
        runtimes: z.array(z.string().min(1)).default([]),
      })
      .optional(),
    capabilities: z.array(z.string()).default([]),
    secrets: z.array(z.string()).default([]),
    blocks: z.array(safeAssetSegment("block id")).default([]),
    workflows: z.array(safeAssetSegment("workflow id")).default([]),
  })
  .passthrough()
  .refine((manifest) => manifest.blocks.length + manifest.workflows.length > 0, {
    message: "pack manifest must declare at least one block or workflow",
  });
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
  if (!PACK_NAME_PATTERN.test(packName)) {
    throw new InvalidPackNameError(
      `pack name "${packName}" must start with a lowercase letter or number and contain only lowercase letters, numbers, dot, underscore, or hyphen`,
    );
  }
  return `${PACK_NPM_PREFIX}${packName}`;
}

export class InvalidPackNameError extends Error {}

export function packNameFromNpmPackage(npmPackageName: string): string {
  if (!npmPackageName.startsWith(PACK_NPM_PREFIX)) {
    throw new InvalidPackNameError(`npm package "${npmPackageName}" does not follow the "${PACK_NPM_PREFIX}<name>" convention (ADR-12/ADR-18)`);
  }
  const packName = npmPackageName.slice(PACK_NPM_PREFIX.length);
  npmPackageNameFor(packName);
  return packName;
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
export function buildPackManifest(
  raw: RawPackManifest,
  blockSources: Readonly<Record<string, string>>,
  workflowSources: Readonly<Record<string, string>> = {},
): PackManifest {
  assertDeclaredAssets(raw, blockSources, workflowSources);
  const manifestJson = raw as unknown as Record<string, unknown>;
  return {
    name: raw.name,
    version: raw.version,
    contentHash: computePackContentHash(manifestJson, blockSources, workflowSources),
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
export function recomputePackManifest(
  existing: Pick<PackManifest, "approvalStatus">,
  raw: RawPackManifest,
  blockSources: Readonly<Record<string, string>>,
  workflowSources: Readonly<Record<string, string>> = {},
): PackManifest {
  assertDeclaredAssets(raw, blockSources, workflowSources);
  const manifestJson = raw as unknown as Record<string, unknown>;
  return {
    name: raw.name,
    version: raw.version,
    contentHash: computePackContentHash(manifestJson, blockSources, workflowSources),
    manifest: manifestJson,
    approvalStatus: existing.approvalStatus,
  };
}

export class PackAssetMismatchError extends Error {}

function assertDeclaredAssets(
  raw: RawPackManifest,
  blockSources: Readonly<Record<string, string>>,
  workflowSources: Readonly<Record<string, string>>,
): void {
  const missingBlocks = raw.blocks.filter((id) => blockSources[id] === undefined);
  const extraBlocks = Object.keys(blockSources).filter((id) => !raw.blocks.includes(id));
  const missingWorkflows = raw.workflows.filter((id) => workflowSources[id] === undefined);
  const extraWorkflows = Object.keys(workflowSources).filter((id) => !raw.workflows.includes(id));
  if (missingBlocks.length + extraBlocks.length + missingWorkflows.length + extraWorkflows.length === 0) return;
  throw new PackAssetMismatchError(
    [
      missingBlocks.length ? `missing block sources: ${missingBlocks.join(", ")}` : "",
      extraBlocks.length ? `undeclared block sources: ${extraBlocks.join(", ")}` : "",
      missingWorkflows.length ? `missing workflow definitions: ${missingWorkflows.join(", ")}` : "",
      extraWorkflows.length ? `undeclared workflow definitions: ${extraWorkflows.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("; "),
  );
}
