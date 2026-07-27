import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakePackageManager, createLinkedPackageManager, PackageNotFoundError } from "./package-manager.js";

describe("createFakePackageManager — the adapter this package's own tests use exclusively", () => {
  it("resolves a registered npm package name from the in-memory catalog", async () => {
    const pm = createFakePackageManager({ "aart-pack-github": { manifestYaml: "name: github\n", blockSources: {} } });
    await expect(pm.install("aart-pack-github")).resolves.toEqual({ manifestYaml: "name: github\n", blockSources: {} });
  });

  it("throws PackageNotFoundError for an unregistered npm package name", async () => {
    const pm = createFakePackageManager({});
    await expect(pm.install("aart-pack-nope")).rejects.toThrow(PackageNotFoundError);
  });
});

// The "linked package" half of this session's "fake npm registry / linked
// package, never the real npm registry" test-fixture rule: a real temp
// directory laid out like an installed pack, read via real fs calls — no
// npm/network involved, but this exercises createLinkedPackageManager's
// ACTUAL file-reading code path (unlike the fake adapter above, which never
// touches disk at all).
describe("createLinkedPackageManager — reads a real on-disk fixture, never the real npm registry", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), "aart-linked-pack-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function writeFixturePack(dir: string): Promise<void> {
    await fs.mkdir(join(dir, "blocks"), { recursive: true });
    await fs.writeFile(join(dir, "aart-pack.yaml"), "name: github\nversion: 0.1.0\nblocks: [github.create_issue, github.comment_pr]\n", "utf8");
    await fs.writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "aart-pack-github", version: "0.1.0" }),
      "utf8",
    );
    await fs.writeFile(join(dir, "blocks", "github.create_issue.js"), "export function createIssue() {}\n", "utf8");
    await fs.writeFile(join(dir, "blocks", "github.comment_pr.js"), "export function commentPr() {}\n", "utf8");
  }

  it("reads the manifest and every declared block's source from a real fixture directory", async () => {
    const packageRoot = join(root, "aart-pack-github");
    await writeFixturePack(packageRoot);

    const pm = createLinkedPackageManager({ resolveRoot: (npmPackageName) => join(root, npmPackageName) });
    const files = await pm.install("aart-pack-github");

    expect(files.manifestYaml).toContain("name: github");
    expect(files.blockSources["github.create_issue"]).toBe("export function createIssue() {}\n");
    expect(files.blockSources["github.comment_pr"]).toBe("export function commentPr() {}\n");
    expect(files.packageJson).toEqual({ name: "aart-pack-github", version: "0.1.0" });
  });

  it("the result is usable directly by buildPackManifest/computePackContentHash — round-trips through the real hashing path", async () => {
    const packageRoot = join(root, "aart-pack-github");
    await writeFixturePack(packageRoot);
    const pm = createLinkedPackageManager({ resolveRoot: (npmPackageName) => join(root, npmPackageName) });
    const files = await pm.install("aart-pack-github");

    const { parsePackManifestYaml, buildPackManifest } = await import("./manifest.js");
    const raw = parsePackManifestYaml(files.manifestYaml);
    const manifest = buildPackManifest(raw, files.blockSources);
    expect(manifest.name).toBe("github");
    expect(manifest.approvalStatus).toBe("unapproved");
    expect(manifest.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("throws PackageNotFoundError when the resolved root has no aart-pack.yaml at all", async () => {
    const pm = createLinkedPackageManager({ resolveRoot: (npmPackageName) => join(root, npmPackageName) });
    await expect(pm.install("aart-pack-does-not-exist")).rejects.toThrow(PackageNotFoundError);
  });

  it("a change to a block's source file on disk changes the resulting content hash — the linked-package path feeds the same seal mechanism as any other", async () => {
    const packageRoot = join(root, "aart-pack-github");
    await writeFixturePack(packageRoot);
    const pm = createLinkedPackageManager({ resolveRoot: (npmPackageName) => join(root, npmPackageName) });
    const { parsePackManifestYaml, buildPackManifest } = await import("./manifest.js");

    const before = buildPackManifest(parsePackManifestYaml((await pm.install("aart-pack-github")).manifestYaml), (await pm.install("aart-pack-github")).blockSources);

    await fs.writeFile(join(packageRoot, "blocks", "github.create_issue.js"), "export function createIssue() { /* edited on disk */ }\n", "utf8");
    const filesAfter = await pm.install("aart-pack-github");
    const after = buildPackManifest(parsePackManifestYaml(filesAfter.manifestYaml), filesAfter.blockSources);

    expect(after.contentHash).not.toBe(before.contentHash);
  });
});
