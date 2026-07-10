// The concrete producer of S4 (governance)'s `PackSealCheck[]` shape —
// discovered by reading `packages/governance/src/validation/capability.ts`
// via the sibling S4 worktree (this session's own briefing named this seam
// "isPackSealBroken + packSealChecks hooks"; `isPackSealBroken` was already
// documented in SEAMS.md R1 before this file existed — `packSealChecks` is
// the OTHER half, found in `validation/capability.ts`, not
// `pack-approval.ts`):
//
//   // packages/governance/src/validation/capability.ts (S4, read-only reference)
//   interface PackSealCheck { packName: string; sealBroken: boolean }
//   interface CapabilityValidationContext { granted: string[]; packSealChecks?: PackSealCheck[] }
//
// That file's own doc comment states the mapping this function fills:
// "Computed by the caller, typically via isPackSealBroken (pack-approval.ts)
// against S7's real content-hash data" and "[the block→pack mapping] is
// S7's @aart/registry domain, not something CapabilityClosureLookup
// exposes." This module is that computation, producing the EXACT shape S4
// consumes rather than leaving S4/S9 to hand-assemble it from this
// package's lower-level primitives (`recomputePackManifest`,
// `PackageManagerAdapter`).
import type { AartStore } from "@aart/store";
import { npmPackageNameFor, parsePackManifestYaml, recomputePackManifest } from "./manifest.js";
import type { PackageManagerAdapter } from "./package-manager.js";

/** Matches S4's `validation/capability.ts` `PackSealCheck` shape field-for-field (independently declared — `@aart/governance` is a stub in this worktree, see SEAMS.md R1's note on the same constraint). */
export interface PackSealCheck {
  packName: string;
  sealBroken: boolean;
}

export interface PackVersionRef {
  name: string;
  version: string;
}

/**
 * For each `(name, version)` a workflow's capability-closure computation
 * says it depends on (the CALLER's job to resolve — this function
 * deliberately does not try to derive "which packs does this workflow use"
 * itself, since `AartStore.packManifests` has no "list every known pack"
 * primitive to walk, and a workflow's own declared/pinned pack version is
 * the more precise, correct input anyway rather than this function
 * guessing "latest"), recomputes that pack's CURRENT content hash from its
 * installed files and compares it against the hash recorded at approval
 * time.
 *
 * A `(name, version)` with no recorded `PackManifest` at all is SKIPPED,
 * not reported — that is a reference-validity problem (spec §18.2's
 * "referenced blocks/versions exist," a different validation class),
 * not a seal-broken problem this function's contract covers.
 */
export async function computePackSealChecks(store: AartStore, packs: readonly PackVersionRef[], packageManager: PackageManagerAdapter): Promise<PackSealCheck[]> {
  const checks: PackSealCheck[] = [];
  for (const { name, version } of packs) {
    const approved = await store.packManifests.get(name, version);
    if (!approved) continue;

    const files = await packageManager.install(npmPackageNameFor(name));
    const raw = parsePackManifestYaml(files.manifestYaml);
    const current = recomputePackManifest(approved, raw, files.blockSources);

    checks.push({ packName: name, sealBroken: approved.contentHash !== current.contentHash });
  }
  return checks;
}
