import { constants } from "node:fs";
import { resolve } from "node:path";
import { open, readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import {
  approveInstalledPack,
  assertPackCompatibility,
  buildPackManifest,
  createLinkedPackageManager,
  createNpmPackageManager,
  fetchRemoteRegistryIndex,
  listActiveApprovedPackStatesSync,
  listInstalledPackStatesSync,
  loadInstalledPackBlocks,
  loadInstalledPackBlocksSync,
  loadBlockImplementationSource,
  npmPackageNameFor,
  parsePackManifestYaml,
  persistInstalledPack,
  readInstalledPackSync,
  registerPackFiles,
  searchRemotePacks,
  withPackMutationLock,
} from "@aart/registry";
import { writePackApprovalDecision } from "@aart/governance";
import type { Workflow } from "@aart/types";
import type { AartContext } from "../context.js";
import type { HandlerResult } from "../response.js";
import { compileYamlWorkflow } from "../yaml-compiler.js";
import { AART_VERSION } from "../version.js";

export interface FindPacksInput {
  query: string;
  indexUrl?: string;
}

export interface PreparePackInput {
  sourcePath: string;
  outputPath?: string;
}

interface PreparePackHandlerOptions {
  /** Trusted composition-layer authority used only by the explicit CLI `--out` flag. */
  allowArbitraryOutputPath?: boolean;
  /** Test/composition override; production preparation shares a ten-second Pack-wide isolate budget. */
  inspectionBudgetMs?: number;
}

export async function preparePackHandler(
  _ctx: AartContext,
  input: PreparePackInput,
  options: PreparePackHandlerOptions = {},
): Promise<HandlerResult> {
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
  const inspectionDeadline = Date.now() + (options.inspectionBudgetMs ?? 10_000);
  const blocks = [];
  for (const id of raw.blocks) {
    const remaining = inspectionDeadline - Date.now();
    if (remaining <= 0) throw new Error(`Pack ${raw.name}@${raw.version} exceeded its preparation inspection budget`);
    const implementation = await loadBlockImplementationSource(files.blockSources[id]!, id, remaining);
    blocks.push({ manifest: implementation.manifest, packName: raw.name, examples: [] });
  }
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
    capabilities: [...new Set([...raw.capabilities, ...raw.tools.flatMap((tool) => tool.capabilities)])].sort(),
    secrets: [
      ...new Set([
        ...raw.secrets,
        ...raw.tools.flatMap((tool) =>
          tool.authentication.mode === "aart_secrets"
            ? tool.authentication.secrets.map((secret) => secret.ref)
            : [],
        ),
      ]),
    ].sort(),
    author,
    license: raw.license,
    repository: raw.repository,
    homepage: raw.homepage,
    compatibility: raw.compatibility,
    contentHash: manifest.contentHash,
    blocks,
    workflows,
    tools: raw.tools,
  };
  if (input.outputPath !== undefined && !options.allowArbitraryOutputPath) {
    throw new Error("custom Pack preparation output paths are CLI-only; MCP writes aart-index-entry.json inside the Pack directory");
  }
  const outputPath = resolve(input.outputPath ?? resolve(sourcePath, "aart-index-entry.json"));
  const handle = await open(
    outputPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    0o644,
  );
  try {
    await handle.writeFile(`${JSON.stringify(entry, null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }
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
  const packs = searchRemotePacks(index.packs, input.query).map(({ pack, score }) => ({
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
    tools: (pack.tools ?? []).map((tool) => ({
      id: tool.id,
      name: tool.name,
      version: tool.version,
      description: tool.description,
      command: tool.command,
      prerequisites: tool.prerequisites,
      capabilities: tool.capabilities,
      effects: tool.effects,
      cwd: tool.cwd,
      authentication: tool.authentication,
      output: tool.output,
    })),
    installable: index.mode === "production",
    score,
  }));
  return {
    ok: true,
    matched: packs.length > 0,
    query: input.query,
    indexUrl,
    indexMode: index.mode,
    packs,
  };
}

export interface InstallPackInput {
  name: string;
  version?: string;
  /** Local package directory for linked/offline installation. Omit for npm. */
  sourcePath?: string;
}

export async function installPackHandler(ctx: AartContext, input: InstallPackInput): Promise<HandlerResult> {
  return withPackMutationLock(ctx.root, () => installPackUnlocked(ctx, input));
}

async function installPackUnlocked(ctx: AartContext, input: InstallPackInput): Promise<HandlerResult> {
  const packageManager = input.sourcePath
    ? createLinkedPackageManager({ resolveRoot: () => resolve(input.sourcePath!) })
    : createNpmPackageManager({ installRoot: resolve(ctx.root, "packs", "npm"), version: input.version });
  const npmPackageName = npmPackageNameFor(input.name);
  const files = await packageManager.install(npmPackageName);
  const raw = parsePackManifestYaml(files.manifestYaml);
  if (files.packageJson?.name !== npmPackageName) {
    throw new Error(
      `installed package.json name must be "${npmPackageName}", got "${files.packageJson?.name ?? ""}"`,
    );
  }
  if (files.packageJson.version !== raw.version) {
    throw new Error(
      `installed package.json version ${files.packageJson.version ?? ""} does not match manifest version ${raw.version}`,
    );
  }
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
    assets: {
      blocks: raw.blocks,
      workflows: raw.workflows,
      ...(raw.tools.length > 0 ? { tools: raw.tools.map((tool) => tool.id) } : {}),
    },
    ...(raw.tools.length > 0 ? { toolDetails: raw.tools } : {}),
    provenance: persisted.state.provenance,
  };
}

export interface ListPacksInput {
  status?: "unapproved" | "approved";
}

export async function listPacksHandler(ctx: AartContext, input: ListPacksInput): Promise<HandlerResult> {
  const active = new Set(
    listActiveApprovedPackStatesSync(ctx.root).map((state) => `${state.name}@${state.version}:${state.contentHash}`),
  );
  const packs = listInstalledPackStatesSync(ctx.root)
    .filter((state) => (input.status ? state.approvalStatus === input.status : true))
    .map((state) => {
      try {
        const installed = readInstalledPackSync(ctx.root, state.name, state.version);
        const raw = parsePackManifestYaml(installed.files.manifestYaml);
        const current = buildPackManifest(raw, installed.files.blockSources, installed.files.workflowSources);
        return {
          ...state,
          active: active.has(`${state.name}@${state.version}:${state.contentHash}`),
          sealStatus: current.contentHash === state.contentHash ? "verified" : "broken",
          displayName: raw.displayName,
          description: raw.description,
          capabilities: [...new Set([...raw.capabilities, ...raw.tools.flatMap((tool) => tool.capabilities)])].sort(),
          secrets: [
            ...new Set([
              ...raw.secrets,
              ...raw.tools.flatMap((tool) =>
                tool.authentication.mode === "aart_secrets"
                  ? tool.authentication.secrets.map((secret) => secret.ref)
                  : [],
              ),
            ]),
          ].sort(),
          ...(raw.tools.length > 0 ? { toolDetails: raw.tools } : {}),
          assets: {
            blocks: raw.blocks,
            workflows: raw.workflows,
            ...(raw.tools.length > 0 ? { tools: raw.tools.map((tool) => tool.id) } : {}),
          },
        };
      } catch {
        return {
          ...state,
          active: active.has(`${state.name}@${state.version}:${state.contentHash}`),
          sealStatus: "broken",
          reviewUnavailable: true,
        };
      }
    });
  return { ok: true, packs, count: packs.length };
}

export interface ApprovePackInput {
  name: string;
  version: string;
  contentHash: string;
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
  return withPackMutationLock(ctx.root, () => approvePackUnlocked(ctx, input));
}

async function approvePackUnlocked(ctx: AartContext, input: ApprovePackInput): Promise<HandlerResult> {
  const installed = readInstalledPackSync(ctx.root, input.name, input.version);
  const raw = parsePackManifestYaml(installed.files.manifestYaml);
  const current = buildPackManifest(raw, installed.files.blockSources, installed.files.workflowSources);
  const stored = await ctx.store.packManifests.get(input.name, input.version);
  if (!stored) throw new Error(`pack ${input.name}@${input.version} is not registered`);
  if (stored.contentHash !== current.contentHash || installed.state.contentHash !== current.contentHash) {
    throw new Error(`pack ${input.name}@${input.version} changed after installation; approval seal cannot be created`);
  }
  if (input.contentHash !== current.contentHash) {
    throw new Error(
      `reviewed content hash does not match installed pack ${input.name}@${input.version}; list the Pack again and review the current seal`,
    );
  }
  assertPackCompatibility(raw.compatibility, {
    aart: AART_VERSION,
    node: process.versions.node,
  });

  // Shape inspection executes the module only inside a zero-ambient-
  // capability V8 isolate. Approval never turns Pack code into trusted host
  // code; runtime dispatch uses a fresh isolate again for every execution.
  const blocks = await loadInstalledPackBlocks(ctx.root, input.name, input.version);
  const workflows = raw.workflows.map((id) => {
    const source = installed.files.workflowSources[id];
    if (source === undefined) throw new Error(`pack is missing workflow definition ${id}`);
    const workflow = compileYamlWorkflow(source);
    if (workflow.id !== id) throw new Error(`workflow file ${id}.yaml declares id "${workflow.id}"`);
    return importedDraft(workflow);
  });

  const seenBlockIds = new Set<string>();
  const approvedBlocksByOtherPack = new Map<string, string>();
  for (const state of listActiveApprovedPackStatesSync(ctx.root)) {
    if (state.name === input.name) continue;
    for (const block of loadInstalledPackBlocksSync(ctx.root, state.name, state.version)) {
      approvedBlocksByOtherPack.set(block.manifest.id, state.name);
    }
  }
  for (const block of blocks) {
    const id = block.manifest.id;
    if (seenBlockIds.has(id)) {
      throw new Error(`pack ${input.name}@${input.version} declares duplicate block id "${id}"`);
    }
    seenBlockIds.add(id);
    const existing = ctx.registry.getBlock(id);
    if (existing && existing.packName !== input.name) {
      const owner = existing.packName ? `approved pack "${existing.packName}"` : "AART core";
      throw new Error(`pack block id "${id}" conflicts with ${owner}; approval was not recorded`);
    }
    const approvedPackOwner = approvedBlocksByOtherPack.get(id);
    if (approvedPackOwner) {
      throw new Error(`pack block id "${id}" conflicts with approved pack "${approvedPackOwner}"; approval was not recorded`);
    }
  }

  for (const workflow of workflows) {
    const existing = await ctx.store.workflows.get(workflow.id, workflow.version);
    const {
      approval: _candidateApproval,
      gates: _candidateGates,
      needsReview: _candidateNeedsReview,
      promotionBlocked: _candidatePromotionBlocked,
      ...candidateDefinition
    } = workflow;
    const {
      approval: _existingApproval,
      gates: _existingGates,
      needsReview: _existingNeedsReview,
      promotionBlocked: _existingPromotionBlocked,
      ...existingDefinition
    } = existing ?? workflow;
    if (existing && !isDeepStrictEqual(existingDefinition, candidateDefinition)) {
      throw new Error(
        `pack workflow ${workflow.id}@${workflow.version} conflicts with an existing registered version; publish a new workflow version`,
      );
    }
  }

  const decidedAt = ctx.now().toISOString();
  const approved = await ctx.store.transact(async (tx) => {
    const decision = await writePackApprovalDecision(tx, {
      manifest: stored,
      decision: "approved",
      reviewer: input.reviewer,
      decidedAt,
    });
    for (const workflow of workflows) {
      const existing = await tx.workflows.get(workflow.id, workflow.version);
      if (existing) {
        const {
          approval: _candidateApproval,
          gates: _candidateGates,
          needsReview: _candidateNeedsReview,
          promotionBlocked: _candidatePromotionBlocked,
          ...candidateDefinition
        } = workflow;
        const {
          approval: _existingApproval,
          gates: _existingGates,
          needsReview: _existingNeedsReview,
          promotionBlocked: _existingPromotionBlocked,
          ...existingDefinition
        } = existing;
        if (!isDeepStrictEqual(existingDefinition, candidateDefinition)) {
          throw new Error(
            `pack workflow ${workflow.id}@${workflow.version} conflicts with an existing registered version; publish a new workflow version`,
          );
        }
        continue;
      }
      await tx.workflows.put(workflow);
    }
    return decision;
  });
  await approveInstalledPack(
    ctx.root,
    input.name,
    input.version,
    input.reviewer,
    new Date(decidedAt),
    input.contentHash,
  );
  return {
    ok: true,
    pack: approved.name,
    version: approved.version,
    contentHash: approved.contentHash,
    approvalStatus: approved.approvalStatus,
    loadedOnNextProcessStart: blocks.map((block) => block.manifest.id),
    registeredDraftWorkflows: workflows.map((workflow) => ({ id: workflow.id, version: workflow.version })),
    discoverableToolsOnNextProcessStart: raw.tools.map((tool) => ({ id: tool.id, version: tool.version })),
  };
}
