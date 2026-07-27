import { resolve } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import {
  approveInstalledPack,
  buildPackManifest,
  createLinkedPackageManager,
  createNpmPackageManager,
  fetchRemoteRegistryIndex,
  listInstalledPackStatesSync,
  loadInstalledPackBlocksSync,
  loadBlockImplementationSourceSync,
  npmPackageNameFor,
  parsePackManifestYaml,
  persistInstalledPack,
  readInstalledPackSync,
  registerPackFiles,
  searchRemotePacks,
} from "@aart/registry";
import { writePackApprovalDecision } from "@aart/governance";
import type { Workflow } from "@aart/types";
import type { AartContext } from "../context.js";
import type { HandlerResult } from "../response.js";
import { compileYamlWorkflow } from "../yaml-compiler.js";

export interface FindPacksInput {
  query: string;
  indexUrl?: string;
}

export interface PreparePackInput {
  sourcePath: string;
  outputPath?: string;
}

export async function preparePackHandler(_ctx: AartContext, input: PreparePackInput): Promise<HandlerResult> {
  const sourcePath = resolve(input.sourcePath);
  const manager = createLinkedPackageManager({ resolveRoot: () => sourcePath });
  const files = await manager.install("linked-pack");
  const raw = parsePackManifestYaml(files.manifestYaml);
  const packageJson = JSON.parse(await readFile(resolve(sourcePath, "package.json"), "utf8")) as {
    name?: string;
    version?: string;
  };
  const expectedNpmName = npmPackageNameFor(raw.name);
  if (packageJson.name !== expectedNpmName) {
    throw new Error(`package.json name must be "${expectedNpmName}", got "${packageJson.name ?? ""}"`);
  }
  if (packageJson.version !== raw.version) {
    throw new Error(`package.json version ${packageJson.version ?? ""} does not match manifest version ${raw.version}`);
  }
  const manifest = buildPackManifest(raw, files.blockSources, files.workflowSources);
  const blocks = raw.blocks.map((id) => ({
    manifest: loadBlockImplementationSourceSync(files.blockSources[id]!, id).manifest,
    packName: raw.name,
    examples: [],
  }));
  const workflows = raw.workflows.map((id) => {
    const source = files.workflowSources?.[id];
    if (source === undefined) throw new Error(`pack is missing workflow definition ${id}`);
    const workflow = compileYamlWorkflow(source);
    if (workflow.id !== id) throw new Error(`workflow file ${id}.yaml declares id "${workflow.id}"`);
    return importedDraft(workflow);
  });
  const derivedCategories = [
    ...raw.categories,
    ...blocks.flatMap((block) => (block.manifest.category ? [block.manifest.category] : [])),
    ...workflows.flatMap((workflow) => (workflow.category ? [workflow.category] : [])),
  ];
  const author =
    typeof raw.author === "string"
      ? { name: raw.author }
      : raw.author;
  const entry = {
    npmPackageName: expectedNpmName,
    packName: raw.name,
    version: raw.version,
    displayName: raw.displayName,
    description: raw.description,
    categories: [...new Set(derivedCategories)].sort(),
    tags: [...new Set(raw.tags)].sort(),
    capabilities: [...new Set(raw.capabilities)].sort(),
    secrets: [...new Set(raw.secrets)].sort(),
    author,
    license: raw.license,
    repository: raw.repository,
    homepage: raw.homepage,
    compatibility: raw.compatibility,
    contentHash: manifest.contentHash,
    blocks,
    workflows,
  };
  const outputPath = resolve(input.outputPath ?? resolve(sourcePath, "aart-index-entry.json"));
  await writeFile(outputPath, `${JSON.stringify(entry, null, 2)}\n`, "utf8");
  return {
    ok: true,
    pack: raw.name,
    version: raw.version,
    npmPackageName: expectedNpmName,
    contentHash: manifest.contentHash,
    outputPath,
    entry,
  };
}

function publicIndexUrl(input?: string): string {
  const indexUrl = input ?? process.env.AART_PACK_INDEX_URL;
  if (!indexUrl) {
    throw new Error("public pack search needs indexUrl or AART_PACK_INDEX_URL; no implicit hosted registry is configured");
  }
  return indexUrl;
}

export async function findPacksHandler(_ctx: AartContext, input: FindPacksInput): Promise<HandlerResult> {
  const indexUrl = publicIndexUrl(input.indexUrl);
  const index = await fetchRemoteRegistryIndex(indexUrl);
  const packs = searchRemotePacks(index, input.query).map(({ pack, score }) => ({
    name: pack.packName,
    npmPackageName: pack.npmPackageName,
    version: pack.version,
    displayName: pack.displayName,
    description: pack.description,
    contentHash: pack.contentHash,
    categories: pack.categories ?? [],
    tags: pack.tags ?? [],
    author: pack.author,
    license: pack.license,
    compatibility: pack.compatibility,
    verification: pack.verification ?? { status: "unverified" },
    stats: pack.stats,
    blocks: pack.blocks.map((entry) => entry.manifest.id),
    workflows: (pack.workflows ?? []).map((workflow) => ({ id: workflow.id, name: workflow.name })),
    score,
  }));
  return { ok: packs.length > 0, query: input.query, indexUrl, packs };
}

export interface InstallPackInput {
  name: string;
  version?: string;
  /** Local package directory for linked/offline installation. Omit for npm. */
  sourcePath?: string;
}

export async function installPackHandler(ctx: AartContext, input: InstallPackInput): Promise<HandlerResult> {
  const packageManager = input.sourcePath
    ? createLinkedPackageManager({ resolveRoot: () => resolve(input.sourcePath!) })
    : createNpmPackageManager({ installRoot: resolve(ctx.root, "packs", "npm"), version: input.version });
  const npmPackageName = npmPackageNameFor(input.name);
  const files = await packageManager.install(npmPackageName);
  const raw = parsePackManifestYaml(files.manifestYaml);
  if (raw.name !== input.name) {
    throw new Error(`installed npm package ${npmPackageName} declares pack name "${raw.name}", expected "${input.name}"`);
  }
  if (input.version && raw.version !== input.version) {
    throw new Error(`installed pack ${input.name} declares version ${raw.version}, expected ${input.version}`);
  }
  const provenance = input.sourcePath
    ? ({ kind: "linked", source: resolve(input.sourcePath) } as const)
    : ({ kind: "npm", source: `${npmPackageName}@${raw.version}`, npmPackageName } as const);
  const persisted = await persistInstalledPack(ctx.root, files, provenance, ctx.now());
  const manifest = await registerPackFiles(ctx.store, input.name, files);
  return {
    ok: true,
    pack: manifest.name,
    version: manifest.version,
    contentHash: manifest.contentHash,
    approvalStatus: manifest.approvalStatus,
    assets: { blocks: raw.blocks, workflows: raw.workflows },
    provenance: persisted.state.provenance,
  };
}

export interface ListPacksInput {
  status?: "unapproved" | "approved";
}

export async function listPacksHandler(ctx: AartContext, input: ListPacksInput): Promise<HandlerResult> {
  const packs = listInstalledPackStatesSync(ctx.root).filter((state) =>
    input.status ? state.approvalStatus === input.status : true,
  );
  return { ok: true, packs, count: packs.length };
}

export interface ApprovePackInput {
  name: string;
  version: string;
  reviewer: string;
}

function importedDraft(workflow: Workflow): Workflow {
  return {
    ...workflow,
    approval: "draft",
    gates: {
      validate: "pending",
      readiness: "pending",
      evals: "pending",
      riskReview: "pending",
      humanReview: "pending",
    },
  };
}

export async function approvePackHandler(ctx: AartContext, input: ApprovePackInput): Promise<HandlerResult> {
  const installed = readInstalledPackSync(ctx.root, input.name, input.version);
  const raw = parsePackManifestYaml(installed.files.manifestYaml);
  const current = buildPackManifest(raw, installed.files.blockSources, installed.files.workflowSources);
  const stored = await ctx.store.packManifests.get(input.name, input.version);
  if (!stored) throw new Error(`pack ${input.name}@${input.version} is not registered`);
  if (stored.contentHash !== current.contentHash || installed.state.contentHash !== current.contentHash) {
    throw new Error(`pack ${input.name}@${input.version} changed after installation; approval seal cannot be created`);
  }

  // Shape inspection executes the module only inside a zero-ambient-
  // capability V8 isolate. Approval never turns Pack code into trusted host
  // code; runtime dispatch uses a fresh isolate again for every execution.
  const blocks = loadInstalledPackBlocksSync(ctx.root, input.name, input.version);
  const workflows = raw.workflows.map((id) => {
    const source = installed.files.workflowSources[id];
    if (source === undefined) throw new Error(`pack is missing workflow definition ${id}`);
    const workflow = compileYamlWorkflow(source);
    if (workflow.id !== id) throw new Error(`workflow file ${id}.yaml declares id "${workflow.id}"`);
    return importedDraft(workflow);
  });

  for (const workflow of workflows) await ctx.store.workflows.put(workflow);
  const decidedAt = ctx.now().toISOString();
  const approved = await writePackApprovalDecision(ctx.store, {
    manifest: stored,
    decision: "approved",
    reviewer: input.reviewer,
    decidedAt,
  });
  await approveInstalledPack(ctx.root, input.name, input.version, input.reviewer, new Date(decidedAt));
  return {
    ok: true,
    pack: approved.name,
    version: approved.version,
    contentHash: approved.contentHash,
    approvalStatus: approved.approvalStatus,
    loadedOnNextProcessStart: blocks.map((block) => block.manifest.id),
    registeredDraftWorkflows: workflows.map((workflow) => ({ id: workflow.id, version: workflow.version })),
  };
}
