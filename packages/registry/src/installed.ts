import { existsSync, readFileSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { inspectCommonJsBlockSource, inspectCommonJsBlockSourceSync, runCommonJsBlockSandbox } from "@aart/engine";
import type { BlockImplementation, PackManifest } from "@aart/types";
import { compare as compareSemver } from "semver";
import { buildPackManifest, parsePackManifestYaml } from "./manifest.js";
import type { InstalledPackageFiles } from "./package-manager.js";

const SAFE_SEGMENT = /^[A-Za-z0-9._+-]+$/;

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
  readonly files: {
    readonly manifestYaml: string;
    readonly blockSources: Readonly<Record<string, string>>;
    readonly workflowSources: Readonly<Record<string, string>>;
  };
}

interface ActivePackSelection {
  readonly version: string;
  readonly contentHash: string;
}

export class InvalidPackAssetNameError extends Error {}
export class PackInstallConflictError extends Error {}
export class PackSealBrokenError extends Error {}
export class PackBlockLoadError extends Error {}

const PACK_MUTATION_LOCK_STALE_MS = 5 * 60_000;
const PACK_MUTATION_LOCK_WAIT_MS = 30_000;

export async function withPackMutationLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const lockDir = join(root, "packs", ".mutation-lock");
  const ownerFile = join(lockDir, "owner");
  const ownerToken = `${process.pid}-${randomUUID()}`;
  await mkdir(dirname(lockDir), { recursive: true });
  const deadline = Date.now() + PACK_MUTATION_LOCK_WAIT_MS;
  while (true) {
    try {
      await mkdir(lockDir);
      await writeFile(ownerFile, ownerToken, "utf8");
      break;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      try {
        const info = await stat(lockDir);
        if (Date.now() - info.mtimeMs > PACK_MUTATION_LOCK_STALE_MS) {
          const inspectedOwner = await readFile(ownerFile, "utf8").catch(() => `unknown-${info.ino}-${info.mtimeMs}`);
          const quarantine = `${lockDir}.stale-${inspectedOwner.replace(/[^A-Za-z0-9-]/g, "_").slice(0, 160)}`;
          try {
            // Every contender derives the same non-empty destination from
            // the stale owner's token. Exactly one rename can succeed;
            // later contenders cannot rename a freshly-acquired lock over
            // that occupied quarantine directory.
            await rename(lockDir, quarantine);
          } catch (renameCause) {
            const code = (renameCause as NodeJS.ErrnoException).code;
            if (code !== "ENOENT" && code !== "EEXIST" && code !== "ENOTEMPTY") throw renameCause;
          }
          continue;
        }
      } catch (statCause) {
        if ((statCause as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw statCause;
      }
      if (Date.now() >= deadline) throw new Error("timed out waiting for another Pack install or approval to finish");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  const heartbeat = setInterval(() => {
    void readFile(ownerFile, "utf8")
      .then((currentOwner) => {
        if (currentOwner !== ownerToken) return;
        const now = new Date();
        return utimes(lockDir, now, now);
      })
      .catch(() => undefined);
  }, 10_000);
  heartbeat.unref();
  try {
    return await operation();
  } finally {
    clearInterval(heartbeat);
    const currentOwner = await readFile(ownerFile, "utf8").catch(() => undefined);
    if (currentOwner === ownerToken) await rm(lockDir, { recursive: true, force: true });
  }
}

function assertSafeSegment(value: string, kind: string): void {
  if (!SAFE_SEGMENT.test(value) || value === "." || value === "..") {
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

function activeSelectionPath(root: string, name: string): string {
  assertSafeSegment(name, "pack name");
  return join(installedRoot(root), name, "active.json");
}

function normalizeFiles(files: InstalledPackageFiles): InstalledPack["files"] {
  return {
    manifestYaml: files.manifestYaml,
    blockSources: files.blockSources,
    workflowSources: files.workflowSources ?? {},
  };
}

async function writePackFiles(dir: string, files: InstalledPack["files"], state: InstalledPackState): Promise<void> {
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

async function atomicWriteFile(file: string, content: string): Promise<void> {
  const temp = join(
    dirname(file),
    `.tmp-${basename(file)}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  try {
    await writeFile(temp, content, "utf8");
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
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
  for (const nameEntry of readdirSync(base, { withFileTypes: true })) {
    if (!nameEntry.isDirectory()) continue;
    const nameDir = join(base, nameEntry.name);
    for (const versionEntry of readdirSync(nameDir, { withFileTypes: true })) {
      if (!versionEntry.isDirectory()) continue;
      const file = join(nameDir, versionEntry.name, "state.json");
      if (!existsSync(file)) continue;
      const state = JSON.parse(readFileSync(file, "utf8")) as InstalledPackState;
      if (state.name === nameEntry.name && state.version === versionEntry.name) states.push(state);
    }
  }
  return states.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

export function listActiveApprovedPackStatesSync(root: string): InstalledPackState[] {
  const byName = new Map<string, InstalledPackState[]>();
  for (const state of listInstalledPackStatesSync(root)) {
    if (state.approvalStatus !== "approved") continue;
    const versions = byName.get(state.name) ?? [];
    versions.push(state);
    byName.set(state.name, versions);
  }
  const active: InstalledPackState[] = [];
  for (const [name, versions] of byName) {
    const selectionFile = activeSelectionPath(root, name);
    if (existsSync(selectionFile)) {
      const selection = JSON.parse(readFileSync(selectionFile, "utf8")) as ActivePackSelection;
      const selected = versions.find(
        (state) => state.version === selection.version && state.contentHash === selection.contentHash,
      );
      if (selected) active.push(selected);
      // An explicit selection that no longer points at an approved state
      // means this Pack is inactive. Never revive a dormant older version.
      continue;
    }
    // Compatibility for installations created before active.json existed.
    active.push(
      versions.reduce((current, state) =>
        compareSemver(state.version, current.version) > 0 ? state : current,
      ),
    );
  }
  return active.sort((a, b) => a.name.localeCompare(b.name));
}

export async function approveInstalledPack(
  root: string,
  name: string,
  version: string,
  reviewer: string,
  now: Date = new Date(),
  expectedContentHash?: string,
): Promise<InstalledPack> {
  const installed = readInstalledPackSync(root, name, version);
  const raw = parsePackManifestYaml(installed.files.manifestYaml);
  const current = buildPackManifest(raw, installed.files.blockSources, installed.files.workflowSources);
  if (current.contentHash !== installed.state.contentHash) {
    throw new PackSealBrokenError(`pack ${name}@${version} changed after installation; reinstall or publish a new version before approval`);
  }
  if (
    expectedContentHash !== undefined &&
    (installed.state.contentHash !== expectedContentHash || current.contentHash !== expectedContentHash)
  ) {
    throw new PackSealBrokenError(
      `reviewed content hash no longer matches pack ${name}@${version}; approval was not recorded`,
    );
  }
  const state: InstalledPackState = {
    ...installed.state,
    approvalStatus: "approved",
    approvedAt: now.toISOString(),
    reviewer,
  };
  await atomicWriteFile(statePath(root, name, version), JSON.stringify(state, null, 2));
  await atomicWriteFile(
    activeSelectionPath(root, name),
    JSON.stringify({ version, contentHash: state.contentHash } satisfies ActivePackSelection, null, 2),
  );
  return { ...installed, state };
}

export function loadBlockImplementationSourceSync(source: string, expectedId: string): BlockImplementation {
  let manifest: BlockImplementation["manifest"];
  try {
    manifest = inspectCommonJsBlockSourceSync(source, expectedId);
  } catch (cause) {
    throw new PackBlockLoadError(`could not inspect public Pack block ${expectedId}: ${(cause as Error).message}`, { cause });
  }
  return {
    manifest,
    execute: async (resolvedInputs, ctx) =>
      runCommonJsBlockSandbox({
        source,
        expectedId,
        resolvedInputs,
        executionContext: { runId: ctx.runId, stepId: ctx.stepId },
      }),
  };
}

export async function loadBlockImplementationSource(source: string, expectedId: string, timeoutMs?: number): Promise<BlockImplementation> {
  let manifest: BlockImplementation["manifest"];
  try {
    manifest = await inspectCommonJsBlockSource(source, expectedId, { timeoutMs });
  } catch (cause) {
    throw new PackBlockLoadError(`could not inspect public Pack block ${expectedId}: ${(cause as Error).message}`, { cause });
  }
  return {
    manifest,
    execute: async (resolvedInputs, ctx) =>
      runCommonJsBlockSandbox({
        source,
        expectedId,
        resolvedInputs,
        executionContext: { runId: ctx.runId, stepId: ctx.stepId },
      }),
  };
}

export function loadBlockImplementationFileSync(file: string, expectedId: string): BlockImplementation {
  return loadBlockImplementationSourceSync(readFileSync(file, "utf8"), expectedId);
}

/** Loads only approved, still-sealed CJS blocks; module code stays inside a disposable isolate. */
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

/** Inspects one installed Pack's block modules in a zero-ambient-capability isolate. */
export function loadInstalledPackBlocksSync(root: string, name: string, version: string): BlockImplementation[] {
  const installed = readInstalledPackSync(root, name, version);
  const raw = parsePackManifestYaml(installed.files.manifestYaml);
  const current = buildPackManifest(raw, installed.files.blockSources, installed.files.workflowSources);
  if (current.contentHash !== installed.state.contentHash) {
    throw new PackSealBrokenError(`pack ${name}@${version} failed its content seal`);
  }
  return raw.blocks.map((id) => loadBlockImplementationSourceSync(installed.files.blockSources[id]!, id));
}

export async function loadInstalledPackBlocks(
  root: string,
  name: string,
  version: string,
  packInspectionBudgetMs = 10_000,
): Promise<BlockImplementation[]> {
  const installed = readInstalledPackSync(root, name, version);
  const raw = parsePackManifestYaml(installed.files.manifestYaml);
  const current = buildPackManifest(raw, installed.files.blockSources, installed.files.workflowSources);
  if (current.contentHash !== installed.state.contentHash) {
    throw new PackSealBrokenError(`pack ${name}@${version} failed its content seal`);
  }
  const deadline = Date.now() + packInspectionBudgetMs;
  const loaded: BlockImplementation[] = [];
  for (const id of raw.blocks) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new PackBlockLoadError(`Pack ${name}@${version} exceeded its inspection budget`);
    loaded.push(await loadBlockImplementationSource(installed.files.blockSources[id]!, id, remaining));
  }
  return loaded;
}
