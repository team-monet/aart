import { createFsStore, createLogger, type AartStore, type Logger } from "@aart/store";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authorPack, PackNameMismatchError, installPack } from "./import.js";
import { createFakePackageManager } from "./package-manager.js";

const githubManifestYaml = `
name: github
version: 0.1.0
capabilities: [github.read, github.write]
secrets: [GITHUB_TOKEN]
blocks: [github.create_issue, github.comment_pr, github.list_pr_files]
`;

const githubBlockSources = {
  "github.create_issue": "export function createIssue() {}",
  "github.comment_pr": "export function commentPr() {}",
  "github.list_pr_files": "export function listPrFiles() {}",
};

describe("authorPack / installPack — spec §44.2's 'no separate, weaker approval path'", () => {
  let root: string;
  let store: AartStore;
  let logger: Logger;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), "aart-registry-import-"));
    store = createFsStore(root);
    logger = createLogger();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("authorPack (workspace-authored) lands approvalStatus 'unapproved'", async () => {
    const manifest = await authorPack(store, { manifestYaml: githubManifestYaml, blockSources: githubBlockSources }, logger);
    expect(manifest.approvalStatus).toBe("unapproved");
  });

  it("installPack (npm-distributed, via a FAKE registry — never the real npm registry) lands approvalStatus 'unapproved'", async () => {
    const packageManager = createFakePackageManager({
      "aart-pack-github": { manifestYaml: githubManifestYaml, blockSources: githubBlockSources },
    });
    const manifest = await installPack(store, "github", packageManager, logger);
    expect(manifest.approvalStatus).toBe("unapproved");
  });

  // The DoD's own named invariant test: a pack pulled from the (fake)
  // public registry lands IDENTICALLY to a workspace-authored pack — same
  // approvalStatus, by the same construction path, not just "both happen
  // to currently read 'unapproved'".
  it("an imported pack and a workspace-authored pack land in IDENTICAL unapproved states — spec §44.2", async () => {
    const authored = await authorPack(store, { manifestYaml: githubManifestYaml, blockSources: githubBlockSources }, logger);

    const packageManager = createFakePackageManager({
      "aart-pack-github": { manifestYaml: githubManifestYaml, blockSources: githubBlockSources },
    });
    const installed = await installPack(store, "github", packageManager, logger);

    expect(installed.approvalStatus).toBe(authored.approvalStatus);
    expect(installed.approvalStatus).toBe("unapproved");
    // Not just the same STATUS value — the same content hash too, since
    // both paths hashed the identical (manifest, blockSources) pair
    // through the identical function.
    expect(installed.contentHash).toBe(authored.contentHash);
  });

  it("installPack persists the manifest, retrievable via store.packManifests — never anything but unapproved on retrieval either", async () => {
    const packageManager = createFakePackageManager({
      "aart-pack-slack": {
        manifestYaml: "name: slack\nversion: 1.0.0\nblocks: [slack.post_message]\n",
        blockSources: { "slack.post_message": "export function postMessage() {}" },
      },
    });
    await installPack(store, "slack", packageManager, logger);
    const stored = await store.packManifests.get("slack", "1.0.0");
    expect(stored?.approvalStatus).toBe("unapproved");
  });

  it("installPack derives the npm package name via the ADR-12 'aart-pack-<name>' prefix — callers pass the short name only", async () => {
    const packageManager = createFakePackageManager({
      // Registered under the PREFIXED name, exactly as a real npm registry
      // would list it — install("github") must resolve to this key, not
      // to a bare "github" lookup.
      "aart-pack-github": { manifestYaml: githubManifestYaml, blockSources: githubBlockSources },
    });
    const manifest = await installPack(store, "github", packageManager, logger);
    expect(manifest.name).toBe("github");
  });

  it("installPack rejects a manifest whose declared name doesn't match the requested pack name", async () => {
    const packageManager = createFakePackageManager({
      "aart-pack-github": { manifestYaml: "name: not-github\nversion: 0.1.0\nblocks: [x]\n", blockSources: { x: "export {}" } },
    });
    await expect(installPack(store, "github", packageManager, logger)).rejects.toThrow(PackNameMismatchError);
  });

  it("authorPack and installPack take a fixed, small parameter list with no approval-state slot", () => {
    // authorPack: (store, input, logger?) = 3. installPack: (store, name,
    // packageManager, logger?) = 4. Both are exhaustively exercised above
    // with only these arguments and always land "unapproved" — there is no
    // additional parameter either signature accepts that could set
    // approvalStatus to anything else (enforced at the TypeScript level:
    // an extra argument here would be a compile error, not just a
    // runtime no-op).
    expect(authorPack.length).toBe(3);
    expect(installPack.length).toBe(4);
  });
});
