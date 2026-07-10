// produceBundle() — architecture §0.3/ADR-04: "aart bundle (packages/cli)
// produces this artifact from the store's current approved state" — the
// CLI command is S5's thin wrapper (architecture §1 note); the actual
// production LOGIC lives here, per this session's DoD ("the bundle
// production logic lives here (the CLI's thin bundle command delegates to
// you — S5's seam)"). See SEAMS.md for the exact exported signature.
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { AartStore } from "@aart/store";
import type { Deployment, PackManifest, PromptRegistryEntry, SchemaRegistryEntry, Workflow } from "@aart/types";
import { computeClosure, resolveClosureRegistryEntries } from "./closure.js";

export interface BundleManifest {
  schemaVersion: 1;
  workflowId: string;
  workflowVersion: string;
  createdAt: string;
  bundleHash: string;
  workflows: Array<{ workflowId: string; version: string }>;
  packs: Array<{ name: string; version: string; contentHash: string }>;
  prompts: Array<{ name: string; version: string; contentHash: string }>;
  schemas: Array<{ name: string; version: string; contentHash: string }>;
}

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
  const bundleHash = createHash("sha256")
    .update(canonicalJson({ manifest: hashableManifest, definitions, packs, registry: { prompts, schemas }, triggers }))
    .digest("hex");

  return {
    manifest: { ...manifestWithoutHash, bundleHash },
    definitions,
    packs,
    registry: { prompts, schemas },
    triggers,
  };
}

/** Writes a produced `Bundle` to disk in architecture §0.3's documented layout (`manifest.json`, `definitions/`, `packs/`, `registry/`, `triggers.json`) — what `docker run teammonet/aart-worker --bundle=...` / a K8s Job mounting a bundle / `aart worker --bundle=...` actually consume. */
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

function sanitizeFilename(key: string): string {
  return key.replace(/[/\\:*?"<>|]/g, "_");
}
