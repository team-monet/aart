// produceBundle() — architecture §0.3/ADR-04: "aart bundle (packages/cli)
// produces this artifact from the store's current approved state" — the
// CLI command is S5's thin wrapper (architecture §1 note); the actual
// production LOGIC lives here, per this session's DoD ("the bundle
// production logic lives here (the CLI's thin bundle command delegates to
// you — S5's seam)"). See SEAMS.md for the exact exported signature.
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { AartStore } from "@aart/store";
import type { Deployment, PackManifest, PromptRegistryEntry, SchemaRegistryEntry, Workflow } from "@aart/types";
import { computeClosure, resolveClosureRegistryEntries } from "./closure.js";

// Zod schema, not just a TS interface, for one reason beyond this file's own
// use: load.ts (the consuming half, see that module's header) reads
// manifest.json off disk — untrusted input from whoever produced the bundle
// directory, possibly on a different machine/build — and needs a real
// runtime validator for it, the same way it needs WorkflowSchema/
// PackManifestSchema/etc. for the rest of the bundle's contents.
export const BundleManifestSchema = z.object({
  schemaVersion: z.literal(1),
  workflowId: z.string(),
  workflowVersion: z.string(),
  createdAt: z.string(),
  bundleHash: z.string(),
  workflows: z.array(z.object({ workflowId: z.string(), version: z.string() })),
  packs: z.array(z.object({ name: z.string(), version: z.string(), contentHash: z.string() })),
  prompts: z.array(z.object({ name: z.string(), version: z.string(), contentHash: z.string() })),
  schemas: z.array(z.object({ name: z.string(), version: z.string(), contentHash: z.string() })),
});
export type BundleManifest = z.infer<typeof BundleManifestSchema>;

export interface Bundle {
  manifest: BundleManifest;
  /** Keyed by `${workflowId}@${version}` — the full definition closure (architecture §0.3's `definitions/`). */
  definitions: Record<string, Workflow>;
  /** Keyed by `${name}@${version}` (architecture §0.3's `packs/`, pinned versions). */
  packs: Record<string, PackManifest>;
  /** Architecture §0.3's `registry/` — prompt/schema entries referenced. */
  registry: {
    prompts: Record<string, PromptRegistryEntry>;
    schemas: Record<string, SchemaRegistryEntry>;
  };
  /** Architecture §0.3's `triggers.json` — the deployment's own trigger config, passed through verbatim. */
  triggers: unknown;
}

/** Deterministic JSON stringify (sorted object keys, recursively) — what `bundleHash` is computed over, so the same logical bundle always hashes identically regardless of Map/object key insertion order. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * The one place `bundleHash` is actually computed — shared by `produceBundle`
 * below (over freshly-resolved store content) and `load.ts`'s
 * `verifyBundleHash` (over content re-read from a bundle directory on disk),
 * so the two sides can never independently drift on canonicalization and
 * silently produce/accept mismatched hashes for what's logically the same
 * content. `manifest` is deliberately typed as `Omit<BundleManifest,
 * "bundleHash" | "createdAt">` at both call sites — see this file's own
 * `produceBundle` doc comment on why `createdAt` is excluded, and
 * `bundleHash` obviously can't hash itself. `definitions`/`packs`/
 * `registry.*` are typed as plain `Record<string, unknown>` (not `Workflow`/
 * `PackManifest`/etc.) so this function works identically whether the caller
 * has already-Zod-validated, typed records (produceBundle) or freshly
 * `JSON.parse`d, not-yet-validated ones (load.ts hashes BEFORE schema
 * validation — see that module's own doc comment for why content-addressing
 * is checked first).
 */
export function computeBundleHash(input: {
  manifest: Omit<BundleManifest, "bundleHash" | "createdAt">;
  definitions: Record<string, unknown>;
  packs: Record<string, unknown>;
  registry: { prompts: Record<string, unknown>; schemas: Record<string, unknown> };
  triggers: unknown;
}): string {
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
}

export interface ProduceBundleParams {
  workflowId: string;
  /** Omit to resolve the workflow's latest version. */
  workflowVersion?: string;
  /** Pass a `Deployment` to pin `triggers.json` to its `triggerConfig` and record its id in the manifest; omit for a bare workflow-closure bundle (e.g. `aart bundle` invoked without `--target`/`--deployment`). */
  deployment?: Deployment;
}

export async function produceBundle(store: AartStore, params: ProduceBundleParams): Promise<Bundle> {
  const closure = await computeClosure(store, params.workflowId, params.workflowVersion);
  const resolved = await resolveClosureRegistryEntries(store, closure);

  const definitions: Record<string, Workflow> = {};
  for (const [key, workflow] of resolved.workflows) definitions[key] = workflow;

  const packs: Record<string, PackManifest> = {};
  for (const [key, manifest] of resolved.packs) packs[key] = manifest;

  const prompts: Record<string, PromptRegistryEntry> = {};
  for (const [key, entry] of resolved.prompts) prompts[key] = entry;

  const schemas: Record<string, SchemaRegistryEntry> = {};
  for (const [key, entry] of resolved.schemas) schemas[key] = entry;

  const rootKey = [...resolved.workflows.keys()].find((k) => k.startsWith(`${params.workflowId}@`));
  const [, resolvedVersion] = rootKey ? rootKey.split("@") : [params.workflowId, params.workflowVersion ?? "unknown"];

  const manifestWithoutHash: Omit<BundleManifest, "bundleHash"> = {
    schemaVersion: 1,
    workflowId: params.workflowId,
    workflowVersion: resolvedVersion!,
    createdAt: new Date().toISOString(),
    workflows: [...resolved.workflows.keys()].map((k) => {
      const [workflowId, version] = k.split("@");
      return { workflowId: workflowId!, version: version! };
    }),
    packs: [...resolved.packs.entries()].map(([k, m]) => {
      const [name, version] = k.split("@");
      return { name: name!, version: version!, contentHash: m.contentHash };
    }),
    prompts: [...resolved.prompts.entries()].map(([k, e]) => {
      const [name, version] = k.split("@");
      return { name: name!, version: version!, contentHash: e.contentHash };
    }),
    schemas: [...resolved.schemas.entries()].map(([k, e]) => {
      const [name, version] = k.split("@");
      return { name: name!, version: version!, contentHash: e.contentHash };
    }),
  };

  const triggers = params.deployment?.triggerConfig ?? {};
  // Deliberately excludes `createdAt` from the hashed payload: `bundleHash`
  // is a CONTENT address (architecture §0.3's "self-contained,
  // content-addressed" framing) — two bundles built from identical store
  // content at different real-world moments must hash identically, so a
  // deploy pipeline (or a human) can verify "this is the same deployable
  // artifact" independent of build wall-clock time. Everything that
  // actually varies the deployable content (workflows/packs/prompts/
  // schemas/triggers, and the manifest's own structural workflow/version
  // list) IS included.
  const { createdAt: _createdAt, ...hashableManifest } = manifestWithoutHash;
  const bundleHash = computeBundleHash({ manifest: hashableManifest, definitions, packs, registry: { prompts, schemas }, triggers });

  return {
    manifest: { ...manifestWithoutHash, bundleHash },
    definitions,
    packs,
    registry: { prompts, schemas },
    triggers,
  };
}

/** Writes a produced `Bundle` to disk in architecture §0.3's documented layout (`manifest.json`, `definitions/`, `packs/`, `registry/`, `triggers.json`) — what `aart server --bundle=<dir>` / `aart worker --bundle=<dir>` (S12, `load.ts` in this same directory) actually consume, and what a `docker run teammonet/aart-worker --bundle=...` / a K8s Job mounting a bundle would too, on top of the same CLI flag. */
export async function writeBundleToDisk(bundle: Bundle, outDir: string): Promise<void> {
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(join(outDir, "manifest.json"), JSON.stringify(bundle.manifest, null, 2));
  await fs.writeFile(join(outDir, "triggers.json"), JSON.stringify(bundle.triggers, null, 2));

  const definitionsDir = join(outDir, "definitions");
  await fs.mkdir(definitionsDir, { recursive: true });
  for (const [key, workflow] of Object.entries(bundle.definitions)) {
    await fs.writeFile(join(definitionsDir, `${sanitizeFilename(key)}.json`), JSON.stringify(workflow, null, 2));
  }

  const packsDir = join(outDir, "packs");
  await fs.mkdir(packsDir, { recursive: true });
  for (const [key, manifest] of Object.entries(bundle.packs)) {
    await fs.writeFile(join(packsDir, `${sanitizeFilename(key)}.json`), JSON.stringify(manifest, null, 2));
  }

  const registryDir = join(outDir, "registry");
  await fs.mkdir(join(registryDir, "prompts"), { recursive: true });
  await fs.mkdir(join(registryDir, "schemas"), { recursive: true });
  for (const [key, entry] of Object.entries(bundle.registry.prompts)) {
    await fs.writeFile(join(registryDir, "prompts", `${sanitizeFilename(key)}.json`), JSON.stringify(entry, null, 2));
  }
  for (const [key, entry] of Object.entries(bundle.registry.schemas)) {
    await fs.writeFile(join(registryDir, "schemas", `${sanitizeFilename(key)}.json`), JSON.stringify(entry, null, 2));
  }
}

/** Exported so `load.ts` can compute the exact on-disk filename a given `${id}@${version}` key was written under (architecture §0.3's layout) without re-deriving keys from directory-listing filenames, which — for a key containing a sanitized character — would not be losslessly reversible. Same function on both sides of the write/read seam, not two independently-maintained copies. */
export function sanitizeFilename(key: string): string {
  return key.replace(/[/\\:*?"<>|]/g, "_");
}
