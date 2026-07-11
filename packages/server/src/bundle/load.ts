// load.ts — the consuming half of the bundle system (bundle.ts, beside this
// file, is the producer). S12 "deploy story" scope (AMENDMENTS.md): a
// bundle produced on one machine (`aart bundle`) and hydrated into a store
// on another via `aart server --bundle <dir>` / `aart worker --bundle
// <dir>` (packages/cli/src/commands/process.ts).
//
// Trust model: a bundle is a SEALED, content-addressed artifact produced
// from an already-approved+deployed store state (bundle.ts's own producer
// doc comment: "aart bundle... produces this artifact from the store's
// current approved state"). Loading one is therefore NOT a second
// governance pass — `readBundleFromDisk` verifies the bundle's OWN internal
// integrity (bundleHash content-addressing, then real Zod schema shape) and
// `hydrateBundle` writes its contents into a store VERBATIM (approval/gates
// fields untouched) rather than re-validating/re-approving anything.
//
// Order matters, deliberately: hash verification runs BEFORE schema
// validation. A tampered/corrupted bundle should fail on "this isn't the
// bytes that were sealed" before we even ask "are these bytes well-formed"
// — verify the seal first, then trust the contents enough to type-check
// them. (A bundle produced by a genuinely different aart build could be
// authentic — hash-valid — and still schema-drifted; that's a real,
// distinct failure mode this ordering also surfaces correctly, with its own
// clear error rather than a confusing hash mismatch.)
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { AartStore } from "@aart/store";
import {
  DeploymentSchema,
  PackManifestSchema,
  PromptRegistryEntrySchema,
  SchemaRegistryEntrySchema,
  WorkflowSchema,
  type Deployment,
  type Environment,
  type PackManifest,
  type PromptRegistryEntry,
  type SchemaRegistryEntry,
  type Workflow,
} from "@aart/types";
import { systemClock, type Clock } from "../clock.js";
import { BundleManifestSchema, computeBundleHash, sanitizeFilename, type Bundle } from "./bundle.js";

const TriggerConfigSchema = z.record(z.string(), z.unknown());

/**
 * Every hydration-created `Deployment` lands under this one synthetic
 * `Environment`. A bundle's own manifest doesn't record which named
 * environment (if any) it was produced for — `BundleManifest` has no such
 * field, and `--environment` at PRODUCE time only selects which real
 * `Deployment`'s `triggerConfig` gets embedded into `triggers.json`
 * (bundle.ts's `resolveDeployment`-equivalent bridge lives in
 * `@aart/cli`'s `real-server-port.ts`, one layer up) — so there is no real
 * environment NAME to hydrate into here. This one stable, deterministic id
 * is created (idempotently — `put` is an upsert) the first time any bundle
 * is hydrated into a store, and reused by every later hydration into that
 * same store, rather than minting a fresh orphaned `Environment` row each
 * time.
 */
const BUNDLE_ENVIRONMENT: Environment = { id: "env_bundle", name: "bundle", config: {} };

/**
 * Deterministic — deliberately NOT `generateId()` (server/src/ids.ts's
 * random-uuid minter every OTHER `Deployment` in this codebase uses,
 * including `aart deploy`'s real ones). Two hydrations of the "same"
 * workflow@version (by design, regardless of bundleHash) must resolve to
 * the SAME row for `hydrateBundle`'s idempotent/conflict-refusal semantics
 * below to have anything to compare against — a random id would mint a new,
 * orphaned `Deployment` on every call instead of ever finding its own prior
 * hydration. The `bundle:` prefix (a colon, never used by
 * `generateId("deploy")`'s `deploy_<uuid>` shape) keeps this id visually
 * and namespace-distinct from every real deploy-time `Deployment` id — never
 * collides, and self-documents in a `GET /deployments` listing which rows
 * came from a hydrated bundle versus a real `aart deploy`.
 */
function bundleDeploymentId(workflowId: string, workflowVersion: string): string {
  return `bundle:${workflowId}@${workflowVersion}`;
}

async function readJsonFile(filePath: string, label: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    throw new Error(`Bundle load: cannot read ${label} (${filePath}): ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Bundle load: ${label} (${filePath}) is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

interface RawEntry {
  key: string;
  filePath: string;
  raw: unknown;
}

/** Reads one raw (not yet Zod-validated) JSON file per `key`, at the exact path `writeBundleToDisk` would have written it to (same `sanitizeFilename`, bundle.ts). Fails fast (throws immediately) on a missing file or invalid JSON — unlike the schema-validation pass below, there's no useful "aggregate every missing file" story: a directory that doesn't match its own manifest is a structural problem, not a per-definition content problem. */
async function readRawEntries(bundleDir: string, subpath: string, keys: readonly string[], label: string): Promise<RawEntry[]> {
  const out: RawEntry[] = [];
  for (const key of keys) {
    const filePath = join(bundleDir, subpath, `${sanitizeFilename(key)}.json`);
    out.push({ key, filePath, raw: await readJsonFile(filePath, label) });
  }
  return out;
}

/** Shared validation shape for packs/prompts/schemas (all three are `{name, version, contentHash, ...}` registry entries) — workflows are validated separately below (`{id, version}`, no `contentHash`). Pushes onto the caller's shared `errors` array (aggregating every failure across all four categories into one final error) rather than throwing per-entry. */
function validateRegistryEntries<T extends { name: string; version: string; contentHash: string }>(
  rawEntries: readonly RawEntry[],
  manifestEntries: ReadonlyArray<{ name: string; version: string; contentHash: string }>,
  schema: { safeParse: (input: unknown) => { success: true; data: T } | { success: false; error: { message: string } } },
  errors: string[],
): Record<string, T> {
  const out: Record<string, T> = {};
  for (const entry of rawEntries) {
    const parsed = schema.safeParse(entry.raw);
    if (!parsed.success) {
      errors.push(`${entry.filePath}: failed schema validation:\n${parsed.error.message}`);
      continue;
    }
    if (`${parsed.data.name}@${parsed.data.version}` !== entry.key) {
      errors.push(`${entry.filePath}: content is "${parsed.data.name}@${parsed.data.version}", but the manifest expects "${entry.key}" at this path.`);
      continue;
    }
    const manifestEntry = manifestEntries.find((m) => `${m.name}@${m.version}` === entry.key);
    if (manifestEntry && parsed.data.contentHash !== manifestEntry.contentHash) {
      errors.push(`${entry.filePath}: contentHash "${parsed.data.contentHash}" does not match the manifest's recorded contentHash "${manifestEntry.contentHash}" for "${entry.key}".`);
      continue;
    }
    out[entry.key] = parsed.data;
  }
  return out;
}

/**
 * Reads a bundle directory (architecture §0.3's layout) off disk into an
 * in-memory `Bundle`, as strict as `produceBundle`'s own output: verifies
 * `bundleHash` (see this module's header for why that runs first) then
 * validates every workflow/pack/prompt/schema definition against the REAL
 * `@aart/types` Zod schemas, aggregating every failure into one error
 * rather than stopping at the first — a bundle with several bad files
 * should report all of them in one pass. Throws — never returns a
 * partially-valid `Bundle` — on any of: a missing/unreadable file, invalid
 * JSON, a manifest/definition that fails its Zod schema, a definition's own
 * identity (id/version, or name/version/contentHash for packs/prompts/
 * schemas) not matching its manifest entry, or a bundleHash mismatch.
 */
export async function readBundleFromDisk(bundleDir: string): Promise<Bundle> {
  const manifestRaw = await readJsonFile(join(bundleDir, "manifest.json"), "manifest.json");
  const manifestParsed = BundleManifestSchema.safeParse(manifestRaw);
  if (!manifestParsed.success) {
    throw new Error(`Bundle load: manifest.json (${bundleDir}) failed schema validation:\n${manifestParsed.error.message}`);
  }
  const manifest = manifestParsed.data;
  if (manifest.schemaVersion !== 1) {
    throw new Error(`Bundle load: manifest.json (${bundleDir}) declares schemaVersion ${manifest.schemaVersion as number} — this build only understands schemaVersion 1. Refusing to load.`);
  }

  const triggersRaw = await readJsonFile(join(bundleDir, "triggers.json"), "triggers.json");
  const triggersParsed = TriggerConfigSchema.safeParse(triggersRaw);
  if (!triggersParsed.success) {
    throw new Error(`Bundle load: triggers.json (${bundleDir}) must be a JSON object (produceBundle always writes one, even when empty: "{}"). ${triggersParsed.error.message}`);
  }
  const triggers = triggersParsed.data;

  const rawWorkflows = await readRawEntries(
    bundleDir,
    "definitions",
    manifest.workflows.map((w) => `${w.workflowId}@${w.version}`),
    "workflow definition",
  );
  const rawPacks = await readRawEntries(
    bundleDir,
    "packs",
    manifest.packs.map((p) => `${p.name}@${p.version}`),
    "pack manifest",
  );
  const rawPrompts = await readRawEntries(
    bundleDir,
    join("registry", "prompts"),
    manifest.prompts.map((p) => `${p.name}@${p.version}`),
    "prompt registry entry",
  );
  const rawSchemas = await readRawEntries(
    bundleDir,
    join("registry", "schemas"),
    manifest.schemas.map((s) => `${s.name}@${s.version}`),
    "schema registry entry",
  );

  // Content-addressing FIRST (module header) — reconstruct the exact same
  // shape produceBundle hashed, over the raw (not yet Zod-validated) parsed
  // JSON, and compare against what the manifest claims.
  const { createdAt: _createdAt, bundleHash, ...hashableManifest } = manifest;
  const recomputedHash = computeBundleHash({
    manifest: hashableManifest,
    definitions: Object.fromEntries(rawWorkflows.map((e) => [e.key, e.raw])),
    packs: Object.fromEntries(rawPacks.map((e) => [e.key, e.raw])),
    registry: {
      prompts: Object.fromEntries(rawPrompts.map((e) => [e.key, e.raw])),
      schemas: Object.fromEntries(rawSchemas.map((e) => [e.key, e.raw])),
    },
    triggers,
  });
  if (recomputedHash !== bundleHash) {
    throw new Error(
      `Bundle load: bundleHash mismatch for "${manifest.workflowId}@${manifest.workflowVersion}" (${bundleDir}) — ` +
        `manifest.json claims ${bundleHash}, recomputed ${recomputedHash} from the bundle's actual on-disk contents. ` +
        `This bundle directory has been modified or corrupted since it was produced — refusing to load it.`,
    );
  }

  // NOW validate shape — the content is proven authentic, but not yet proven
  // well-formed under THIS build's schemas (e.g. a bundle produced by a
  // newer/older aart build could be authentic and still schema-drifted).
  const errors: string[] = [];

  const definitions: Record<string, Workflow> = {};
  for (const entry of rawWorkflows) {
    const parsed = WorkflowSchema.safeParse(entry.raw);
    if (!parsed.success) {
      errors.push(`${entry.filePath}: failed WorkflowSchema validation:\n${parsed.error.message}`);
      continue;
    }
    if (`${parsed.data.id}@${parsed.data.version}` !== entry.key) {
      errors.push(`${entry.filePath}: content is "${parsed.data.id}@${parsed.data.version}", but the manifest expects "${entry.key}" at this path.`);
      continue;
    }
    definitions[entry.key] = parsed.data;
  }

  const packs = validateRegistryEntries<PackManifest>(rawPacks, manifest.packs, PackManifestSchema, errors);
  const prompts = validateRegistryEntries<PromptRegistryEntry>(rawPrompts, manifest.prompts, PromptRegistryEntrySchema, errors);
  const schemas = validateRegistryEntries<SchemaRegistryEntry>(rawSchemas, manifest.schemas, SchemaRegistryEntrySchema, errors);

  if (errors.length > 0) {
    throw new Error(`Bundle load: ${errors.length} definition(s) in ${bundleDir} failed validation:\n${errors.join("\n")}`);
  }

  return { manifest, definitions, packs, registry: { prompts, schemas }, triggers };
}

/**
 * Recomputes `bundle.manifest.bundleHash` over `bundle`'s actual contents
 * and throws if it doesn't match — the same check `readBundleFromDisk`
 * performs above (before schema validation, over raw JSON), repeated here
 * as a defense-in-depth guard inside `hydrateBundle` so THAT function's own
 * "fails loudly on any mismatch" contract holds regardless of how its
 * `Bundle` argument was constructed (via `readBundleFromDisk`, directly
 * from `produceBundle` in the same process, or hand-built in a test) — a
 * caller that bypassed `readBundleFromDisk` doesn't get to bypass hash
 * verification too.
 */
export function verifyBundleHash(bundle: Bundle): void {
  const { createdAt: _createdAt, bundleHash, ...hashableManifest } = bundle.manifest;
  const recomputed = computeBundleHash({
    manifest: hashableManifest,
    definitions: bundle.definitions,
    packs: bundle.packs,
    registry: bundle.registry,
    triggers: bundle.triggers,
  });
  if (recomputed !== bundleHash) {
    throw new Error(
      `Bundle load: bundleHash mismatch for "${bundle.manifest.workflowId}@${bundle.manifest.workflowVersion}" — ` +
        `manifest claims ${bundleHash}, recomputed ${recomputed} from the bundle's actual contents. Refusing to hydrate.`,
    );
  }
}

export type HydrateBundleResult =
  | { kind: "hydrated"; workflowId: string; workflowVersion: string; bundleHash: string; deploymentId: string }
  | { kind: "already_hydrated"; workflowId: string; workflowVersion: string; bundleHash: string; deploymentId: string };

/**
 * Hydrates an already-loaded `Bundle`'s DEFINITIONS (workflows, packs,
 * prompts, schemas) plus its `triggers.json` into `store` — architecture
 * §0.3's bundle-consumption half (S12 scope, AMENDMENTS.md). A bundle SEEDS
 * a store; it never replaces one — runtime state (runs/waits/signals/
 * job_queue/artifacts/...) is untouched, and every OTHER workflow/pack/
 * prompt/schema already in `store` is left exactly as it was.
 *
 * Idempotent by design, keyed on the bundle's ROOT `workflowId@workflowVersion`
 * (`bundle.manifest.workflowId`/`.workflowVersion` — not every nested
 * workflow the closure carries): hydrating the exact same bundle (same
 * bundleHash) twice into the same store is a safe no-op the second time
 * (`kind: "already_hydrated"`), matching a redeploy of an unchanged
 * artifact. Hydrating a DIFFERENT bundle for the SAME workflow@version
 * throws rather than silently overwriting — two different sealed artifacts
 * claiming the same identity is a real conflict for a human to resolve
 * (redeploy under a fresh `--root` store, or confirm which one is actually
 * meant to win), not something safe to paper over.
 *
 * Governance is deliberately NOT re-run here: a bundle is produced from an
 * already-approved+deployed store state (bundle.ts's own header comment),
 * so every hydrated `Workflow`'s `approval`/`gates`/`needsReview`/
 * `promotionBlocked` fields land exactly as bundled, verbatim — sealing the
 * bundle IS the governance decision; loading it is not a second one.
 *
 * All writes (workflows, packs, prompts, schemas, the synthetic environment
 * + deployment marker) land inside one `store.transact()` call — either the
 * whole hydration commits or none of it does, so a mid-hydration failure
 * (disk full, process killed) can never leave the idempotency marker
 * written without the definitions it's supposed to vouch for, or vice
 * versa.
 */
export async function hydrateBundle(store: AartStore, bundle: Bundle, clock: Clock = systemClock): Promise<HydrateBundleResult> {
  verifyBundleHash(bundle);

  const { workflowId, workflowVersion, bundleHash } = bundle.manifest;
  const deploymentId = bundleDeploymentId(workflowId, workflowVersion);
  const existing = await store.deployments.get(deploymentId);

  if (existing?.bundleHash === bundleHash) {
    return { kind: "already_hydrated", workflowId, workflowVersion, bundleHash, deploymentId };
  }
  if (existing?.bundleHash !== undefined) {
    throw new Error(
      `Bundle load: "${workflowId}@${workflowVersion}" is already hydrated into this store from a DIFFERENT bundle ` +
        `(currently hydrated bundleHash: ${existing.bundleHash}; this bundle's hash: ${bundleHash}). ` +
        `Refusing to silently overwrite a different deployable artifact — use a fresh --root store, or confirm which bundle should win before retrying.`,
    );
  }

  const triggerConfig = TriggerConfigSchema.parse(bundle.triggers ?? {});
  const deployment: Deployment = {
    id: deploymentId,
    workflowId,
    workflowVersion,
    environmentId: BUNDLE_ENVIRONMENT.id,
    triggerConfig,
    bundleHash,
    createdAt: clock.nowIso(),
  };

  await store.transact(async (tx) => {
    for (const workflow of Object.values(bundle.definitions)) await tx.workflows.put(workflow);
    for (const pack of Object.values(bundle.packs)) await tx.packManifests.put(pack);
    for (const prompt of Object.values(bundle.registry.prompts)) await tx.promptRegistry.put(prompt);
    for (const schema of Object.values(bundle.registry.schemas)) await tx.schemaRegistry.put(schema);
    await tx.environments.put(BUNDLE_ENVIRONMENT);
    await tx.deployments.put(deployment);
  });

  return { kind: "hydrated", workflowId, workflowVersion, bundleHash, deploymentId };
}

/** `readBundleFromDisk` + `hydrateBundle` in one call — what `aart server --bundle <dir>` / `aart worker --bundle <dir>` (packages/cli/src/commands/process.ts) actually call. */
export async function hydrateBundleFromDisk(store: AartStore, bundleDir: string, clock: Clock = systemClock): Promise<HydrateBundleResult> {
  const bundle = await readBundleFromDisk(bundleDir);
  return hydrateBundle(store, bundle, clock);
}
