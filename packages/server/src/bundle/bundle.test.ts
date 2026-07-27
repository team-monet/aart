// aart bundle production — architecture §0.3/ADR-04. This session's DoD:
// "produces a self-contained bundle... with correct transitive-closure
// computation (every referenced block/pack/registry entry) — tested
// against a fixture workflow with at least 2 levels of block-reference
// nesting to catch an incomplete-closure bug."
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { approveInstalledPack, persistInstalledPack } from "@aart/registry";
import type { Workflow } from "@aart/types";
import { produceBundle, writeBundleToDisk } from "./bundle.js";
import { createTestFixture, type TestFixture } from "../test-helpers.js";

let fx: TestFixture | undefined;
afterEach(async () => {
  await fx?.cleanup();
  fx = undefined;
});

const approvedGates = { validate: "passed" as const, readiness: "passed" as const, evals: "passed" as const, riskReview: "passed" as const, humanReview: "passed" as const };

function baseWorkflow(overrides: Partial<Workflow>): Workflow {
  return { id: "wf", name: "n", version: "1", inputs: [], outputs: [], execution: { type: "workflow", steps: [] }, approval: "approved", gates: approvedGates, ...overrides };
}

/** Two levels of nested-workflow references (root -> child -> grandchild), a pack-delivered block, and an llm.* prompt/schema ref — exactly the fixture shape this session's DoD names. */
async function setUpTwoLevelFixture(fx: TestFixture): Promise<void> {
  await fx.store.workflows.put(
    baseWorkflow({
      id: "grandchild-wf",
      version: "1",
      execution: {
        type: "workflow",
        steps: [{ id: "extract", uses: "llm.extract", with: { promptRef: "extract-prompt", schemaRef: "extract-schema" } }],
      },
    }),
  );
  await fx.store.workflows.put(
    baseWorkflow({
      id: "child-wf",
      version: "1",
      execution: {
        type: "workflow",
        steps: [
          { id: "comment", uses: "github.create_comment", with: {} },
          { id: "nested2", uses: "flow.subworkflow", with: { workflowId: "grandchild-wf", version: "1" } },
        ],
      },
    }),
  );
  await fx.store.workflows.put(
    baseWorkflow({
      id: "root-wf",
      version: "1",
      execution: {
        type: "workflow",
        steps: [
          { id: "click", uses: "browser.click", with: {} }, // core built-in — no pack
          { id: "nested1", uses: "flow.subworkflow", with: { workflowId: "child-wf", version: "1" } },
        ],
      },
    }),
  );
  await fx.store.packManifests.put({ name: "github", version: "2.0.0", contentHash: "hash-gh-2", manifest: { blocks: ["github.create_comment"] }, approvalStatus: "approved" });
  await fx.store.promptRegistry.put({ name: "extract-prompt", version: "3", contentHash: "hash-p3", body: "Extract the fields." });
  await fx.store.schemaRegistry.put({ name: "extract-schema", version: "2", contentHash: "hash-s2", jsonSchema: { type: "object" } });
}

describe("produceBundle — transitive closure (architecture §0.3, ADR-04)", () => {
  it("walks 2 levels of nested-workflow references and includes every workflow in the closure", async () => {
    fx = await createTestFixture();
    await setUpTwoLevelFixture(fx);
    const bundle = await produceBundle(fx.store, { workflowId: "root-wf", workflowVersion: "1" });
    expect(Object.keys(bundle.definitions).sort()).toEqual(["child-wf@1", "grandchild-wf@1", "root-wf@1"]);
  });

  it("includes the pack manifest for a pack-delivered namespace reached only through the SECOND level of nesting", async () => {
    fx = await createTestFixture();
    await setUpTwoLevelFixture(fx);
    const bundle = await produceBundle(fx.store, { workflowId: "root-wf", workflowVersion: "1" });
    // This is the exact bug class the DoD calls out: an incomplete closure
    // walk that stops after 1 level would miss child-wf's own "github"
    // pack dependency entirely.
    expect(bundle.packs["github@2.0.0"]).toBeDefined();
    expect(bundle.manifest.packs).toContainEqual({ name: "github", version: "2.0.0", contentHash: "hash-gh-2" });
  });

  it("resolves Pack ownership from the exact block id and bundles the active approved version", async () => {
    fx = await createTestFixture();
    const packRoot = await fs.mkdtemp(join(tmpdir(), "aart-bundle-owner-pack-"));
    const blockSource = `module.exports = {
      manifest: {
        id: "browser.assert_journey",
        version: "1.0.0",
        capabilities: [],
        inputSchema: {},
        outputSchema: {},
        description: "Assert a browser journey"
      },
      execute: (input) => input
    };`;
    try {
      const active = await persistInstalledPack(
        packRoot,
        {
          manifestYaml: "name: browser-checks\nversion: 1.0.0\nblocks: [browser.assert_journey]\n",
          blockSources: { "browser.assert_journey": blockSource },
        },
        { kind: "workspace", source: "test" },
      );
      await approveInstalledPack(
        packRoot,
        "browser-checks",
        "1.0.0",
        "reviewer",
        new Date("2026-07-28T00:00:00.000Z"),
        active.manifest.contentHash,
      );
      await fx.store.packManifests.put({ ...active.manifest, approvalStatus: "approved" });

      const candidate = await persistInstalledPack(
        packRoot,
        {
          manifestYaml: "name: browser-checks\nversion: 2.0.0\nblocks: [browser.assert_journey]\n",
          blockSources: {
            "browser.assert_journey": blockSource.replace('version: "1.0.0"', 'version: "2.0.0"'),
          },
        },
        { kind: "workspace", source: "test" },
      );
      await fx.store.packManifests.put(candidate.manifest);
      await fx.store.workflows.put(
        baseWorkflow({
          id: "journey-wf",
          version: "1",
          execution: {
            type: "workflow",
            steps: [{ id: "assert", uses: "browser.assert_journey", with: {} }],
          },
        }),
      );

      const bundle = await produceBundle(fx.store, {
        workflowId: "journey-wf",
        workflowVersion: "1",
        packRoot,
      });
      expect(bundle.packs["browser-checks@1.0.0"]).toBeDefined();
      expect(bundle.packs["browser-checks@2.0.0"]).toBeUndefined();
      expect(bundle.manifest.packs).toContainEqual({
        name: "browser-checks",
        version: "1.0.0",
        contentHash: active.manifest.contentHash,
        assets: true,
      });
    } finally {
      await fs.rm(packRoot, { recursive: true, force: true });
    }
  });

  it("does NOT include a pack manifest for a core built-in namespace (browser.*) with no registered PackManifest", async () => {
    fx = await createTestFixture();
    await setUpTwoLevelFixture(fx);
    const bundle = await produceBundle(fx.store, { workflowId: "root-wf", workflowVersion: "1" });
    expect(Object.keys(bundle.packs)).not.toContain(expect.stringContaining("browser"));
  });

  it("includes prompt/schema registry entries reached only through the THIRD level (grandchild)", async () => {
    fx = await createTestFixture();
    await setUpTwoLevelFixture(fx);
    const bundle = await produceBundle(fx.store, { workflowId: "root-wf", workflowVersion: "1" });
    expect(bundle.registry.prompts["extract-prompt@3"]).toBeDefined();
    expect(bundle.registry.schemas["extract-schema@2"]).toBeDefined();
  });

  it("resolves 'latest' when no version is pinned", async () => {
    fx = await createTestFixture();
    await fx.store.workflows.put(baseWorkflow({ id: "wf-latest", version: "1", execution: { type: "workflow", steps: [] } }));
    await fx.store.workflows.put(baseWorkflow({ id: "wf-latest", version: "2", execution: { type: "workflow", steps: [] } }));
    const bundle = await produceBundle(fx.store, { workflowId: "wf-latest" });
    expect(bundle.manifest.workflowVersion).toBe("2");
  });

  it("throws a clear error when the root workflow doesn't exist", async () => {
    fx = await createTestFixture();
    await expect(produceBundle(fx.store, { workflowId: "does-not-exist", workflowVersion: "1" })).rejects.toThrow(/not found/);
  });

  it("guards against infinite recursion on a workflow cycle", async () => {
    fx = await createTestFixture();
    await fx.store.workflows.put(baseWorkflow({ id: "wf-a", version: "1", execution: { type: "workflow", steps: [{ id: "s", uses: "flow.subworkflow", with: { workflowId: "wf-b", version: "1" } }] } }));
    await fx.store.workflows.put(baseWorkflow({ id: "wf-b", version: "1", execution: { type: "workflow", steps: [{ id: "s", uses: "flow.subworkflow", with: { workflowId: "wf-a", version: "1" } }] } }));
    const bundle = await produceBundle(fx.store, { workflowId: "wf-a", workflowVersion: "1" });
    expect(Object.keys(bundle.definitions).sort()).toEqual(["wf-a@1", "wf-b@1"]);
  });

  it("bundleHash is deterministic for the same logical bundle", async () => {
    fx = await createTestFixture();
    await setUpTwoLevelFixture(fx);
    const a = await produceBundle(fx.store, { workflowId: "root-wf", workflowVersion: "1" });
    const b = await produceBundle(fx.store, { workflowId: "root-wf", workflowVersion: "1" });
    expect(a.manifest.bundleHash).toBe(b.manifest.bundleHash);
  });

  it("bundleHash changes when the closure's content changes", async () => {
    fx = await createTestFixture();
    await setUpTwoLevelFixture(fx);
    const before = await produceBundle(fx.store, { workflowId: "root-wf", workflowVersion: "1" });
    await fx.store.promptRegistry.put({ name: "extract-prompt", version: "4", contentHash: "hash-p4", body: "Extract the fields, revised." });
    await fx.store.workflows.put(
      baseWorkflow({ id: "grandchild-wf", version: "1", execution: { type: "workflow", steps: [{ id: "extract", uses: "llm.extract", with: { promptRef: "extract-prompt", schemaRef: "extract-schema" } }] } }),
    );
    const after = await produceBundle(fx.store, { workflowId: "root-wf", workflowVersion: "1" });
    expect(after.manifest.bundleHash).not.toBe(before.manifest.bundleHash);
    expect(after.registry.prompts["extract-prompt@4"]).toBeDefined();
  });

  // D1 "remotes + push" (AMENDMENTS.md A56).
  describe("manifest.targetEnvironment", () => {
    it("records the given targetEnvironment on the manifest", async () => {
      fx = await createTestFixture();
      await fx.store.workflows.put(baseWorkflow({ id: "wf-env", version: "1" }));
      const bundle = await produceBundle(fx.store, { workflowId: "wf-env", workflowVersion: "1", targetEnvironment: "production" });
      expect(bundle.manifest.targetEnvironment).toBe("production");
    });

    it("omits targetEnvironment entirely when not given — matches every pre-D1 bundle byte-for-byte", async () => {
      fx = await createTestFixture();
      await fx.store.workflows.put(baseWorkflow({ id: "wf-no-env", version: "1" }));
      const bundle = await produceBundle(fx.store, { workflowId: "wf-no-env", workflowVersion: "1" });
      expect(bundle.manifest.targetEnvironment).toBeUndefined();
      expect(Object.keys(bundle.manifest)).not.toContain("targetEnvironment");
    });

    it("is independent of `deployment` — a caller may name a real target environment with no Deployment for this workflow", async () => {
      fx = await createTestFixture();
      await fx.store.workflows.put(baseWorkflow({ id: "wf-bare-env", version: "1" }));
      const bundle = await produceBundle(fx.store, { workflowId: "wf-bare-env", workflowVersion: "1", targetEnvironment: "staging" });
      expect(bundle.manifest.targetEnvironment).toBe("staging");
      expect(bundle.triggers).toEqual({}); // no deployment given -> no triggerConfig, exactly as before this field existed
    });

    it("round-trips through a real bundleHash computation deterministically (targetEnvironment is part of the hashed manifest)", async () => {
      fx = await createTestFixture();
      await fx.store.workflows.put(baseWorkflow({ id: "wf-env-hash", version: "1" }));
      const withEnv = await produceBundle(fx.store, { workflowId: "wf-env-hash", workflowVersion: "1", targetEnvironment: "production" });
      const withoutEnv = await produceBundle(fx.store, { workflowId: "wf-env-hash", workflowVersion: "1" });
      expect(withEnv.manifest.bundleHash).not.toBe(withoutEnv.manifest.bundleHash);
      const withEnvAgain = await produceBundle(fx.store, { workflowId: "wf-env-hash", workflowVersion: "1", targetEnvironment: "production" });
      expect(withEnvAgain.manifest.bundleHash).toBe(withEnv.manifest.bundleHash);
    });
  });
});

describe("writeBundleToDisk — architecture §0.3's documented layout", () => {
  it("writes manifest.json, definitions/, packs/, registry/{prompts,schemas}/, triggers.json", async () => {
    fx = await createTestFixture();
    await setUpTwoLevelFixture(fx);
    const bundle = await produceBundle(fx.store, {
      workflowId: "root-wf",
      workflowVersion: "1",
      deployment: { id: "dep_1", workflowId: "root-wf", workflowVersion: "1", environmentId: "env_1", triggerConfig: { type: "schedule", cron: "0 9 * * 1" }, createdAt: new Date().toISOString() },
    });
    const outDir = await fs.mkdtemp(join(tmpdir(), "aart-bundle-out-"));
    try {
      await writeBundleToDisk(bundle, outDir);
      const manifest = JSON.parse(await fs.readFile(join(outDir, "manifest.json"), "utf8"));
      expect(manifest.workflowId).toBe("root-wf");
      const triggers = JSON.parse(await fs.readFile(join(outDir, "triggers.json"), "utf8"));
      expect(triggers).toEqual({ type: "schedule", cron: "0 9 * * 1" });
      const definitionFiles = await fs.readdir(join(outDir, "definitions"));
      expect(definitionFiles.length).toBe(3);
      const packFiles = await fs.readdir(join(outDir, "packs"));
      expect(packFiles.length).toBe(1);
      const promptFiles = await fs.readdir(join(outDir, "registry", "prompts"));
      expect(promptFiles.length).toBe(1);
      const schemaFiles = await fs.readdir(join(outDir, "registry", "schemas"));
      expect(schemaFiles.length).toBe(1);
    } finally {
      await fs.rm(outDir, { recursive: true, force: true });
    }
  });
});
