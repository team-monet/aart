import { createFsStore, type AartStore } from "@aart/store";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authorPack } from "./import.js";
import { createFakePackageManager, type PackageManagerAdapter } from "./package-manager.js";
import { computePackSealChecks } from "./pack-seal.js";

const manifestYaml = "name: github\nversion: 0.1.0\nblocks: [github.create_issue]\n";
const blockSources = { "github.create_issue": "export function createIssue() {}" };

describe("computePackSealChecks — the shape S4's CapabilityValidationContext.packSealChecks expects", () => {
  let root: string;
  let store: AartStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), "aart-registry-seal-"));
    store = createFsStore(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("sealBroken: false when the pack's current files hash identically to what was recorded", async () => {
    await authorPack(store, { manifestYaml, blockSources });
    const packageManager: PackageManagerAdapter = createFakePackageManager({ "aart-pack-github": { manifestYaml, blockSources } });

    const checks = await computePackSealChecks(store, [{ name: "github", version: "0.1.0" }], packageManager);
    expect(checks).toEqual([{ packName: "github", sealBroken: false }]);
  });

  it("sealBroken: true when a block's source has been edited since the manifest was recorded — spec §16.2's mechanical test", async () => {
    await authorPack(store, { manifestYaml, blockSources });
    const editedSources = { "github.create_issue": "export function createIssue() { /* edited */ }" };
    const packageManager: PackageManagerAdapter = createFakePackageManager({ "aart-pack-github": { manifestYaml, blockSources: editedSources } });

    const checks = await computePackSealChecks(store, [{ name: "github", version: "0.1.0" }], packageManager);
    expect(checks).toEqual([{ packName: "github", sealBroken: true }]);
  });

  it("sealBroken: true when the manifest itself has been edited (e.g. a capability added) since it was recorded", async () => {
    await authorPack(store, { manifestYaml, blockSources });
    const editedManifestYaml = "name: github\nversion: 0.1.0\nblocks: [github.create_issue]\ncapabilities: [github.write]\n";
    const packageManager: PackageManagerAdapter = createFakePackageManager({ "aart-pack-github": { manifestYaml: editedManifestYaml, blockSources } });

    const checks = await computePackSealChecks(store, [{ name: "github", version: "0.1.0" }], packageManager);
    expect(checks).toEqual([{ packName: "github", sealBroken: true }]);
  });

  it("skips a (name, version) with no recorded PackManifest — that's a reference-validity problem, not this function's job", async () => {
    const packageManager: PackageManagerAdapter = createFakePackageManager({});
    const checks = await computePackSealChecks(store, [{ name: "never-registered", version: "1.0.0" }], packageManager);
    expect(checks).toEqual([]);
  });

  it("checks multiple packs independently in one call", async () => {
    await authorPack(store, { manifestYaml, blockSources });
    const slackManifestYaml = "name: slack\nversion: 1.0.0\nblocks: [slack.post_message]\n";
    const slackBlockSources = { "slack.post_message": "export function postMessage() {}" };
    await authorPack(store, { manifestYaml: slackManifestYaml, blockSources: slackBlockSources });

    const packageManager: PackageManagerAdapter = createFakePackageManager({
      "aart-pack-github": { manifestYaml, blockSources },
      "aart-pack-slack": { manifestYaml: slackManifestYaml, blockSources: { "slack.post_message": "export function postMessage() { /* edited */ }" } },
    });

    const checks = await computePackSealChecks(store, [{ name: "github", version: "0.1.0" }, { name: "slack", version: "1.0.0" }], packageManager);
    expect(checks).toEqual([
      { packName: "github", sealBroken: false },
      { packName: "slack", sealBroken: true },
    ]);
  });
});
