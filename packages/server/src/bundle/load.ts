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
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import {
  AART_VERSION,
  approveInstalledPack,
  assertPackCompatibility,
  buildPackManifest,
  parsePackManifestYaml,
  persistInstalledPack,
  withPackMutationLock,
} from "@aart/registry";
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
import { normalizeEnvironmentTrustMode } from "@aart/governance";
import { systemClock, type Clock } from "../clock.js";
import {
  BundledPackAssetsSchema,
  BundleManifestSchema,
  computeBundleHash,
  sanitizeFilename,
  type Bundle,
  type BundledPackAssets,
} from "./bundle.js";

const TriggerConfigSchema = z.record(z.string(), z.unknown());

/**
 * Every hydration-created `Deployment` for a bundle with NO
 * `manifest.targetEnvironment` (every bundle produced before D1 "remotes +
 * push", AMENDMENTS.md A56, plus any produced today without `--environment`)
 * lands under this one synthetic `Environment` — the pre-D1, and still
 * fully-supported, fallback. This one stable, deterministic id is created
 * (idempotently — `put` is an upsert) the first time any such bundle is
 * hydrated into a store, and reused by every later hydration into that same
 * store, rather than minting a fresh orphaned `Environment` row each time.
 *
 * A bundle whose manifest DOES carry `targetEnvironment` (bundle.ts's own
 * doc comment on that field) never touches this constant at all —
 * `resolveHydrationTarget` below resolves it against a REAL, already-
 * registered `Environment` instead, and `hydrateBundle` never auto-vivifies
 * one (unlike this synthetic fallback, which is deliberately auto-created —
 * see that function's own doc comment for why the two cases differ).
 *
 * Exported (not module-private) so `plan.ts`'s dry-run preview — same
 * directory, D1 "remotes + push" — can compute a plan against the exact
 * SAME fallback environment a real `hydrateBundle` call would use for an
 * envelope with no `targetEnvironment`, rather than a second, potentially-
 * drifting definition of "what does the legacy fallback look like."
 */
export const BUNDLE_ENVIRONMENT: Environment = { id: "env_bundle", name: "bundle", config: {} };

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
 *
 * Legacy/fallback form — the synthetic `env_bundle` environment only (no
 * environment suffix). See `bundleDeploymentIdForEnvironment` below for the
 * D1 env-scoped form used whenever a bundle names a real
 * `targetEnvironment`; the two are deliberately DIFFERENT key shapes so a
 * bundle hydrated once under the legacy fallback and later re-hydrated with
 * a real named environment lands as an independent new row rather than
 * colliding with (or being mistaken for a redeploy of) the fallback one.
 */
function bundleDeploymentId(workflowId: string, workflowVersion: string): string {
  return `bundle:${workflowId}@${workflowVersion}`;
}

/**
 * D1 "remotes + push" (AMENDMENTS.md A56) — env-scoped form, keyed by the
 * REAL target environment's resolved id (never its name — ids are stable
 * under a rename, names aren't). The SAME workflow@version hydrated into
 * two DIFFERENT real environments is, by this key shape, always two
 * independent rows — never a conflict, matching the design memo's explicit
 * "this is by design" framing (each environment's own `Deployment` most
 * recently promoted into it typically carries a different `triggerConfig`,
 * hence a different `bundleHash`, but even a coincidental match is fine:
 * they're different rows regardless, keyed by environment).
 */
function bundleDeploymentIdForEnvironment(workflowId: string, workflowVersion: string, environmentId: string): string {
  return `bundle:${workflowId}@${workflowVersion}:${environmentId}`;
}

export interface HydrationTarget {
  /** The REAL, already-registered Environment this bundle names — never auto-vivified (see `resolveHydrationTarget`'s own doc comment). */
  environment: Environment;
  /** `true` iff this environment's own trust mode is `"dev"` — dev has no required gates (governance's `REQUIRED_GATES_BY_MODE.dev`, an empty array) and is meant for throwaway iteration, so a bundle ingested straight into one is immediately live, matching a human just running `aart deploy` there directly. Any OTHER trust mode leaves the resulting `Deployment.promoted` explicitly `false` — hydration recorded the evidence (defs are now in the store) but a separate promotion step (`aart promote`/`POST /workflows/:id/promote`) is still what flips a real trigger live. */
  promoted: boolean;
}

/**
 * Resolves `bundle.manifest.targetEnvironment` (if present) to the REAL
 * `Environment` it names — `undefined` when the manifest carries no such
 * field at all (the legacy/fallback case; `hydrateBundle` falls back to
 * `BUNDLE_ENVIRONMENT` in that case, exactly as it always has).
 *
 * Deliberately fail-loud, NOT auto-vivifying, when a NAME is given but
 * doesn't resolve — matching `real-server-port.ts`'s `resolveDeployment`/
 * `resolveEnvironmentId` established discipline for the identical class of
 * mistake (an operator typo, or a bundle produced against a different
 * store's environment set than the one it's being hydrated into) elsewhere
 * in this codebase: a missing environment should fail the whole hydration
 * loudly, with an actionable remedy, never silently create a placeholder a
 * human never asked for and might not notice.
 *
 * Exported so `plan.ts`'s dry-run preview (same directory, D1 "remotes +
 * push") resolves a bundle's target through the IDENTICAL logic
 * `hydrateBundle` itself uses — a plan that resolved differently from what
 * a real ingest would do defeats the entire point of a preview.
 */
export async function resolveHydrationTarget(store: AartStore, targetEnvironmentName: string | undefined): Promise<HydrationTarget | undefined> {
  if (!targetEnvironmentName) return undefined;
  const environment = await store.environments.getByName(targetEnvironmentName);
  if (!environment) {
    throw new Error(
      `Bundle load: target environment "${targetEnvironmentName}" is not registered on this store. ` +
        `Register it first — "aart environment register ${targetEnvironmentName} --trust-mode <dev|governed|strict|production>" (CLI), ` +
        `or POST /environments (HTTP) — then retry.`,
    );
  }
  const trustMode = normalizeEnvironmentTrustMode(environment.config["trustMode"]);
  return { environment, promoted: trustMode === "dev" };
}

/**
 * D1 "remotes + push" (AMENDMENTS.md A56) — the one abstraction
 * `readBundleFromDisk` (a real directory on disk) and `readBundleFromEnvelope`
 * (an in-memory `{files: Record<relPath, string>}` map — `POST
 * /bundles/ingest`'s own envelope shape, exactly `bundleToBundleLike`'s
 * `{manifest, files}` — `@aart/cli`'s `real-server-port.ts`) both implement,
 * so `readBundleFromSource` below runs the IDENTICAL parsing / hash-
 * verification / schema-validation pipeline over either — same failure
 * modes, same error message shapes, one implementation maintained once, not
 * two independently-drifting copies. `relPath` is always the bundle-
 * relative, forward-slash path `writeBundleToDisk`/`bundleToBundleLike` both
 * use (e.g. `"manifest.json"`, `"definitions/wf@1.json"`,
 * `"registry/prompts/p@1.json"`) — never an absolute filesystem path, so
 * both implementations key off exactly the same strings.
 */
interface BundleSource {
  /** Reads and JSON.parses the file at bundle-relative `relPath`. Throws `Bundle load: cannot read ${label} (...): ...` on a missing/unreadable entry, or `Bundle load: ${label} (...) is not valid JSON: ...` on unparseable content — the same two failure shapes regardless of which source implementation is doing the reading. */
  readJson(relPath: string, label: string): Promise<unknown>;
  /** How this source describes itself in an error message that names the WHOLE bundle, not one file within it (e.g. the bundleHash-mismatch / schemaVersion messages below) — a directory path for disk, a fixed label for an envelope (which has no path of its own). */
  describe(): string;
}

function diskSource(bundleDir: string): BundleSource {
  return {
    async readJson(relPath, label) {
      const filePath = join(bundleDir, ...relPath.split("/"));
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
    },
    describe: () => bundleDir,
  };
}

/** `files` is exactly `bundleToBundleLike`'s (`@aart/cli`'s `real-server-port.ts`) / the `POST /bundles/ingest` envelope's `files: Record<relPath, string>` map — every value is the file's raw text content (not pre-parsed), matching `writeBundleFilesToDisk`'s (`packages/cli/src/bundle-files.ts`) own documented shape one layer up. */
function envelopeSource(files: Readonly<Record<string, string>>): BundleSource {
  return {
    async readJson(relPath, label) {
      const raw = files[relPath];
      if (raw === undefined) {
        throw new Error(`Bundle load: cannot read ${label} (${relPath}): missing from the bundle envelope.`);
      }
      try {
        return JSON.parse(raw);
      } catch (err) {
        throw new Error(`Bundle load: ${label} (${relPath}) is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    describe: () => "<bundle envelope>",
  };
}

interface RawEntry {
  key: string;
  filePath: string;
  raw: unknown;
}

/** Reads one raw (not yet Zod-validated) JSON file per `key`, at the exact bundle-relative path `writeBundleToDisk`/`bundleToBundleLike` would have written/keyed it under (same `sanitizeFilename`, bundle.ts). Fails fast (throws immediately) on a missing entry or invalid JSON — unlike the schema-validation pass below, there's no useful "aggregate every missing file" story: a bundle that doesn't match its own manifest is a structural problem, not a per-definition content problem. */
async function readRawEntries(source: BundleSource, subpath: string, keys: readonly string[], label: string): Promise<RawEntry[]> {
  const out: RawEntry[] = [];
  for (const key of keys) {
    const relPath = `${subpath}/${sanitizeFilename(key)}.json`;
    out.push({ key, filePath: relPath, raw: await source.readJson(relPath, label) });
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
 * Reads a bundle (architecture §0.3's layout) from `source` into an
 * in-memory `Bundle`, as strict as `produceBundle`'s own output: verifies
 * `bundleHash` (see this module's header for why that runs first) then
 * validates every workflow/pack/prompt/schema definition against the REAL
 * `@aart/types` Zod schemas, aggregating every failure into one error
 * rather than stopping at the first — a bundle with several bad files
 * should report all of them in one pass. Throws — never returns a
 * partially-valid `Bundle` — on any of: a missing/unreadable entry, invalid
 * JSON, a manifest/definition that fails its Zod schema, a definition's own
 * identity (id/version, or name/version/contentHash for packs/prompts/
 * schemas) not matching its manifest entry, or a bundleHash mismatch.
 *
 * D1 "remotes + push" (AMENDMENTS.md A56) — the shared core both
 * `readBundleFromDisk` and `readBundleFromEnvelope` below call; see
 * `BundleSource`'s own doc comment for why this exists as one function over
 * an abstraction rather than two independently-maintained copies.
 */
async function readBundleFromSource(source: BundleSource): Promise<Bundle> {
  const manifestRaw = await source.readJson("manifest.json", "manifest.json");
  const manifestParsed = BundleManifestSchema.safeParse(manifestRaw);
  if (!manifestParsed.success) {
    throw new Error(`Bundle load: manifest.json (${source.describe()}) failed schema validation:\n${manifestParsed.error.message}`);
  }
  const manifest = manifestParsed.data;
  if (manifest.schemaVersion !== 1) {
    throw new Error(`Bundle load: manifest.json (${source.describe()}) declares schemaVersion ${manifest.schemaVersion as number} — this build only understands schemaVersion 1. Refusing to load.`);
  }

  const triggersRaw = await source.readJson("triggers.json", "triggers.json");
  const triggersParsed = TriggerConfigSchema.safeParse(triggersRaw);
  if (!triggersParsed.success) {
    throw new Error(`Bundle load: triggers.json (${source.describe()}) must be a JSON object (produceBundle always writes one, even when empty: "{}"). ${triggersParsed.error.message}`);
  }
  const triggers = triggersParsed.data;

  const rawWorkflows = await readRawEntries(
    source,
    "definitions",
    manifest.workflows.map((w) => `${w.workflowId}@${w.version}`),
    "workflow definition",
  );
  const rawPacks = await readRawEntries(
    source,
    "packs",
    manifest.packs.map((p) => `${p.name}@${p.version}`),
    "pack manifest",
  );
  const packEntriesWithAssets = manifest.packs.filter((pack) => pack.assets === true);
  const rawPackAssets = await readRawEntries(
    source,
    "pack-assets",
    packEntriesWithAssets.map((p) => `${p.name}@${p.version}`),
    "pack executable assets",
  );
  const rawPrompts = await readRawEntries(
    source,
    "registry/prompts",
    manifest.prompts.map((p) => `${p.name}@${p.version}`),
    "prompt registry entry",
  );
  const rawSchemas = await readRawEntries(
    source,
    "registry/schemas",
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
    ...(rawPackAssets.length > 0 ? { packAssets: Object.fromEntries(rawPackAssets.map((e) => [e.key, e.raw])) } : {}),
    registry: {
      prompts: Object.fromEntries(rawPrompts.map((e) => [e.key, e.raw])),
      schemas: Object.fromEntries(rawSchemas.map((e) => [e.key, e.raw])),
    },
    triggers,
  });
  if (recomputedHash !== bundleHash) {
    throw new Error(
      `Bundle load: bundleHash mismatch for "${manifest.workflowId}@${manifest.workflowVersion}" (${source.describe()}) — ` +
        `manifest.json claims ${bundleHash}, recomputed ${recomputedHash} from the bundle's actual contents. ` +
        `This bundle has been modified or corrupted since it was produced — refusing to load it.`,
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
  const packAssets: Record<string, BundledPackAssets> = {};
  for (const entry of rawPackAssets) {
    const parsed = BundledPackAssetsSchema.safeParse(entry.raw);
    if (!parsed.success) {
      errors.push(`${entry.filePath}: failed Pack asset schema validation:\n${parsed.error.message}`);
      continue;
    }
    try {
      const recomputed = buildPackManifest(
        parsePackManifestYaml(parsed.data.manifestYaml),
        parsed.data.blockSources,
        parsed.data.workflowSources,
      );
      const expected = manifest.packs.find((pack) => `${pack.name}@${pack.version}` === entry.key);
      if (!expected || `${recomputed.name}@${recomputed.version}` !== entry.key || recomputed.contentHash !== expected.contentHash) {
        errors.push(`${entry.filePath}: executable assets do not match the manifest seal for "${entry.key}".`);
        continue;
      }
      packAssets[entry.key] = parsed.data;
    } catch (cause) {
      errors.push(`${entry.filePath}: executable assets failed Pack validation: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
  const prompts = validateRegistryEntries<PromptRegistryEntry>(rawPrompts, manifest.prompts, PromptRegistryEntrySchema, errors);
  const schemas = validateRegistryEntries<SchemaRegistryEntry>(rawSchemas, manifest.schemas, SchemaRegistryEntrySchema, errors);

  if (errors.length > 0) {
    throw new Error(`Bundle load: ${errors.length} definition(s) in ${source.describe()} failed validation:\n${errors.join("\n")}`);
  }

  return {
    manifest,
    definitions,
    packs,
    ...(Object.keys(packAssets).length > 0 ? { packAssets } : {}),
    registry: { prompts, schemas },
    triggers,
  };
}

/** Reads a bundle directory (architecture §0.3's layout) off disk into an in-memory `Bundle` — see `readBundleFromSource`'s own doc comment for the full validation contract this delegates to. */
export async function readBundleFromDisk(bundleDir: string): Promise<Bundle> {
  return readBundleFromSource(diskSource(bundleDir));
}

/**
 * D1 "remotes + push" (AMENDMENTS.md A56) — reads a bundle from an in-memory
 * envelope (`POST /bundles/ingest`/`POST /bundles/plan`'s own request body
 * shape: `{ files: Record<relPath, string> }`, exactly what
 * `bundleToBundleLike` (`@aart/cli`'s `real-server-port.ts`) already builds
 * client-side — see D-1 of the design memo) into an in-memory `Bundle`.
 * Mirrors EVERY `readBundleFromDisk` failure mode with the identical error
 * shape (missing file, invalid JSON, hash mismatch, schema failure) — see
 * `readBundleFromSource`'s own doc comment for why this is the same
 * function under the hood, not a re-derived parallel implementation.
 */
export async function readBundleFromEnvelope(files: Readonly<Record<string, string>>): Promise<Bundle> {
  return readBundleFromSource(envelopeSource(files));
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
  const expectedAssetKeys = new Set(
    bundle.manifest.packs
      .filter((pack) => pack.assets === true)
      .map((pack) => `${pack.name}@${pack.version}`),
  );
  const actualAssetKeys = Object.keys(bundle.packAssets ?? {});
  for (const key of expectedAssetKeys) {
    if (!bundle.packAssets?.[key]) {
      throw new Error(`Bundle load: manifest declares executable Pack assets for "${key}", but the sealed assets are missing.`);
    }
  }
  for (const key of actualAssetKeys) {
    if (!expectedAssetKeys.has(key)) {
      throw new Error(`Bundle load: executable Pack assets "${key}" are not declared by manifest.json.`);
    }
  }
  const { createdAt: _createdAt, bundleHash, ...hashableManifest } = bundle.manifest;
  const recomputed = computeBundleHash({
    manifest: hashableManifest,
    definitions: bundle.definitions,
    packs: bundle.packs,
    ...(bundle.packAssets ? { packAssets: bundle.packAssets } : {}),
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
 * **plus the resolved target environment, when one is named** (D1 "remotes +
 * push", AMENDMENTS.md A56 — `resolveHydrationTarget` above; not every
 * nested workflow the closure carries): hydrating the exact same bundle
 * (same bundleHash) twice into the same store+environment is a safe no-op
 * the second time (`kind: "already_hydrated"`), matching a redeploy of an
 * unchanged artifact. Hydrating a DIFFERENT bundle for the SAME
 * workflow@version+environment throws rather than silently overwriting —
 * two different sealed artifacts claiming the same identity is a real
 * conflict for a human to resolve (redeploy under a fresh `--root` store, or
 * confirm which one is actually meant to win), not something safe to paper
 * over. The SAME workflow@version hydrated into a DIFFERENT environment is,
 * by design, always an independent new row — see
 * `bundleDeploymentIdForEnvironment`'s own doc comment.
 *
 * Governance is deliberately NOT re-run here: a bundle is produced from an
 * already-approved+deployed store state (bundle.ts's own header comment),
 * so every hydrated `Workflow`'s `approval`/`gates`/`needsReview`/
 * `promotionBlocked` fields land exactly as bundled, verbatim — sealing the
 * bundle IS the governance decision; loading it is not a second one.
 *
 * All writes (workflows, packs, prompts, schemas, the environment marker —
 * only for the legacy fallback, never for a real named target — + deployment
 * marker) land inside one `store.transact()` call — either the whole
 * hydration commits or none of it does, so a mid-hydration failure (disk
 * full, process killed) can never leave the idempotency marker written
 * without the definitions it's supposed to vouch for, or vice versa.
 */
export async function hydrateBundle(store: AartStore, bundle: Bundle, clock: Clock = systemClock, packRoot?: string): Promise<HydrateBundleResult> {
  verifyBundleHash(bundle);

  const { workflowId, workflowVersion, bundleHash, targetEnvironment: targetEnvironmentName } = bundle.manifest;
  // Resolved BEFORE anything else — fail loud on an unregistered named
  // target before touching the store at all (resolveHydrationTarget's own
  // doc comment on why this never auto-vivifies, unlike the legacy
  // BUNDLE_ENVIRONMENT fallback below).
  const target = await resolveHydrationTarget(store, targetEnvironmentName);
  const deploymentId = target ? bundleDeploymentIdForEnvironment(workflowId, workflowVersion, target.environment.id) : bundleDeploymentId(workflowId, workflowVersion);
  const existing = await store.deployments.get(deploymentId);

  if (existing?.bundleHash !== undefined) {
    if (existing.bundleHash === bundleHash) {
      if (bundle.packAssets) await hydrateBundledPackAssets(bundle, packRoot, clock, async () => undefined);
      return { kind: "already_hydrated", workflowId, workflowVersion, bundleHash, deploymentId };
    }
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
    environmentId: target ? target.environment.id : BUNDLE_ENVIRONMENT.id,
    triggerConfig,
    bundleHash,
    createdAt: clock.nowIso(),
    // Legacy fallback path: `promoted` is left OFF the object entirely
    // (undefined = active, today's implicit behavior, byte-identical to
    // every pre-D1 hydration — see Deployment.promoted's own doc comment,
    // store-records.ts). Real-target path: always explicitly stamped, per
    // `resolveHydrationTarget`'s dev-trust-mode rule.
    ...(target ? { promoted: target.promoted } : {}),
  };

  const persistStoreRecords = async (): Promise<void> => {
    await store.transact(async (tx) => {
      for (const workflow of Object.values(bundle.definitions)) await tx.workflows.put(workflow);
      for (const pack of Object.values(bundle.packs)) await tx.packManifests.put(pack);
      for (const prompt of Object.values(bundle.registry.prompts)) await tx.promptRegistry.put(prompt);
      for (const schema of Object.values(bundle.registry.schemas)) await tx.schemaRegistry.put(schema);
      // Only the legacy fallback auto-vivifies its own Environment row — a
      // real named target was already proven to exist by
      // resolveHydrationTarget above, and must never be silently re-written
      // here (no auto-vivification for the real path, by design).
      if (!target) {
        await tx.environments.put(BUNDLE_ENVIRONMENT);
      }
      await tx.deployments.put(deployment);
    });
  };

  if (bundle.packAssets) {
    await hydrateBundledPackAssets(bundle, packRoot, clock, persistStoreRecords);
  } else {
    await persistStoreRecords();
  }

  return { kind: "hydrated", workflowId, workflowVersion, bundleHash, deploymentId };
}

/** `readBundleFromDisk` + `hydrateBundle` in one call — what `aart server --bundle <dir>` / `aart worker --bundle <dir>` (packages/cli/src/commands/process.ts) actually call. */
export async function hydrateBundleFromDisk(
  store: AartStore,
  bundleDir: string,
  clock: Clock = systemClock,
  packRoot?: string,
): Promise<HydrateBundleResult> {
  const bundle = await readBundleFromDisk(bundleDir);
  return hydrateBundle(store, bundle, clock, packRoot);
}

async function hydrateBundledPackAssets(
  bundle: Bundle,
  packRoot: string | undefined,
  clock: Clock,
  persistStoreRecords: () => Promise<void>,
): Promise<void> {
  if (!bundle.packAssets || Object.keys(bundle.packAssets).length === 0) {
    await persistStoreRecords();
    return;
  }
  if (!packRoot) {
    throw new Error("Bundle load: this bundle contains executable Pack assets, but no Pack root was configured for hydration.");
  }
  await withPackMutationLock(packRoot, async () => {
    const token = randomUUID();
    const stagingRoot = join(packRoot, "packs", `.bundle-hydration-${token}`);
    const installedRoot = join(packRoot, "packs", "installed");
    const stagedInstalledRoot = join(stagingRoot, "packs", "installed");
    const backupInstalledRoot = join(packRoot, "packs", `.bundle-installed-backup-${token}`);
    const failedInstalledRoot = join(packRoot, "packs", `.bundle-installed-failed-${token}`);
    let previousInstallationMoved = false;
    let stagedInstallationActivated = false;
    let storeRecordsCommitted = false;
    const restorePreviousInstallation = async (): Promise<void> => {
      if (stagedInstallationActivated) {
        try {
          await fs.rename(installedRoot, failedInstalledRoot);
          stagedInstallationActivated = false;
        } catch (moveCause) {
          try {
            await fs.rm(installedRoot, { recursive: true, force: true });
            stagedInstallationActivated = false;
          } catch (removeCause) {
            throw new AggregateError(
              [moveCause, removeCause],
              "Bundle load: failed to move or remove the uncommitted Pack installation.",
            );
          }
        }
      }
      if (previousInstallationMoved) {
        await fs.rename(backupInstalledRoot, installedRoot);
        previousInstallationMoved = false;
      }
    };
    try {
      await fs.mkdir(join(stagingRoot, "packs"), { recursive: true });
      try {
        await fs.cp(installedRoot, stagedInstalledRoot, { recursive: true });
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      }

      // Build and approve the complete candidate installation away from the
      // live Pack root. Any malformed asset, seal mismatch, or approval
      // failure leaves the currently active installation byte-for-byte
      // untouched.
      for (const [key, assets] of Object.entries(bundle.packAssets!)) {
        const manifest = bundle.packs[key];
        if (!manifest) throw new Error(`Bundle load: Pack assets "${key}" have no matching Pack manifest.`);
        const installed = await persistInstalledPack(
          stagingRoot,
          assets,
          { kind: "workspace", source: `bundle:${bundle.manifest.bundleHash}` },
          new Date(clock.nowIso()),
        );
        if (installed.manifest.contentHash !== manifest.contentHash) {
          throw new Error(`Bundle load: persisted Pack assets "${key}" no longer match the bundle seal.`);
        }
        const raw = parsePackManifestYaml(assets.manifestYaml);
        assertPackCompatibility(raw.compatibility, {
          aart: AART_VERSION,
          node: process.versions.node,
        });
        await approveInstalledPack(
          stagingRoot,
          manifest.name,
          manifest.version,
          `bundle:${bundle.manifest.bundleHash}`,
          new Date(clock.nowIso()),
          manifest.contentHash,
        );
      }

      // Activate the fully validated Pack tree before exposing the
      // deployment in the store. If the store transaction fails, the
      // previous tree is restored below; a committed Deployment can
      // therefore never point at missing or stale executable assets.
      try {
        await fs.rename(installedRoot, backupInstalledRoot);
        previousInstallationMoved = true;
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      }
      try {
        await fs.rename(stagedInstalledRoot, installedRoot);
        stagedInstallationActivated = true;
      } catch (cause) {
        if (previousInstallationMoved) {
          await fs.rename(backupInstalledRoot, installedRoot);
          previousInstallationMoved = false;
        }
        throw cause;
      }
      try {
        await persistStoreRecords();
        storeRecordsCommitted = true;
      } catch (storeCause) {
        try {
          // Moving the uncommitted candidate out of the live path is the
          // critical rollback step. Cleanup is deliberately deferred until
          // after the prior tree is restored, so a deletion failure cannot
          // leave executable assets ahead of the authoritative store.
          await restorePreviousInstallation();
        } catch (rollbackCause) {
          throw new Error(
            "Bundle load: store hydration failed and the previous Pack installation could not be restored.",
            { cause: new AggregateError([storeCause, rollbackCause]) },
          );
        }
        throw storeCause;
      }
    } finally {
      if (!storeRecordsCommitted && (stagedInstallationActivated || previousInstallationMoved)) {
        await restorePreviousInstallation().catch(() => undefined);
      }
      await fs.rm(stagingRoot, { recursive: true, force: true });
      if (storeRecordsCommitted) {
        await fs.rm(backupInstalledRoot, { recursive: true, force: true }).catch(() => undefined);
      }
      if (!stagedInstallationActivated) {
        await fs.rm(failedInstalledRoot, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  });
}
