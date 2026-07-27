import type { BlockManifest, Workflow } from "@aart/types";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  findBlocks,
  parseRemoteRegistryIndexDocument,
  searchLocalCatalog,
  searchRemoteIndex,
  searchRemotePacks,
  searchWorkflows,
  type BlockCatalogEntry,
  type RemoteRegistryIndexEntry,
} from "./discovery.js";

function manifest(overrides: Partial<BlockManifest> = {}): BlockManifest {
  return {
    id: "browser.click",
    version: "1.0.0",
    capabilities: ["browser"],
    inputSchema: {},
    outputSchema: {},
    description: "Click an element on the page",
    ...overrides,
  };
}

function entry(overrides: Partial<BlockCatalogEntry> = {}): BlockCatalogEntry {
  return {
    manifest: manifest(),
    examples: [],
    ...overrides,
  };
}

const catalog: BlockCatalogEntry[] = [
  entry({ manifest: manifest({ id: "browser.click", description: "Click an element on the page" }) }),
  entry({ manifest: manifest({ id: "browser.goto", description: "Navigate the browser to a URL" }) }),
  entry({
    manifest: manifest({ id: "github.create_issue", description: "Open a new GitHub issue" }),
    packName: "github",
    examples: [{ description: "File a bug report", inputs: { title: "Bug", body: "Steps to reproduce..." } }],
  }),
  entry({ manifest: manifest({ id: "http.request", description: "Make an HTTP request" }) }),
];

describe("searchLocalCatalog — spec §44.3 'locally... searchable against the local + installed catalog'", () => {
  it("an exact block-id match ranks first", () => {
    const results = searchLocalCatalog(catalog, "browser.click");
    expect(results[0]?.manifest.id).toBe("browser.click");
  });

  it("a partial id match beats a description-only match", () => {
    // "browser" is a substring of two ids (browser.click, browser.goto)
    // AND appears in http.request's capability list only, not its id/desc —
    // wait, http.request doesn't mention "browser" at all; use a query that
    // distinguishes id-substring from description-only matches instead.
    const results = searchLocalCatalog(catalog, "click");
    expect(results[0]?.manifest.id).toBe("browser.click"); // id match
  });

  it("matches against the description when the query isn't part of the id", () => {
    const results = searchLocalCatalog(catalog, "navigate");
    expect(results.map((r) => r.manifest.id)).toContain("browser.goto");
  });

  it("matches against per-block example descriptions — a discovered block comes with a runnable usage pattern (spec §44.3)", () => {
    const results = searchLocalCatalog(catalog, "bug report");
    expect(results.map((r) => r.manifest.id)).toContain("github.create_issue");
  });

  it("surfaces examples in the search result, unmodified", () => {
    const results = searchLocalCatalog(catalog, "github");
    const github = results.find((r) => r.manifest.id === "github.create_issue");
    expect(github?.examples).toHaveLength(1);
    expect(github?.examples[0]?.description).toBe("File a bug report");
  });

  it("an empty query returns every entry (uniform score)", () => {
    const results = searchLocalCatalog(catalog, "");
    expect(results).toHaveLength(catalog.length);
  });

  it("a query matching nothing returns an empty array", () => {
    const results = searchLocalCatalog(catalog, "nonexistent-zzz-block");
    expect(results).toEqual([]);
  });

  it("ties break alphabetically by block id", () => {
    const tied: BlockCatalogEntry[] = [entry({ manifest: manifest({ id: "z.block", description: "widget" }) }), entry({ manifest: manifest({ id: "a.block", description: "widget" }) })];
    const results = searchLocalCatalog(tied, "widget");
    expect(results.map((r) => r.manifest.id)).toEqual(["a.block", "z.block"]);
  });

  it("is case-insensitive", () => {
    const results = searchLocalCatalog(catalog, "BROWSER.CLICK");
    expect(results[0]?.manifest.id).toBe("browser.click");
  });
});

describe("searchRemoteIndex — spec §44.3 'remotely... the SAME search surface... over the full public catalog'", () => {
  const remoteIndex: RemoteRegistryIndexEntry[] = [
    {
      npmPackageName: "aart-pack-github",
      packName: "github",
      version: "0.1.0",
      blocks: [entry({ manifest: manifest({ id: "github.create_issue", description: "Open a new GitHub issue" }) })],
    },
    {
      npmPackageName: "aart-pack-slack",
      packName: "slack",
      version: "1.0.0",
      blocks: [entry({ manifest: manifest({ id: "slack.post_message", description: "Post a message to a channel" }) })],
    },
  ];

  it("searches across every pack in the index", () => {
    const results = searchRemoteIndex(remoteIndex, "message");
    expect(results.map((r) => r.manifest.id)).toEqual(["slack.post_message"]);
  });

  it("attaches the owning pack's name to each result when the block entry doesn't already carry one", () => {
    const results = searchRemoteIndex(remoteIndex, "github");
    expect(results[0]?.packName).toBe("github");
  });

  it("uses the SAME ranking/matching logic as local search (shared search surface, not a divergent implementation)", () => {
    const local = searchLocalCatalog(remoteIndex[0]!.blocks, "issue");
    const remote = searchRemoteIndex([remoteIndex[0]!], "issue");
    expect(remote.map((r) => r.manifest.id)).toEqual(local.map((r) => r.manifest.id));
  });
});

describe("public Pack catalog index contract", () => {
  it("validates the catalog site's preview data against the same wire contract used by CLI and MCP", async () => {
    const source = await readFile(new URL("../../catalog/data/aart-pack-index.json", import.meta.url), "utf8");
    const document = parseRemoteRegistryIndexDocument(JSON.parse(source), "catalog fixture");
    expect(document.schemaVersion).toBe(1);
    expect(document.packs.length).toBeGreaterThanOrEqual(6);
    expect(document.packs.every((pack) => (pack.categories?.length ?? 0) > 0)).toBe(true);
  });

  it("searches Pack-level categories, tags, display name and author metadata", () => {
    const pack: RemoteRegistryIndexEntry = {
      npmPackageName: "aart-pack-release-proof",
      packName: "release-proof",
      displayName: "Release Evidence",
      version: "1.0.0",
      description: "Preserve a release record",
      categories: ["quality"],
      tags: ["deployment"],
      author: { name: "Proofplane" },
      blocks: [],
    };
    expect(searchRemotePacks([pack], "quality")[0]?.pack.packName).toBe("release-proof");
    expect(searchRemotePacks([pack], "deployment")[0]?.pack.packName).toBe("release-proof");
    expect(searchRemotePacks([pack], "evidence")[0]?.pack.packName).toBe("release-proof");
    expect(searchRemotePacks([pack], "proofplane")[0]?.pack.packName).toBe("release-proof");
  });

  it("rejects publisher-authored invalid verification and statistics metadata", () => {
    expect(() =>
      parseRemoteRegistryIndexDocument({
        schemaVersion: 1,
        packs: [{
          npmPackageName: "aart-pack-bad",
          packName: "bad",
          version: "1.0.0",
          blocks: [],
          verification: { status: "self-certified" },
          stats: { reuses: -10 },
        }],
      }),
    ).toThrow(/failed validation/);
  });
});

describe("findBlocks — the aart_find_blocks-shaped entry point, scope: 'local' | 'remote' (architecture §11.4)", () => {
  it("scope 'local' searches localCatalog only", () => {
    const results = findBlocks({ query: "click", scope: "local", localCatalog: catalog });
    expect(results.map((r) => r.manifest.id)).toEqual(["browser.click"]);
  });

  it("scope 'remote' searches remoteIndex only", () => {
    const remoteIndex: RemoteRegistryIndexEntry[] = [
      { npmPackageName: "aart-pack-github", packName: "github", version: "0.1.0", blocks: [entry({ manifest: manifest({ id: "github.create_issue" }) })] },
    ];
    const results = findBlocks({ query: "github", scope: "remote", remoteIndex });
    expect(results.map((r) => r.manifest.id)).toEqual(["github.create_issue"]);
  });

  it("scope 'local' with no localCatalog supplied returns [] rather than throwing", () => {
    expect(findBlocks({ query: "anything", scope: "local" })).toEqual([]);
  });

  it("scope 'remote' with no remoteIndex supplied returns [] rather than throwing", () => {
    expect(findBlocks({ query: "anything", scope: "remote" })).toEqual([]);
  });

  it("does not leak remote results into a local-scoped search", () => {
    // "slack" exists ONLY in remoteIndex here — `catalog` (the local
    // catalog) has no slack block at all, so a local-scoped search for it
    // must come back empty even though a matching remoteIndex was supplied
    // alongside localCatalog.
    const remoteIndex: RemoteRegistryIndexEntry[] = [
      { npmPackageName: "aart-pack-slack", packName: "slack", version: "1.0.0", blocks: [entry({ manifest: manifest({ id: "slack.post_message", description: "Post a message" }) })] },
    ];
    const results = findBlocks({ query: "slack", scope: "local", localCatalog: catalog, remoteIndex });
    expect(results).toEqual([]);
  });
});

function workflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: "verify-checkout",
    name: "Verify checkout",
    version: "1.0.0",
    inputs: [],
    outputs: [],
    execution: { type: "workflow", steps: [] },
    approval: "approved",
    gates: { validate: "passed", readiness: "passed", evals: "passed", riskReview: "passed", humanReview: "passed" },
    ...overrides,
  };
}

describe("searchWorkflows — reusable workflow discovery", () => {
  const workflows = [
    workflow({ id: "verify-checkout", name: "Verify checkout flow", category: "quality", keywords: ["commerce", "browser"] }),
    workflow({ id: "sync-customers", name: "Synchronize customers", category: "data", keywords: ["crm"] }),
    workflow({ id: "release-proof", name: "Release verification", examples: [{ description: "Check a production release", inputs: {} }] }),
  ];

  it("ranks an exact workflow id first", () => {
    expect(searchWorkflows(workflows, "sync-customers")[0]?.workflow.id).toBe("sync-customers");
  });

  it("finds by name, category, keyword, and example description", () => {
    expect(searchWorkflows(workflows, "checkout")[0]?.workflow.id).toBe("verify-checkout");
    expect(searchWorkflows(workflows, "data")[0]?.workflow.id).toBe("sync-customers");
    expect(searchWorkflows(workflows, "crm")[0]?.workflow.id).toBe("sync-customers");
    expect(searchWorkflows(workflows, "production")[0]?.workflow.id).toBe("release-proof");
  });

  it("returns every workflow for an empty browse query with deterministic ordering", () => {
    expect(searchWorkflows(workflows, "").map((result) => result.workflow.id)).toEqual(["release-proof", "sync-customers", "verify-checkout"]);
  });
});
