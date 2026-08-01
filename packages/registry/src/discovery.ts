// Discovery — architecture §11.4, spec §44.3. "This is the hard part the
// founder's notes flag directly... the authoring loop's first step becomes
// search before you build."
//
// Neither source document gives `aart_find_blocks` a literal TS signature
// anywhere — it's named only in prose (architecture §11.4: "`aart_find_blocks`
// search + per-block `Example[]`... accepting a `scope: 'local'|'remote'`
// parameter"). This module is this package's own reasonable fill for that
// gap, the same way S0 designed AartStore's per-member method shapes
// (AMENDMENTS.md A1) — `@aart/mcp` (S5)'s actual `aart_find_blocks` MCP
// tool is expected to be a thin caller of `findBlocks` below, not a
// reimplementation of the search itself.
import { BlockManifestSchema, ExampleSchema, WorkflowSchema, type BlockManifest, type Example, type Workflow } from "@aart/types";
import { z } from "zod";
import { valid as validSemver } from "semver";
import { npmPackageNameFor } from "./manifest.js";
import {
  LocalToolManifestSchema,
  computeLocalToolHash,
  packToolRecord,
  searchLocalTools,
  type LocalToolManifest,
  type LocalToolSearchResult,
} from "./local-tools.js";

/**
 * A block as it appears in a search result. `BlockManifest` (frozen,
 * `@aart/types`) has no `examples` field of its own — only `Workflow`
 * does (spec §14.1) — so rather than widen the frozen S0 type for a need
 * that is entirely local to how DISCOVERY shapes its results, `examples`
 * is composed on here, at the registry-package level, reusing the
 * already-frozen `Example` type. See this session's report for the
 * fuller rationale (a locally-composed search-result type vs. amending
 * `@aart/types`).
 */
export interface BlockCatalogEntry {
  readonly manifest: BlockManifest;
  /** undefined for a core (`@aart/blocks-core`/`@aart/llm`) built-in; set to the owning pack's short name for a pack-delivered block. */
  readonly packName?: string;
  readonly examples: readonly Example[];
}

export interface BlockSearchResult extends BlockCatalogEntry {
  /** Higher is a better match. Ties broken by `manifest.id` for deterministic ordering. */
  readonly score: number;
}

export type DiscoveryScope = "local" | "remote";

export interface PackAuthor {
  readonly name: string;
  readonly url?: string;
}

export interface PackCompatibility {
  readonly aart?: string;
  readonly node?: string;
  readonly runtimes?: readonly string[];
}

export type PackVerificationStatus = "unverified" | "community" | "verified";

/**
 * Registry-owned attestation. This is intentionally not sourced from
 * `aart-pack.yaml`: a publisher cannot mark their own Pack as verified.
 */
export interface PackVerification {
  readonly status: PackVerificationStatus;
  readonly verifiedAt?: string;
  readonly note?: string;
}

/** Registry-owned aggregate signals. Publishers do not write these fields. */
export interface PackStats {
  readonly weeklyDownloads?: number;
  readonly installs?: number;
  readonly reuses?: number;
}

/** v1 remote discovery index (architecture §11.4's own `[DECISION]`): "a static JSON index file... listing every published `aart-pack-*` with its manifest summary... searched client-side." One entry per published pack. */
export interface RemoteRegistryIndexEntry {
  readonly npmPackageName: string;
  readonly packName: string;
  readonly version: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly contentHash?: string;
  readonly categories?: readonly string[];
  readonly tags?: readonly string[];
  readonly capabilities?: readonly string[];
  readonly secrets?: readonly string[];
  readonly author?: PackAuthor;
  readonly license?: string;
  readonly repository?: string;
  readonly homepage?: string;
  readonly compatibility?: PackCompatibility;
  readonly publishedAt?: string;
  readonly updatedAt?: string;
  readonly verification?: PackVerification;
  readonly stats?: PackStats;
  readonly blocks: readonly BlockCatalogEntry[];
  readonly workflows?: readonly Workflow[];
  readonly tools?: readonly LocalToolManifest[];
}

export interface RemoteRegistryIndexDocument {
  readonly schemaVersion: 1;
  /** Preview indexes contain discovery fixtures and must never be presented as installable packages. */
  readonly mode: "preview" | "production";
  readonly generatedAt?: string;
  readonly packs: readonly RemoteRegistryIndexEntry[];
}

export interface PackSearchResult {
  readonly pack: RemoteRegistryIndexEntry;
  readonly score: number;
}

export interface RemoteToolSearchResult extends LocalToolSearchResult {
  readonly pack: RemoteRegistryIndexEntry;
}

const SEARCH_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "block",
  "blocks",
  "find",
  "for",
  "no",
  "of",
  "or",
  "pack",
  "packs",
  "please",
  "such",
  "the",
  "to",
  "workflow",
  "workflows",
]);

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s._-]+/)
    .filter((token) => token.length > 0 && !SEARCH_STOP_WORDS.has(token));
}

function scoreEntry(entry: BlockCatalogEntry, tokens: string[]): number {
  if (tokens.length === 0) return 1; // empty query matches everything, uniformly — a deliberate "list everything" mode, not "match nothing"
  const id = entry.manifest.id.toLowerCase();
  const haystack = [id, entry.manifest.description, entry.manifest.category ?? "", entry.packName ?? "", ...entry.examples.map((e) => e.description)]
    .join(" ")
    .toLowerCase();

  let score = 0;
  for (const token of tokens) {
    if (id === token) score += 10;
    else if (id.includes(token)) score += 5;
    else if (haystack.includes(token)) score += 1;
  }
  return score;
}

function rank(entries: readonly BlockCatalogEntry[], query: string): BlockSearchResult[] {
  const tokens = tokenize(query);
  const minimumScore = tokens.length > 1 ? 2 : 1;
  return entries
    .map((entry) => ({ ...entry, score: scoreEntry(entry, tokens) }))
    .filter((result) => result.score >= minimumScore)
    .sort((a, b) => b.score - a.score || a.manifest.id.localeCompare(b.manifest.id));
}

/** Local search — spec §44.3's "locally" half: "searchable against the local + installed catalog." */
export function searchLocalCatalog(catalog: readonly BlockCatalogEntry[], query: string): BlockSearchResult[] {
  return rank(catalog, query);
}

/** Remote search — spec §44.3's "remotely" half: "the public registry exposes the SAME search surface... over the full public catalog instead of just the local one." */
export function searchRemoteIndex(index: readonly RemoteRegistryIndexEntry[], query: string): BlockSearchResult[] {
  const allBlocks = index.flatMap((pack) => pack.blocks.map((block) => ({ ...block, packName: block.packName ?? pack.packName })));
  return rank(allBlocks, query);
}

/** Remote workflow search uses the same workflow ranker as the local store. */
export function searchRemoteWorkflows(index: readonly RemoteRegistryIndexEntry[], query: string): WorkflowSearchResult[] {
  return searchWorkflows(index.flatMap((pack) => pack.workflows ?? []), query);
}

export function searchRemotePacks(index: readonly RemoteRegistryIndexEntry[], query: string): PackSearchResult[] {
  const tokens = tokenize(query);
  const minimumScore = tokens.length > 1 ? 2 : 1;
  return index
    .map((pack) => {
      if (tokens.length === 0) return { pack, score: 1 };
      const exact = pack.packName.toLowerCase();
      const haystack = [
        pack.packName,
        pack.npmPackageName,
        pack.displayName ?? "",
        pack.description ?? "",
        ...(pack.categories ?? []),
        ...(pack.tags ?? []),
        pack.author?.name ?? "",
        ...pack.blocks.flatMap((block) => [block.manifest.id, block.manifest.description]),
        ...(pack.workflows ?? []).flatMap((workflow) => [workflow.id, workflow.name, ...(workflow.keywords ?? [])]),
        ...(pack.tools ?? []).flatMap((tool) => [tool.id, tool.name, tool.description, ...tool.keywords, ...tool.triggers]),
      ]
        .join(" ")
        .toLowerCase();
      let score = 0;
      for (const token of tokens) {
        if (exact === token) score += 12;
        else if (exact.includes(token)) score += 6;
        else if (haystack.includes(token)) score += 1;
      }
      return { pack, score };
    })
    .filter((result) => result.score >= minimumScore)
    .sort((a, b) => b.score - a.score || a.pack.packName.localeCompare(b.pack.packName));
}

export function searchRemoteTools(index: readonly RemoteRegistryIndexEntry[], query: string): RemoteToolSearchResult[] {
  return index
    .flatMap((pack) =>
      searchLocalTools(
        (pack.tools ?? []).map((tool) =>
          packToolRecord(tool, {
            packName: pack.packName,
            packVersion: pack.version,
            contentHash: pack.contentHash ?? computeLocalToolHash(tool),
            source: pack.npmPackageName,
          }),
        ),
        query,
      ).map((result) => ({ ...result, pack })),
    )
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.record.manifest.id.localeCompare(b.record.manifest.id) ||
        a.pack.packName.localeCompare(b.pack.packName),
    );
}

export class RemoteRegistryIndexError extends Error {}

const RemoteRegistryIndexEntrySchema = z
  .object({
    npmPackageName: z.string().min(1),
    packName: z.string().min(1),
    version: z.string().min(1).refine((version) => validSemver(version) !== null, "version must be valid SemVer"),
    displayName: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
    categories: z.array(z.string().min(1)).optional(),
    tags: z.array(z.string().min(1)).optional(),
    capabilities: z.array(z.string().min(1)).optional(),
    secrets: z.array(z.string().min(1)).optional(),
    author: z
      .object({
        name: z.string().min(1),
        url: z.string().url().optional(),
      })
      .optional(),
    license: z.string().min(1).optional(),
    repository: z.string().url().optional(),
    homepage: z.string().url().optional(),
    compatibility: z
      .object({
        aart: z.string().min(1).optional(),
        node: z.string().min(1).optional(),
        runtimes: z.array(z.string().min(1)).optional(),
      })
      .optional(),
    publishedAt: z.string().datetime().optional(),
    updatedAt: z.string().datetime().optional(),
    verification: z
      .object({
        status: z.enum(["unverified", "community", "verified"]),
        verifiedAt: z.string().datetime().optional(),
        note: z.string().min(1).optional(),
      })
      .optional(),
    stats: z
      .object({
        weeklyDownloads: z.number().int().nonnegative().optional(),
        installs: z.number().int().nonnegative().optional(),
        reuses: z.number().int().nonnegative().optional(),
      })
      .optional(),
    blocks: z.array(
      z
        .object({
          manifest: BlockManifestSchema,
          examples: z.array(ExampleSchema),
          packName: z.string().min(1).optional(),
        })
        .passthrough(),
    ),
    workflows: z.array(WorkflowSchema).optional(),
    tools: z
      .array(
        LocalToolManifestSchema.superRefine((tool, ctx) => {
          if (tool.command.resolution === "asset") {
            ctx.addIssue({
              code: "custom",
              path: ["command", "resolution"],
              message: "public Pack tools must declare portable external executables",
            });
          }
          if (tool.cwd.mode === "asset") {
            ctx.addIssue({
              code: "custom",
              path: ["cwd", "mode"],
              message: "public Pack tools cannot use an asset working directory",
            });
          }
        }),
      )
      .optional(),
  })
  .passthrough()
  .superRefine((entry, ctx) => {
    let expectedNpmName: string;
    try {
      expectedNpmName = npmPackageNameFor(entry.packName);
    } catch {
      ctx.addIssue({
        code: "custom",
        path: ["packName"],
        message: `packName "${entry.packName}" is not a valid public Pack identity`,
      });
      return;
    }
    if (entry.npmPackageName !== expectedNpmName) {
      ctx.addIssue({
        code: "custom",
        path: ["npmPackageName"],
        message: `npmPackageName must be "${expectedNpmName}" for Pack "${entry.packName}"`,
      });
    }
  });

const RemoteRegistryIndexDocumentSchema = z.union([
  z.array(RemoteRegistryIndexEntrySchema).transform((packs) => ({
    schemaVersion: 1 as const,
    mode: "production" as const,
    packs,
  })),
  z
    .object({
      schemaVersion: z.literal(1).default(1),
      mode: z.enum(["preview", "production"]).default("production"),
      generatedAt: z.string().datetime().optional(),
      packs: z.array(RemoteRegistryIndexEntrySchema),
    })
    .passthrough(),
]);

export function parseRemoteRegistryIndexDocument(
  parsed: unknown,
  source = "public pack index",
): RemoteRegistryIndexDocument {
  const result = RemoteRegistryIndexDocumentSchema.safeParse(parsed);
  if (!result.success) {
    throw new RemoteRegistryIndexError(`${source} failed validation: ${result.error.message}`, {
      cause: result.error,
    });
  }
  return result.data as unknown as RemoteRegistryIndexDocument;
}

export async function fetchRemoteRegistryIndex(
  indexUrl: string,
  fetcher: typeof fetch = fetch,
): Promise<RemoteRegistryIndexDocument> {
  let response: Response;
  try {
    response = await fetcher(indexUrl);
  } catch (cause) {
    throw new RemoteRegistryIndexError(`could not fetch public pack index ${indexUrl}: ${(cause as Error).message}`, { cause });
  }
  if (!response.ok) {
    throw new RemoteRegistryIndexError(`public pack index ${indexUrl} returned HTTP ${response.status}`);
  }
  const parsed = (await response.json()) as unknown;
  return parseRemoteRegistryIndexDocument(parsed, `public pack index ${indexUrl}`);
}

export interface FindBlocksInput {
  readonly query: string;
  readonly scope: DiscoveryScope;
  readonly localCatalog?: readonly BlockCatalogEntry[];
  readonly remoteIndex?: readonly RemoteRegistryIndexEntry[];
}

/**
 * `aart_find_blocks`-shaped search (architecture §11.4/§44.3): "the
 * interface (`aart_find_blocks` accepting a `scope: 'local'|'remote'`
 * parameter) ships in v1." A block discovered this way comes with a
 * runnable usage pattern (`examples`), not just a schema — spec §44.3's
 * stated reason per-block examples matter for discovery at all.
 */
export function findBlocks(input: FindBlocksInput): BlockSearchResult[] {
  if (input.scope === "local") {
    return searchLocalCatalog(input.localCatalog ?? [], input.query);
  }
  return searchRemoteIndex(input.remoteIndex ?? [], input.query);
}

export interface WorkflowSearchResult {
  readonly workflow: Workflow;
  /** Higher is a better match. Ties break by workflow id for deterministic agent output. */
  readonly score: number;
}

function scoreWorkflow(workflow: Workflow, tokens: string[]): number {
  if (tokens.length === 0) return 1;
  const id = workflow.id.toLowerCase();
  const name = workflow.name.toLowerCase();
  const haystack = [
    id,
    name,
    workflow.category ?? "",
    ...(workflow.keywords ?? []),
    ...(workflow.examples ?? []).map((example) => example.description),
  ]
    .join(" ")
    .toLowerCase();

  let score = 0;
  for (const token of tokens) {
    if (id === token) score += 12;
    else if (name === token) score += 10;
    else if (id.includes(token)) score += 6;
    else if (name.includes(token)) score += 5;
    else if (haystack.includes(token)) score += 1;
  }
  return score;
}

/**
 * Search reusable workflow definitions before drafting a new one. This is
 * deliberately the workflow sibling of `searchLocalCatalog`: registered
 * workflows are product assets, not merely things the run screen happens to
 * know by id.
 */
export function searchWorkflows(workflows: readonly Workflow[], query: string): WorkflowSearchResult[] {
  const tokens = tokenize(query);
  const minimumScore = tokens.length > 1 ? 2 : 1;
  return workflows
    .map((workflow) => ({ workflow, score: scoreWorkflow(workflow, tokens) }))
    .filter((result) => result.score >= minimumScore)
    .sort((a, b) => b.score - a.score || a.workflow.id.localeCompare(b.workflow.id));
}
