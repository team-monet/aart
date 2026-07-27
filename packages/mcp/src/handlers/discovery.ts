// Discovery handlers — aart_find_blocks, aart_get_block, aart_list_blocks,
// aart_get_schema, aart_propose_workflow. All real: they read this
// worktree's real BUILTIN_BLOCK_CATALOG (catalog.ts) through the
// RegistryPort (S7-signature-mirroring stub, stubs/registry.ts), the real
// frozen @aart/types JSON-Schema derivation, and this package's own real
// recipes.ts — none of these five need a sibling package's business logic
// beyond "search a catalog," which is why they're not flagged as
// simplified the way the execution/governance handlers are.
import { WorkflowSchema } from "@aart/types";
import { toJsonSchema } from "@aart/types";
import { fetchRemoteRegistryIndex, searchRemoteIndex, searchWorkflows, type WorkflowSearchResult } from "@aart/registry";
import type { AartContext } from "../context.js";
import { matchRecipes } from "../recipes.js";
import type { HandlerResult } from "../response.js";

export interface FindBlocksInput {
  query: string;
  category?: string;
  scope?: "local" | "remote" | "all";
  indexUrl?: string;
}

export async function findBlocksHandler(ctx: AartContext, input: FindBlocksInput): Promise<HandlerResult> {
  const scope = input.scope ?? "local";
  const local =
    scope === "remote"
      ? []
      : ctx.registry
          .findBlocks({ query: input.query, category: input.category })
          .map((result) => ({ ...result, source: "local" as const }));
  let remote: Array<{
    entry: (typeof local)[number]["entry"];
    score: number;
    source: "public";
    catalogMode: "preview" | "production";
  }> = [];
  if (scope !== "local") {
    const indexUrl = input.indexUrl ?? process.env.AART_PACK_INDEX_URL;
    if (!indexUrl) throw new Error("remote block search needs indexUrl or AART_PACK_INDEX_URL");
    const index = await fetchRemoteRegistryIndex(indexUrl);
    remote = searchRemoteIndex(index.packs, input.query)
      .filter((result) => (input.category ? result.manifest.category === input.category : true))
      .map(({ score, ...entry }) => ({
        entry,
        score,
        source: "public" as const,
        catalogMode: index.mode,
      }));
  }
  const results = [...local, ...remote].sort(
    (a, b) => b.score - a.score || a.entry.manifest.id.localeCompare(b.entry.manifest.id),
  );
  return {
    ok: true,
    matched: results.length > 0,
    query: input.query,
    scope,
    blocks: results.map((r) => ({
      id: r.entry.manifest.id,
      description: r.entry.manifest.description,
      category: r.entry.manifest.category,
      packName: r.entry.packName,
      examples: r.entry.examples,
      source: r.source,
      ...("catalogMode" in r ? { catalogMode: r.catalogMode } : {}),
      score: r.score,
    })),
  };
}

export interface FindWorkflowsInput {
  query: string;
  category?: string;
  scope?: "local" | "remote" | "all";
  indexUrl?: string;
}

export async function findWorkflowsHandler(ctx: AartContext, input: FindWorkflowsInput): Promise<HandlerResult> {
  type RankedWorkflow = WorkflowSearchResult & { source: "local" | "public"; packName?: string };
  const scope = input.scope ?? "local";
  const local: RankedWorkflow[] =
    scope === "remote"
      ? []
      : await (async () => {
          const ids = await ctx.store.workflows.listWorkflowIds();
          const latest = await Promise.all(ids.map((id) => ctx.store.workflows.getLatest(id)));
          const workflows = latest.filter((workflow): workflow is NonNullable<typeof workflow> => workflow !== undefined);
          return searchWorkflows(workflows, input.query)
            .filter((result) => (input.category ? result.workflow.category === input.category : true))
            .map((result) => ({ ...result, source: "local" as const, packName: undefined }));
        })();
  let remote: RankedWorkflow[] = [];
  if (scope !== "local") {
    const indexUrl = input.indexUrl ?? process.env.AART_PACK_INDEX_URL;
    if (!indexUrl) throw new Error("remote workflow search needs indexUrl or AART_PACK_INDEX_URL");
    const index = await fetchRemoteRegistryIndex(indexUrl);
    remote = index.packs.flatMap((pack) =>
      searchWorkflows(pack.workflows ?? [], input.query)
        .filter((result) => (input.category ? result.workflow.category === input.category : true))
        .map((result) => ({
          ...result,
          source: "public" as const,
          packName: pack.packName,
          catalogMode: index.mode,
        })),
    );
  }
  const results = [...local, ...remote].sort(
    (a, b) => b.score - a.score || a.workflow.id.localeCompare(b.workflow.id),
  );
  return {
    ok: true,
    matched: results.length > 0,
    query: input.query,
    scope,
    workflows: results.map((result) => ({
      id: result.workflow.id,
      name: result.workflow.name,
      version: result.workflow.version,
      category: result.workflow.category,
      keywords: result.workflow.keywords ?? [],
      approval: result.workflow.approval,
      score: result.score,
      source: result.source,
      packName: result.packName,
      ...("catalogMode" in result ? { catalogMode: result.catalogMode } : {}),
      examples: result.workflow.examples ?? [],
    })),
  };
}

export interface GetBlockInput {
  id: string;
}

export async function getBlockHandler(ctx: AartContext, input: GetBlockInput): Promise<HandlerResult> {
  const entry = ctx.registry.getBlock(input.id);
  if (!entry) return { ok: false, error: `Unknown block id "${input.id}".` };
  return { ok: true, block: entry.manifest, packName: entry.packName, examples: entry.examples };
}

export interface ListBlocksInput {
  category?: string;
}

export async function listBlocksHandler(ctx: AartContext, input: ListBlocksInput): Promise<HandlerResult> {
  const all = ctx.registry.listBlocks();
  const filtered = input.category ? all.filter((e) => e.manifest.category === input.category) : all;
  return { ok: true, blocks: filtered.map((e) => e.manifest), count: filtered.length };
}

export interface GetSchemaInput {
  kind: "workflow" | "block";
  blockId?: string;
}

export async function getSchemaHandler(ctx: AartContext, input: GetSchemaInput): Promise<HandlerResult> {
  if (input.kind === "workflow") {
    return { ok: true, kind: "workflow", schema: toJsonSchema(WorkflowSchema) };
  }
  if (!input.blockId) return { ok: false, error: 'kind "block" requires a blockId.' };
  const entry = ctx.registry.getBlock(input.blockId);
  if (!entry) return { ok: false, error: `Unknown block id "${input.blockId}".` };
  return { ok: true, kind: "block", blockId: input.blockId, inputSchema: entry.manifest.inputSchema, outputSchema: entry.manifest.outputSchema };
}

export interface ProposeWorkflowInput {
  request: string;
}

export async function proposeWorkflowHandler(_ctx: AartContext, input: ProposeWorkflowInput): Promise<HandlerResult> {
  const matches = matchRecipes(input.request);
  const best = matches[0];
  if (!best) return { ok: false, error: `No recipe matched "${input.request}".`, candidates: [] };
  return {
    ok: true,
    recipeId: best.recipe.id,
    matchedPhrase: best.matchedPhrase,
    skeleton: best.recipe.skeleton,
    alternatives: matches.slice(1, 4).map((m) => m.recipe.id),
  };
}
