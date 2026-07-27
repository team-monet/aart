import indexDocument from "../data/aart-pack-index.json";

export type VerificationStatus = "unverified" | "community" | "verified";

export interface CatalogBlock {
  manifest: {
    id: string;
    version: string;
    description: string;
    category?: string;
    capabilities?: string[];
  };
  examples: Array<{ description: string; inputs?: Record<string, unknown> }>;
}

export interface CatalogWorkflow {
  id: string;
  name: string;
  version: string;
  category?: string;
  keywords?: string[];
  examples?: Array<{ description: string; inputs?: Record<string, unknown> }>;
}

export interface CatalogPack {
  npmPackageName: string;
  packName: string;
  version: string;
  displayName?: string;
  description?: string;
  contentHash?: string;
  categories?: string[];
  tags?: string[];
  capabilities?: string[];
  secrets?: string[];
  author?: { name: string; url?: string };
  license?: string;
  repository?: string;
  homepage?: string;
  compatibility?: {
    aart?: string;
    node?: string;
    runtimes?: string[];
  };
  publishedAt?: string;
  updatedAt?: string;
  verification?: {
    status: VerificationStatus;
    verifiedAt?: string;
    note?: string;
  };
  stats?: {
    weeklyDownloads?: number;
    installs?: number;
    reuses?: number;
  };
  blocks: CatalogBlock[];
  workflows?: CatalogWorkflow[];
}

export interface CatalogDocument {
  schemaVersion: 1;
  generatedAt: string;
  mode?: "preview" | "production";
  packs: CatalogPack[];
}

export const catalogDocument = indexDocument as CatalogDocument;

export function packLabel(pack: CatalogPack): string {
  return pack.displayName ?? pack.packName;
}

export function packHref(pack: CatalogPack): string {
  return `/packs/${encodeURIComponent(pack.packName)}`;
}

export function allCategories(packs: CatalogPack[]): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  for (const pack of packs) {
    for (const category of pack.categories ?? []) {
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export function matchesPack(pack: CatalogPack, query: string, category?: string): boolean {
  if (category && !(pack.categories ?? []).includes(category)) return false;
  const tokens = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const haystack = [
    pack.packName,
    pack.npmPackageName,
    pack.displayName ?? "",
    pack.description ?? "",
    ...(pack.categories ?? []),
    ...(pack.tags ?? []),
    pack.author?.name ?? "",
    ...pack.blocks.flatMap((block) => [
      block.manifest.id,
      block.manifest.description,
      block.manifest.category ?? "",
    ]),
    ...(pack.workflows ?? []).flatMap((workflow) => [
      workflow.id,
      workflow.name,
      workflow.category ?? "",
      ...(workflow.keywords ?? []),
    ]),
  ]
    .join(" ")
    .toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

export function formatMetric(value = 0): string {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

export function formatDate(value?: string): string {
  if (!value) return "Not published";
  return new Intl.DateTimeFormat("en", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}
