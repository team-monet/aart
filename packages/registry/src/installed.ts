import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BlockImplementation, PackManifest } from "@aart/types";
import { BlockManifestSchema } from "@aart/types";
import { buildPackManifest, parsePackManifestYaml } from "./manifest.js";
import type { InstalledPackageFiles } from "./package-manager.js";

const require = createRequire(import.meta.url);
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

export type PackProvenance =
  | { readonly kind: "npm"; readonly source: string; readonly npmPackageName: string }
  | { readonly kind: "linked"; readonly source: string }
  | { readonly kind: "workspace"; readonly source: string };

export interface InstalledPackState {
  readonly name: string;
  readonly version: string;
  readonly contentHash: string;
  readonly approvalStatus: "unapproved" | "approved";
  readonly installedAt: string;
  readonly approvedAt?: string;
  readonly reviewer?: string;
  readonly provenance: PackProvenance;
}

export interface InstalledPack {
  readonly state: InstalledPackState;
  readonly files: Required<InstalledPackageFiles>;
}

export class InvalidPackAssetNameError extends Error {}
export class PackInstallConflictError extends Error {}
export class PackSealBrokenError extends Error {}
export class PackBlockLoadError extends Error {}

function assertSafeSegment(value: string, kind: string): void {
  if (!SAFE_SEGMENT.test(value)) {
    throw new InvalidPackAssetNameError(`${kind} "${value}" must contain only letters, numbers, dot, underscore, or hyphen`);
  }
}

function installedRoot(root: string): string {
  return join(root, "packs", "installed");
}

function packDir(root: string, name: string, version: string): string {
  assertSafeSegment(name, "pack name");
  assertSafeSegment(version, "pack version");
  return join(installedRoot(root), name, version);
}

function statePath(root: string, name: string, version: string): string {
  return join(packDir(root, name, version), "state.json");
}

function normalizeFiles(files: InstalledPackageFiles): Required<InstalledPackageFiles> {
  return {
    manifestYaml: files.manifestYaml,
    blockSources: files.blockSources,
    workflowSources: files.workflowSources ?? {},
  };
}

async function writePackFiles(dir: string, files: Required<InstalledPackageFiles>, state: InstalledPackState): Promise<void> {
  await mkdir(join(dir, "blocks"), { recursive: true });
  await mkdir(join(dir, "workflows"), { recursive: true });
  await writeFile(join(dir, "aart-pack.yaml"), files.manifestYaml, "utf8");
  for (const [id, source] of Object.entries(files.blockSources)) {
    assertSafeSegment(id, "block id");
    await writeFile(join(dir, "blocks", `${id}.cjs`), source, "utf8");
  }
  for (const [id, source] of Object.entries(files.workflowSources)) {
    assertSafeSegment(id, "workflow id");
    await writeFile(join(dir, "workflows", `${id}.yaml`), source, "utf8");
  }
  await writeFile(join(dir, "state.json"), JSON.stringify(state, null, 2), "utf8");
}

/**
 * Preserves the exact bytes pulled from a public/linked/workspace pack.
 * Installation is deliberately unapproved; approval is a separate write.
 */
export async function persistInstalledPack(
  root: string,
  filesInput: InstalledPackageFiles,
  provenance: PackProvenance,
  now: Date = new Date(),
): Promise<{ manifest: PackManifest; state: InstalledPackState }> {
  const files = normalizeFiles(filesInput);
  const raw = parsePackManifestYaml(files.manifestYaml);
  const manifest = buildPackManifest(raw, files.blockSources, files.workflowSources);
  const target = packDir(root, raw.name, raw.version);
  const existing = await readInstalledPackState(root, raw.name, raw.version);
  if (existing?.approvalStatus === "approved" && existing.contentHash !== manifest.contentHash) {
    throw new PackInstallConflictError(
      `refusing to replace approved pack ${raw.name}@${raw.version} with different content; publish a new version instead`,
    );
  }
  const state: InstalledPackState = {
    name: raw.name,
    version: raw.version,
    contentHash: manifest.contentHash,
    approvalStatus: "unapproved",
    installedAt: now.toISOString(),
    provenance,
  };
  const temp = `${target}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  await writePackFiles(temp, files, state);
  await mkdir(dirname(target), { recursive: true });
  if (existsSync(target)) await rm(target, { recursive: true, force: true });
  await rename(temp, target);
  return { manifest, state };
}

export async function readInstalledPackState(root: string, name: string, version: string): Promise<InstalledPackState | undefined> {
  try {
    return JSON.parse(await readFile(statePath(root, name, version), "utf8")) as InstalledPackState;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
}

export function readInstalledPackSync(root: string, name: string, version: string): InstalledPack {
  const dir = packDir(root, name, version);
  const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as InstalledPackState;
  const manifestYaml = readFileSync(join(dir, "aart-pack.yaml"), "utf8");
  const raw = parsePackManifestYaml(manifestYaml);
  const blockSources = Object.fromEntries(
    raw.blocks.map((id) => {
      assertSafeSegment(id, "block id");
      return [id, readFileSync(join(dir, "blocks", `${id}.cjs`), "utf8")];
    }),
  );
  const workflowSources = Object.fromEntries(
    raw.workflows.map((id) => {
      assertSafeSegment(id, "workflow id");
      return [id, readFileSync(join(dir, "workflows", `${id}.yaml`), "utf8")];
    }),
  );
  return { state, files: { manifestYaml, blockSources, workflowSources } };
}

export function listInstalledPackStatesSync(root: string): InstalledPackState[] {
  const base = installedRoot(root);
  if (!existsSync(base)) return [];
  const states: InstalledPackState[] = [];
  for (const name of readdirSync(base)) {
    const nameDir = join(base, name);
    for (const version of readdirSync(nameDir)) {
      const file = join(nameDir, version, "state.json");
      if (existsSync(file)) states.push(JSON.parse(readFileSync(file, "utf8")) as InstalledPackState);
    }
  }
  return states.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

export function listActiveApprovedPackStatesSync(root: string): InstalledPackState[] {
  const byName = new Map<string, InstalledPackState>();
  for (const state of listInstalledPackStatesSync(root)) {
    if (state.approvalStatus !== "approved") continue;
    const current = byName.get(state.name);
    if (!current || state.version.localeCompare(current.version, undefined, { numeric: true }) > 0) {
      byName.set(state.name, state);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function approveInstalledPack(
  root: string,
  name: string,
  version: string,
  reviewer: string,
  now: Date = new Date(),
): Promise<InstalledPack> {
  const installed = readInstalledPackSync(root, name, version);
  const raw = parsePackManifestYaml(installed.files.manifestYaml);
  const current = buildPackManifest(raw, installed.files.blockSources, installed.files.workflowSources);
  if (current.contentHash !== installed.state.contentHash) {
    throw new PackSealBrokenError(`pack ${name}@${version} changed after installation; reinstall or publish a new version before approval`);
  }
  const state: InstalledPackState = {
    ...installed.state,
    approvalStatus: "approved",
    approvedAt: now.toISOString(),
    reviewer,
  };
  await writeFile(statePath(root, name, version), JSON.stringify(state, null, 2), "utf8");
  return { ...installed, state };
}

function assertBlockImplementation(value: unknown, expectedId: string): BlockImplementation {
  const candidate =
    value && typeof value === "object" && "default" in value
      ? (value as { default: unknown }).default
      : value;
  if (!candidate || typeof candidate !== "object") {
    throw new PackBlockLoadError(`block ${expectedId} must export { manifest, execute }`);
  }
  const record = candidate as { manifest?: unknown; execute?: unknown };
  const parsed = BlockManifestSchema.safeParse(record.manifest);
  if (!parsed.success || typeof record.execute !== "function") {
    throw new PackBlockLoadError(`block ${expectedId} must export a valid BlockImplementation`);
  }
  if (parsed.data.id !== expectedId) {
    throw new PackBlockLoadError(`block file ${expectedId}.cjs exports manifest id "${parsed.data.id}"`);
  }
  return { manifest: parsed.data, execute: record.execute as BlockImplementation["execute"] };
}

export function loadBlockImplementationFileSync(file: string, expectedId: string): BlockImplementation {
  const resolved = require.resolve(file);
  delete require.cache[resolved];
  return assertBlockImplementation(require(resolved), expectedId);
}

/** Loads only approved, still-sealed CJS blocks. Unapproved code is never evaluated. */
export function loadApprovedPackBlocksSync(root: string): Array<{ implementation: BlockImplementation; packName: string }> {
  const loaded: Array<{ implementation: BlockImplementation; packName: string }> = [];
  for (const state of listActiveApprovedPackStatesSync(root)) {
    const installed = readInstalledPackSync(root, state.name, state.version);
    const raw = parsePackManifestYaml(installed.files.manifestYaml);
    const current = buildPackManifest(raw, installed.files.blockSources, installed.files.workflowSources);
    if (current.contentHash !== state.contentHash) {
      throw new PackSealBrokenError(`approved pack ${state.name}@${state.version} failed its content seal`);
    }
    for (const id of raw.blocks) {
      const file = join(packDir(root, state.name, state.version), "blocks", `${id}.cjs`);
      loaded.push({ implementation: loadBlockImplementationFileSync(file, id), packName: state.name });
    }
  }
  return loaded;
}

/** Evaluates one installed pack's block modules for approval-time shape validation. */
export function loadInstalledPackBlocksSync(root: string, name: string, version: string): BlockImplementation[] {
  const installed = readInstalledPackSync(root, name, version);
  const raw = parsePackManifestYaml(installed.files.manifestYaml);
  const current = buildPackManifest(raw, installed.files.blockSources, installed.files.workflowSources);
  if (current.contentHash !== installed.state.contentHash) {
    throw new PackSealBrokenError(`pack ${name}@${version} failed its content seal`);
  }
  return raw.blocks.map((id) => {
    const file = join(packDir(root, name, version), "blocks", `${id}.cjs`);
    return loadBlockImplementationFileSync(file, id);
  });
}
