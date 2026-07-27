import { describe, expect, it } from "vitest";
import { computePackContentHash } from "./hash.js";
import {
  buildPackManifest,
  InvalidPackNameError,
  npmPackageNameFor,
  packNameFromNpmPackage,
  PackManifestParseError,
  parsePackManifestYaml,
  recomputePackManifest,
} from "./manifest.js";

const validYaml = `
name: github
version: 0.1.0
capabilities: [github.read, github.write]
secrets: [GITHUB_TOKEN]
blocks: [github.create_issue, github.comment_pr, github.list_pr_files]
`;

const blockSources = {
  "github.create_issue": "export function createIssue() {}",
  "github.comment_pr": "export function commentPr() {}",
  "github.list_pr_files": "export function listPrFiles() {}",
};

describe("parsePackManifestYaml — architecture §11.1's literal example", () => {
  it("parses a well-formed manifest", () => {
    const raw = parsePackManifestYaml(validYaml);
    expect(raw.name).toBe("github");
    expect(raw.version).toBe("0.1.0");
    expect(raw.capabilities).toEqual(["github.read", "github.write"]);
    expect(raw.secrets).toEqual(["GITHUB_TOKEN"]);
    expect(raw.blocks).toEqual(["github.create_issue", "github.comment_pr", "github.list_pr_files"]);
  });

  it("defaults capabilities/secrets to [] when omitted", () => {
    const raw = parsePackManifestYaml("name: minimal\nversion: 0.1.0\nblocks: [minimal.run]\n");
    expect(raw.capabilities).toEqual([]);
    expect(raw.secrets).toEqual([]);
  });

  it("passes through fields beyond the minimal schema (spec §16.3's fuller connector-capabilities list)", () => {
    const raw = parsePackManifestYaml(`${validYaml}\nauthMethod: oauth2\nexternalDomains: [api.github.com]\n`);
    expect((raw as Record<string, unknown>).authMethod).toBe("oauth2");
    expect((raw as Record<string, unknown>).externalDomains).toEqual(["api.github.com"]);
  });

  it("rejects invalid YAML", () => {
    expect(() => parsePackManifestYaml("name: [unterminated")).toThrow(PackManifestParseError);
  });

  it("rejects a manifest missing a required field (name)", () => {
    expect(() => parsePackManifestYaml("version: 0.1.0\nblocks: [x]\n")).toThrow(PackManifestParseError);
  });

  it("rejects a manifest with no block or workflow assets", () => {
    expect(() => parsePackManifestYaml("name: x\nversion: 0.1.0\nblocks: []\nworkflows: []\n")).toThrow(PackManifestParseError);
  });

  it("rejects path traversal in every manifest field used as an on-disk path", () => {
    expect(() => parsePackManifestYaml("name: ..\nversion: 1.0.0\nblocks: [safe.block]\n")).toThrow(PackManifestParseError);
    expect(() => parsePackManifestYaml("name: safe\nversion: ..\nblocks: [safe.block]\n")).toThrow(PackManifestParseError);
    expect(() => parsePackManifestYaml("name: safe\nversion: 1.0.0\nblocks: [..]\n")).toThrow(PackManifestParseError);
    expect(() => parsePackManifestYaml("name: safe\nversion: 1.0.0\nworkflows: [../escape]\n")).toThrow(PackManifestParseError);
  });

  it("accepts a workflow-only Pack and defaults blocks to empty", () => {
    const raw = parsePackManifestYaml("name: reusable\nversion: 1.0.0\nworkflows: [release-proof]\n");
    expect(raw.blocks).toEqual([]);
    expect(raw.workflows).toEqual(["release-proof"]);
  });

  it("rejects duplicate Block or Workflow declarations before preparation can certify the Pack", () => {
    expect(() =>
      parsePackManifestYaml("name: duplicate\nversion: 1.0.0\nblocks: [demo.echo, demo.echo]\n"),
    ).toThrow(/block ids must be unique/);
    expect(() =>
      parsePackManifestYaml("name: duplicate\nversion: 1.0.0\nworkflows: [demo-flow, demo-flow]\n"),
    ).toThrow(/workflow ids must be unique/);
  });
});

describe("npm naming convention — ADR-12/ADR-18 (unscoped, unrelated to @team-monet)", () => {
  it("npmPackageNameFor prefixes aart-pack-", () => {
    expect(npmPackageNameFor("github")).toBe("aart-pack-github");
  });

  it("packNameFromNpmPackage strips the prefix", () => {
    expect(packNameFromNpmPackage("aart-pack-github")).toBe("github");
  });

  it("packNameFromNpmPackage rejects a non-conforming package name", () => {
    expect(() => packNameFromNpmPackage("@team-monet/aart")).toThrow(InvalidPackNameError);
    expect(() => packNameFromNpmPackage("some-other-package")).toThrow(InvalidPackNameError);
  });

  it("rejects unsafe or option-shaped logical pack names before invoking npm", () => {
    expect(() => npmPackageNameFor("../demo")).toThrow(InvalidPackNameError);
    expect(() => npmPackageNameFor("--ignore-scripts")).toThrow(InvalidPackNameError);
    expect(() => npmPackageNameFor("Demo")).toThrow(InvalidPackNameError);
  });

  it("round-trips", () => {
    expect(packNameFromNpmPackage(npmPackageNameFor("slack"))).toBe("slack");
  });
});

describe("buildPackManifest — the single PackManifest constructor", () => {
  it("always lands approvalStatus 'unapproved', regardless of input", () => {
    const raw = parsePackManifestYaml(validYaml);
    const manifest = buildPackManifest(raw, blockSources);
    expect(manifest.approvalStatus).toBe("unapproved");
  });

  it("has no approvalStatus parameter at all — structurally impossible to author an already-approved pack", () => {
    // Type-level guarantee, asserted at runtime by arity: the function
    // takes exactly (raw, blockSources) — there is no third parameter a
    // caller could use to smuggle in a different approvalStatus.
    expect(buildPackManifest.length).toBe(2);
  });

  it("sets contentHash to computePackContentHash's result over the same (manifest, blockSources)", () => {
    const raw = parsePackManifestYaml(validYaml);
    const manifest = buildPackManifest(raw, blockSources);
    expect(manifest.contentHash).toBe(computePackContentHash(raw as unknown as Record<string, unknown>, blockSources));
  });

  it("preserves name/version from the raw manifest", () => {
    const raw = parsePackManifestYaml(validYaml);
    const manifest = buildPackManifest(raw, blockSources);
    expect(manifest.name).toBe("github");
    expect(manifest.version).toBe("0.1.0");
  });

  it("embeds the full raw manifest (including passthrough fields) under .manifest", () => {
    const raw = parsePackManifestYaml(validYaml);
    const manifest = buildPackManifest(raw, blockSources);
    expect(manifest.manifest.capabilities).toEqual(["github.read", "github.write"]);
    expect(manifest.manifest.blocks).toEqual(["github.create_issue", "github.comment_pr", "github.list_pr_files"]);
  });
});

describe("recomputePackManifest — the 'on load, recompute the hash' half of the seal check", () => {
  it("recomputes contentHash from the current (manifest, blockSources)", () => {
    const raw = parsePackManifestYaml(validYaml);
    const approved = { ...buildPackManifest(raw, blockSources), approvalStatus: "approved" as const };

    const editedSources = { ...blockSources, "github.comment_pr": "export function commentPr() { /* edited */ }" };
    const current = recomputePackManifest(approved, raw, editedSources);

    expect(current.contentHash).not.toBe(approved.contentHash);
  });

  it("preserves the existing approvalStatus rather than resetting it — the seal-break DECISION belongs to governance, not to recomputation", () => {
    const raw = parsePackManifestYaml(validYaml);
    const approved = { ...buildPackManifest(raw, blockSources), approvalStatus: "approved" as const };
    const current = recomputePackManifest(approved, raw, blockSources);
    expect(current.approvalStatus).toBe("approved");
  });

  it("produces an IDENTICAL hash to buildPackManifest given the same (manifest, blockSources) — same underlying hash function", () => {
    const raw = parsePackManifestYaml(validYaml);
    const built = buildPackManifest(raw, blockSources);
    const recomputed = recomputePackManifest({ approvalStatus: "unapproved" }, raw, blockSources);
    expect(recomputed.contentHash).toBe(built.contentHash);
  });
});
