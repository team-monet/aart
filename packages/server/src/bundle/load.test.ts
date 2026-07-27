// load.ts — the bundle-consuming half (S12 "deploy story", AMENDMENTS.md).
// Mirrors bundle.test.ts's own fixture style (createTestFixture,
// baseWorkflow) — a bundle round-trips through TWO independent stores here
// (a "laptop" fixture that produces it, a "server" fixture that hydrates
// it), matching how this is actually used in practice.
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  approveInstalledPack,
  loadInstalledPackBlocksSync,
  persistInstalledPack,
  readInstalledPackSync,
} from "@aart/registry";
import type { Workflow } from "@aart/types";
import { loadTriggerBindingsFromDeployments } from "../triggers/registry.js";
import { createTestFixture, type TestFixture } from "../test-helpers.js";
import { produceBundle, sanitizeFilename, writeBundleToDisk, type Bundle } from "./bundle.js";
import { hydrateBundle, hydrateBundleFromDisk, readBundleFromDisk, readBundleFromEnvelope, verifyBundleHash } from "./load.js";

let laptop: TestFixture | undefined;
let server: TestFixture | undefined;
let outDir: string | undefined;
const packRoots: string[] = [];

afterEach(async () => {
  await laptop?.cleanup();
  await server?.cleanup();
  laptop = undefined;
  server = undefined;
  if (outDir) await fs.rm(outDir, { recursive: true, force: true });
  outDir = undefined;
  await Promise.all(packRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const approvedGates = { validate: "passed" as const, readiness: "passed" as const, evals: "passed" as const, riskReview: "passed" as const, humanReview: "passed" as const };

function baseWorkflow(overrides: Partial<Workflow>): Workflow {
  return { id: "wf", name: "n", version: "1", inputs: [], outputs: [], execution: { type: "workflow", steps: [] }, approval: "approved", gates: approvedGates, ...overrides };
}

/** Two levels of nested-workflow references, a pack-delivered block, and an llm.* prompt/schema ref — the same fixture shape bundle.test.ts uses for produceBundle's own closure test, reused here so the loader is proven against a bundle with every definition category populated, not just a trivial one-workflow bundle. */
async function setUpTwoLevelFixture(fx: TestFixture): Promise<void> {
  await fx.store.workflows.put(
    baseWorkflow({
      id: "grandchild-wf",
      version: "1",
      execution: { type: "workflow", steps: [{ id: "extract", uses: "llm.extract", with: { promptRef: "extract-prompt", schemaRef: "extract-schema" } }] },
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
          { id: "click", uses: "browser.click", with: {} },
          { id: "nested1", uses: "flow.subworkflow", with: { workflowId: "child-wf", version: "1" } },
        ],
      },
    }),
  );
  await fx.store.packManifests.put({ name: "github", version: "2.0.0", contentHash: "hash-gh-2", manifest: { blocks: ["create_comment"] }, approvalStatus: "approved" });
  await fx.store.promptRegistry.put({ name: "extract-prompt", version: "3", contentHash: "hash-p3", body: "Extract the fields." });
  await fx.store.schemaRegistry.put({ name: "extract-schema", version: "2", contentHash: "hash-s2", jsonSchema: { type: "object" } });
}

async function produceAndWrite(fx: TestFixture, params: Parameters<typeof produceBundle>[1]): Promise<string> {
  const bundle = await produceBundle(fx.store, params);
  const dir = await fs.mkdtemp(join(tmpdir(), "aart-bundle-load-test-"));
  await writeBundleToDisk(bundle, dir);
  return dir;
}

/**
 * D1 "remotes + push" (AMENDMENTS.md A56) — a local, test-only mirror of
 * `bundleToBundleLike`'s file-flattening (`@aart/cli`'s `real-server-port.ts`)
 * for exercising `readBundleFromEnvelope` in isolation, WITHOUT this
 * package taking a (backwards — @aart/server must never depend on
 * @aart/cli) dependency on that sibling package's implementation. Same
 * on-disk-equivalent layout `writeBundleToDisk` uses, just as an in-memory
 * `Record<relPath, string>` instead of real files — the exact envelope shape
 * `POST /bundles/ingest`/`POST /bundles/plan` receive as their request body.
 */
function bundleToFiles(bundle: Bundle): Record<string, string> {
  const files: Record<string, string> = {
    "manifest.json": JSON.stringify(bundle.manifest, null, 2),
    "triggers.json": JSON.stringify(bundle.triggers, null, 2),
  };
  for (const [key, workflow] of Object.entries(bundle.definitions)) files[`definitions/${sanitizeFilename(key)}.json`] = JSON.stringify(workflow, null, 2);
  for (const [key, manifest] of Object.entries(bundle.packs)) files[`packs/${sanitizeFilename(key)}.json`] = JSON.stringify(manifest, null, 2);
  for (const [key, assets] of Object.entries(bundle.packAssets ?? {})) files[`pack-assets/${sanitizeFilename(key)}.json`] = JSON.stringify(assets, null, 2);
  for (const [key, entry] of Object.entries(bundle.registry.prompts)) files[`registry/prompts/${sanitizeFilename(key)}.json`] = JSON.stringify(entry, null, 2);
  for (const [key, entry] of Object.entries(bundle.registry.schemas)) files[`registry/schemas/${sanitizeFilename(key)}.json`] = JSON.stringify(entry, null, 2);
  return files;
}

describe("readBundleFromDisk / hydrateBundle — round-trip (S12)", () => {
  it("ships sealed Pack code and restores an executable approved Pack on a fresh destination root", async () => {
    laptop = await createTestFixture();
    server = await createTestFixture();
    const sourceRoot = await fs.mkdtemp(join(tmpdir(), "aart-bundle-pack-source-"));
    const destinationRoot = await fs.mkdtemp(join(tmpdir(), "aart-bundle-pack-destination-"));
    packRoots.push(sourceRoot, destinationRoot);
    const source = `module.exports = {
      manifest: {
        id: "demo.echo",
        version: "1.0.0",
        capabilities: [],
        inputSchema: {},
        outputSchema: {},
        description: "Echo a value"
      },
      execute: (input) => ({ value: input.value })
    };`;
    const installed = await persistInstalledPack(
      sourceRoot,
      {
        manifestYaml: "name: demo\nversion: 1.0.0\nblocks: [demo.echo]\n",
        blockSources: { "demo.echo": source },
      },
      { kind: "workspace", source: "test" },
    );
    await approveInstalledPack(
      sourceRoot,
      "demo",
      "1.0.0",
      "reviewer",
      new Date("2026-07-27T00:00:00.000Z"),
      installed.manifest.contentHash,
    );
    await laptop.store.packManifests.put({ ...installed.manifest, approvalStatus: "approved" });
    await laptop.store.workflows.put(
      baseWorkflow({
        id: "pack-wf",
        version: "1",
        execution: { type: "workflow", steps: [{ id: "echo", uses: "demo.echo", with: { value: "hello" } }] },
      }),
    );

    const bundle = await produceBundle(laptop.store, {
      workflowId: "pack-wf",
      workflowVersion: "1",
      packRoot: sourceRoot,
    });
    expect(bundle.manifest.packs).toContainEqual({
      name: "demo",
      version: "1.0.0",
      contentHash: installed.manifest.contentHash,
      assets: true,
    });
    expect(bundle.packAssets?.["demo@1.0.0"]?.blockSources["demo.echo"]).toBe(source);

    outDir = await fs.mkdtemp(join(tmpdir(), "aart-bundle-pack-out-"));
    await writeBundleToDisk(bundle, outDir);
    await hydrateBundleFromDisk(server.store, outDir, server.clock, destinationRoot);

    expect(readInstalledPackSync(destinationRoot, "demo", "1.0.0").state).toMatchObject({
      approvalStatus: "approved",
      contentHash: installed.manifest.contentHash,
    });
    const [implementation] = loadInstalledPackBlocksSync(destinationRoot, "demo", "1.0.0");
    await expect(
      implementation!.execute(
        { value: "hello" },
        {
          runId: "run",
          stepId: "echo",
          resolveSecret: async () => "secret",
          writeArtifact: async () => ({ id: "artifact", path: "/tmp/artifact" }),
        },
      ),
    ).resolves.toEqual({ value: "hello" });
  });

  it("a bundle produced on one store hydrates every definition category into a completely different store, verbatim", async () => {
    laptop = await createTestFixture();
    await setUpTwoLevelFixture(laptop);
    outDir = await produceAndWrite(laptop, { workflowId: "root-wf", workflowVersion: "1" });

    server = await createTestFixture();
    const result = await hydrateBundleFromDisk(server.store, outDir);
    expect(result.kind).toBe("hydrated");
    expect(result).toMatchObject({ workflowId: "root-wf", workflowVersion: "1" });

    // Every workflow in the 3-level closure landed, not just the root.
    for (const [id, version] of [
      ["root-wf", "1"],
      ["child-wf", "1"],
      ["grandchild-wf", "1"],
    ]) {
      const workflow = await server.store.workflows.get(id!, version!);
      expect(workflow, `${id}@${version} should be hydrated`).toBeDefined();
      // Approval-consistent with what was bundled — preserved verbatim, not re-derived.
      expect(workflow?.approval).toBe("approved");
      expect(workflow?.gates).toEqual(approvedGates);
    }
    expect(await server.store.packManifests.get("github", "2.0.0")).toBeDefined();
    expect(await server.store.promptRegistry.get("extract-prompt", "3")).toBeDefined();
    expect(await server.store.schemaRegistry.get("extract-schema", "2")).toBeDefined();

    // Runtime state is untouched by hydration — a bundle seeds a store, it
    // doesn't replace one (no runs/waits/etc. member is even touched).
    expect(await server.store.runs.list()).toEqual([]);
  });

  it("the bundle's triggers.json becomes the real trigger source — loadTriggerBindingsFromDeployments picks it up after hydration", async () => {
    laptop = await createTestFixture();
    await laptop.store.workflows.put(baseWorkflow({ id: "triggered-wf", version: "1" }));
    const deployment = { id: "dep_1", workflowId: "triggered-wf", workflowVersion: "1", environmentId: "env_prod", triggerConfig: { type: "webhook" as const, mode: "start" as const, webhookPath: "/hooks/triggered-wf" }, createdAt: new Date().toISOString() };
    outDir = await produceAndWrite(laptop, { workflowId: "triggered-wf", workflowVersion: "1", deployment });

    server = await createTestFixture();
    await hydrateBundleFromDisk(server.store, outDir);

    const bindings = await loadTriggerBindingsFromDeployments(server.store);
    const binding = bindings.find((b) => b.workflowId === "triggered-wf");
    expect(binding).toBeDefined();
    expect(binding).toMatchObject({ type: "webhook", workflowId: "triggered-wf", workflowVersion: "1", webhookPath: "/hooks/triggered-wf", mode: "start" });
  });

  it("a bare bundle (no deployment at produce time) hydrates an empty triggerConfig — no trigger fires, not an error", async () => {
    laptop = await createTestFixture();
    await laptop.store.workflows.put(baseWorkflow({ id: "bare-wf", version: "1" }));
    outDir = await produceAndWrite(laptop, { workflowId: "bare-wf", workflowVersion: "1" });

    server = await createTestFixture();
    await hydrateBundleFromDisk(server.store, outDir);
    const bindings = await loadTriggerBindingsFromDeployments(server.store);
    expect(bindings.find((b) => b.workflowId === "bare-wf")).toBeUndefined();
  });
});

describe("hydrateBundle — idempotent re-hydrate / conflicting-hash refusal (S12)", () => {
  it("hydrating the exact same bundle (same bundleHash) twice is a no-op the second time", async () => {
    laptop = await createTestFixture();
    await laptop.store.workflows.put(baseWorkflow({ id: "idem-wf", version: "1" }));
    outDir = await produceAndWrite(laptop, { workflowId: "idem-wf", workflowVersion: "1" });

    server = await createTestFixture();
    const first = await hydrateBundleFromDisk(server.store, outDir);
    expect(first.kind).toBe("hydrated");

    const second = await hydrateBundleFromDisk(server.store, outDir);
    expect(second.kind).toBe("already_hydrated");
    expect(second.bundleHash).toBe(first.bundleHash);
    expect(second.deploymentId).toBe(first.deploymentId);
  });

  it("hydrating a DIFFERENT bundle for the SAME workflow@version throws and does not silently overwrite", async () => {
    laptop = await createTestFixture();
    await laptop.store.workflows.put(baseWorkflow({ id: "conflict-wf", version: "1", name: "version A" }));
    const dirA = await produceAndWrite(laptop, { workflowId: "conflict-wf", workflowVersion: "1" });

    // A DIFFERENT bundleHash for the identical workflowId@workflowVersion —
    // simulates re-bundling after the definition changed without bumping
    // its version (workflow versions are meant to be immutable elsewhere in
    // this system, but the loader must not blindly trust that from a bundle
    // directory it didn't produce itself).
    await laptop.store.workflows.put(baseWorkflow({ id: "conflict-wf", version: "1", name: "version B (different content, same id@version)" }));
    const dirB = await produceAndWrite(laptop, { workflowId: "conflict-wf", workflowVersion: "1" });

    server = await createTestFixture();
    await hydrateBundleFromDisk(server.store, dirA);
    const beforeConflict = await server.store.workflows.get("conflict-wf", "1");
    expect(beforeConflict?.name).toBe("version A");

    await expect(hydrateBundleFromDisk(server.store, dirB)).rejects.toThrow(/already hydrated.*different bundle/i);

    // Refused, not silently overwritten — the store still has version A's content.
    const afterConflict = await server.store.workflows.get("conflict-wf", "1");
    expect(afterConflict?.name).toBe("version A");

    if (dirA) await fs.rm(dirA, { recursive: true, force: true });
    if (dirB) await fs.rm(dirB, { recursive: true, force: true });
  });

  it("hydrating the SAME workflow@version under a DIFFERENT root workflowId is unaffected — the idempotency marker is per-bundle, not global", async () => {
    laptop = await createTestFixture();
    await laptop.store.workflows.put(baseWorkflow({ id: "wf-x", version: "1" }));
    await laptop.store.workflows.put(baseWorkflow({ id: "wf-y", version: "1" }));
    const dirX = await produceAndWrite(laptop, { workflowId: "wf-x", workflowVersion: "1" });
    const dirY = await produceAndWrite(laptop, { workflowId: "wf-y", workflowVersion: "1" });

    server = await createTestFixture();
    const resultX = await hydrateBundleFromDisk(server.store, dirX);
    const resultY = await hydrateBundleFromDisk(server.store, dirY);
    expect(resultX.kind).toBe("hydrated");
    expect(resultY.kind).toBe("hydrated");
    expect(resultX.deploymentId).not.toBe(resultY.deploymentId);

    if (dirX) await fs.rm(dirX, { recursive: true, force: true });
    if (dirY) await fs.rm(dirY, { recursive: true, force: true });
  });
});

describe("readBundleFromDisk — hash-mismatch rejection (S12)", () => {
  it("throws loudly when a definition file is modified after the bundle was produced", async () => {
    laptop = await createTestFixture();
    await laptop.store.workflows.put(baseWorkflow({ id: "tamper-wf", version: "1" }));
    outDir = await produceAndWrite(laptop, { workflowId: "tamper-wf", workflowVersion: "1" });

    const defPath = join(outDir, "definitions", "tamper-wf@1.json");
    const original = JSON.parse(await fs.readFile(defPath, "utf8")) as Workflow;
    await fs.writeFile(defPath, JSON.stringify({ ...original, name: "tampered after sealing" }, null, 2));

    await expect(readBundleFromDisk(outDir)).rejects.toThrow(/bundleHash mismatch/i);
  });

  it("throws loudly when manifest.json's own bundleHash field is edited directly", async () => {
    laptop = await createTestFixture();
    await laptop.store.workflows.put(baseWorkflow({ id: "tamper-manifest-wf", version: "1" }));
    outDir = await produceAndWrite(laptop, { workflowId: "tamper-manifest-wf", workflowVersion: "1" });

    const manifestPath = join(outDir, "manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as { bundleHash: string };
    await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, bundleHash: "0".repeat(64) }, null, 2));

    await expect(readBundleFromDisk(outDir)).rejects.toThrow(/bundleHash mismatch/i);
  });

  it("hydrateBundle itself also refuses a tampered in-memory Bundle (defense in depth, not only readBundleFromDisk)", async () => {
    laptop = await createTestFixture();
    await laptop.store.workflows.put(baseWorkflow({ id: "tamper-inmem-wf", version: "1" }));
    const bundle = await produceBundle(laptop.store, { workflowId: "tamper-inmem-wf", workflowVersion: "1" });
    const tampered = { ...bundle, definitions: { ...bundle.definitions, "tamper-inmem-wf@1": { ...bundle.definitions["tamper-inmem-wf@1"]!, name: "tampered" } } };

    expect(() => verifyBundleHash(tampered)).toThrow(/bundleHash mismatch/i);
    server = await createTestFixture();
    await expect(hydrateBundle(server.store, tampered)).rejects.toThrow(/bundleHash mismatch/i);
  });
});

describe("readBundleFromDisk — schema validation / structural errors (S12)", () => {
  it("throws a clear, aggregated error when a definition file fails WorkflowSchema validation", async () => {
    laptop = await createTestFixture();
    await laptop.store.workflows.put(baseWorkflow({ id: "invalid-wf", version: "1" }));
    outDir = await produceAndWrite(laptop, { workflowId: "invalid-wf", workflowVersion: "1" });

    // Corrupt the definition file post-hoc with something that will not
    // pass WorkflowSchema (missing "execution") — recompute nothing, so
    // this ALSO changes the hash; to isolate the schema-validation path
    // specifically (not the (already-covered) hash-mismatch path), assert
    // on the actual error rather than a specific message substring — a
    // corrupted bundle fails LOUDLY either way, which is what matters here.
    const defPath = join(outDir, "definitions", "invalid-wf@1.json");
    await fs.writeFile(defPath, JSON.stringify({ id: "invalid-wf", version: "1" }, null, 2));

    await expect(readBundleFromDisk(outDir)).rejects.toThrow();
  });

  it("throws a clear error when an expected definition file is missing entirely", async () => {
    laptop = await createTestFixture();
    await setUpTwoLevelFixture(laptop);
    outDir = await produceAndWrite(laptop, { workflowId: "root-wf", workflowVersion: "1" });

    await fs.rm(join(outDir, "definitions", "child-wf@1.json"));

    await expect(readBundleFromDisk(outDir)).rejects.toThrow(/cannot read workflow definition/i);
  });

  it("throws a clear error for an unsupported manifest schemaVersion", async () => {
    laptop = await createTestFixture();
    await laptop.store.workflows.put(baseWorkflow({ id: "future-wf", version: "1" }));
    outDir = await produceAndWrite(laptop, { workflowId: "future-wf", workflowVersion: "1" });

    const manifestPath = join(outDir, "manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as Record<string, unknown>;
    // schemaVersion is a z.literal(1) — Zod itself rejects anything else at
    // the manifest-parse step, before this function's own explicit
    // (redundant, belt-and-suspenders) schemaVersion===1 check ever runs.
    await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, schemaVersion: 2 }, null, 2));

    await expect(readBundleFromDisk(outDir)).rejects.toThrow();
  });
});

// D1 "remotes + push" (AMENDMENTS.md A56) — readBundleFromEnvelope mirrors
// EVERY readBundleFromDisk failure mode above (missing file, invalid JSON,
// hash mismatch, schema failure) with the identical error shape, since both
// are the SAME readBundleFromSource core (load.ts) fed a different
// BundleSource. Each test below is the direct envelope-shaped counterpart
// of one disk-shaped test above, in the same order.
describe("readBundleFromEnvelope — mirrors readBundleFromDisk's failure modes (AMENDMENTS.md A56)", () => {
  it("a bundle produced then flattened to an envelope round-trips identically to the disk-read Bundle", async () => {
    laptop = await createTestFixture();
    await setUpTwoLevelFixture(laptop);
    const produced = await produceBundle(laptop.store, { workflowId: "root-wf", workflowVersion: "1" });
    const files = bundleToFiles(produced);

    const fromEnvelope = await readBundleFromEnvelope(files);
    expect(fromEnvelope).toEqual(produced);
  });

  it("throws a clear, aggregated error when a definition entry fails WorkflowSchema validation", async () => {
    laptop = await createTestFixture();
    await laptop.store.workflows.put(baseWorkflow({ id: "invalid-wf-env", version: "1" }));
    const produced = await produceBundle(laptop.store, { workflowId: "invalid-wf-env", workflowVersion: "1" });
    const files = bundleToFiles(produced);
    // Corrupt the definition entry post-hoc with something that will not
    // pass WorkflowSchema (missing "execution") — same corruption
    // load.test.ts's disk-mode counterpart applies.
    files["definitions/invalid-wf-env@1.json"] = JSON.stringify({ id: "invalid-wf-env", version: "1" });

    await expect(readBundleFromEnvelope(files)).rejects.toThrow();
  });

  it("throws a clear error when an expected definition entry is missing entirely from the envelope", async () => {
    laptop = await createTestFixture();
    await setUpTwoLevelFixture(laptop);
    const produced = await produceBundle(laptop.store, { workflowId: "root-wf", workflowVersion: "1" });
    const files = bundleToFiles(produced);
    delete files["definitions/child-wf@1.json"];

    await expect(readBundleFromEnvelope(files)).rejects.toThrow(/cannot read workflow definition/i);
  });

  it("throws a clear error for an unsupported manifest schemaVersion", async () => {
    laptop = await createTestFixture();
    await laptop.store.workflows.put(baseWorkflow({ id: "future-wf-env", version: "1" }));
    const produced = await produceBundle(laptop.store, { workflowId: "future-wf-env", workflowVersion: "1" });
    const files = bundleToFiles(produced);
    const manifest = JSON.parse(files["manifest.json"]!) as Record<string, unknown>;
    files["manifest.json"] = JSON.stringify({ ...manifest, schemaVersion: 2 });

    await expect(readBundleFromEnvelope(files)).rejects.toThrow();
  });

  it("throws loudly when a definition entry is modified after the bundle was produced (bundleHash mismatch)", async () => {
    laptop = await createTestFixture();
    await laptop.store.workflows.put(baseWorkflow({ id: "tamper-wf-env", version: "1" }));
    const produced = await produceBundle(laptop.store, { workflowId: "tamper-wf-env", workflowVersion: "1" });
    const files = bundleToFiles(produced);
    const original = JSON.parse(files["definitions/tamper-wf-env@1.json"]!) as Workflow;
    files["definitions/tamper-wf-env@1.json"] = JSON.stringify({ ...original, name: "tampered after sealing" });

    await expect(readBundleFromEnvelope(files)).rejects.toThrow(/bundleHash mismatch/i);
  });

  it("throws loudly when the envelope's own manifest.bundleHash field is edited directly", async () => {
    laptop = await createTestFixture();
    await laptop.store.workflows.put(baseWorkflow({ id: "tamper-manifest-wf-env", version: "1" }));
    const produced = await produceBundle(laptop.store, { workflowId: "tamper-manifest-wf-env", workflowVersion: "1" });
    const files = bundleToFiles(produced);
    const manifest = JSON.parse(files["manifest.json"]!) as { bundleHash: string };
    files["manifest.json"] = JSON.stringify({ ...manifest, bundleHash: "0".repeat(64) });

    await expect(readBundleFromEnvelope(files)).rejects.toThrow(/bundleHash mismatch/i);
  });

  it("a malformed (non-JSON) entry throws 'is not valid JSON', not a generic parse crash", async () => {
    laptop = await createTestFixture();
    await laptop.store.workflows.put(baseWorkflow({ id: "malformed-wf-env", version: "1" }));
    const produced = await produceBundle(laptop.store, { workflowId: "malformed-wf-env", workflowVersion: "1" });
    const files = bundleToFiles(produced);
    files["manifest.json"] = "{ this is not valid JSON";

    await expect(readBundleFromEnvelope(files)).rejects.toThrow(/manifest\.json.*is not valid JSON/i);
  });
});

// D1 "remotes + push" (AMENDMENTS.md A56) — real-environment hydration:
// manifest.targetEnvironment resolves against an ALREADY-REGISTERED
// Environment on the destination store (never auto-vivified), lands the
// resulting Deployment under an env-scoped key + the real environmentId,
// and stamps `promoted` from that environment's own trust mode.
describe("hydrateBundle — real targetEnvironment resolution (AMENDMENTS.md A56)", () => {
  it("throws a clear, actionable error when the named environment is not registered on the destination store", async () => {
    laptop = await createTestFixture();
    await laptop.store.workflows.put(baseWorkflow({ id: "wf-unregistered-env", version: "1" }));
    outDir = await produceAndWrite(laptop, { workflowId: "wf-unregistered-env", workflowVersion: "1", targetEnvironment: "production" });

    server = await createTestFixture();
    // Deliberately NOT registering "production" on the server store first.
    await expect(hydrateBundleFromDisk(server.store, outDir)).rejects.toThrow(/target environment "production" is not registered/i);
    // The remedy is actionable, not just an error label.
    await expect(hydrateBundleFromDisk(server.store, outDir)).rejects.toThrow(/aart environment register|POST \/environments/i);
    // No auto-vivification: refusing left no environment named "production" behind.
    await expect(server.store.environments.getByName("production")).resolves.toBeUndefined();
  });

  it("hydrates into the REAL registered environment — env-scoped deploymentId, real environmentId, no synthetic env_bundle row created", async () => {
    laptop = await createTestFixture();
    await laptop.store.workflows.put(baseWorkflow({ id: "wf-real-env", version: "1" }));
    outDir = await produceAndWrite(laptop, { workflowId: "wf-real-env", workflowVersion: "1", targetEnvironment: "staging" });

    server = await createTestFixture();
    await server.store.environments.put({ id: "env_real_staging", name: "staging", config: { trustMode: "governed" } });
    const result = await hydrateBundleFromDisk(server.store, outDir);

    expect(result.kind).toBe("hydrated");
    expect(result.deploymentId).toBe("bundle:wf-real-env@1:env_real_staging"); // env-scoped, resolved id not name
    const deployment = await server.store.deployments.get(result.deploymentId);
    expect(deployment?.environmentId).toBe("env_real_staging");
    // No synthetic env_bundle row was created for this real-target hydration.
    await expect(server.store.environments.getByName("bundle")).resolves.toBeUndefined();
  });

  it("promoted:true when the target environment's trust mode is dev (no required gates — immediately live)", async () => {
    laptop = await createTestFixture();
    await laptop.store.workflows.put(baseWorkflow({ id: "wf-dev-env", version: "1" }));
    outDir = await produceAndWrite(laptop, { workflowId: "wf-dev-env", workflowVersion: "1", targetEnvironment: "sandbox" });

    server = await createTestFixture();
    await server.store.environments.put({ id: "env_sandbox", name: "sandbox", config: { trustMode: "dev" } });
    const result = await hydrateBundleFromDisk(server.store, outDir);
    const deployment = await server.store.deployments.get(result.deploymentId);
    expect(deployment?.promoted).toBe(true);
  });

  it.each(["governed", "strict", "production"] as const)("promoted:false when the target environment's trust mode is %s — evidence recorded, awaiting promotion", async (trustMode) => {
    laptop = await createTestFixture();
    await laptop.store.workflows.put(baseWorkflow({ id: `wf-${trustMode}-env`, version: "1" }));
    outDir = await produceAndWrite(laptop, { workflowId: `wf-${trustMode}-env`, workflowVersion: "1", targetEnvironment: "gated" });

    server = await createTestFixture();
    await server.store.environments.put({ id: `env_${trustMode}`, name: "gated", config: { trustMode } });
    const result = await hydrateBundleFromDisk(server.store, outDir);
    const deployment = await server.store.deployments.get(result.deploymentId);
    expect(deployment?.promoted).toBe(false);
    // ...and the chokepoint actually honors it: no trigger binding is produced.
    const bindings = await loadTriggerBindingsFromDeployments(server.store);
    expect(bindings.find((b) => b.workflowId === `wf-${trustMode}-env`)).toBeUndefined();
  });

  it("an environment with no config.trustMode at all defaults to governed (promoted:false) — same convention as promotion.ts's requiredGatesForEnvironment", async () => {
    laptop = await createTestFixture();
    await laptop.store.workflows.put(baseWorkflow({ id: "wf-default-trustmode-env", version: "1" }));
    outDir = await produceAndWrite(laptop, { workflowId: "wf-default-trustmode-env", workflowVersion: "1", targetEnvironment: "bare" });

    server = await createTestFixture();
    await server.store.environments.put({ id: "env_bare", name: "bare", config: {} });
    const result = await hydrateBundleFromDisk(server.store, outDir);
    const deployment = await server.store.deployments.get(result.deploymentId);
    expect(deployment?.promoted).toBe(false);
  });
});

describe("hydrateBundle — real-environment idempotency (AMENDMENTS.md A56)", () => {
  it("same (workflow, version, environment) + same bundleHash: no-op the second time", async () => {
    laptop = await createTestFixture();
    await laptop.store.workflows.put(baseWorkflow({ id: "wf-idem-env", version: "1" }));
    outDir = await produceAndWrite(laptop, { workflowId: "wf-idem-env", workflowVersion: "1", targetEnvironment: "staging" });

    server = await createTestFixture();
    await server.store.environments.put({ id: "env_idem_staging", name: "staging", config: { trustMode: "dev" } });
    const first = await hydrateBundleFromDisk(server.store, outDir);
    expect(first.kind).toBe("hydrated");
    const second = await hydrateBundleFromDisk(server.store, outDir);
    expect(second.kind).toBe("already_hydrated");
    expect(second.deploymentId).toBe(first.deploymentId);
  });

  it("same (workflow, version, environment) + DIFFERENT bundleHash: refuses with the existing conflict error shape", async () => {
    laptop = await createTestFixture();
    await laptop.store.workflows.put(baseWorkflow({ id: "wf-conflict-env", version: "1", name: "version A" }));
    const dirA = await produceAndWrite(laptop, { workflowId: "wf-conflict-env", workflowVersion: "1", targetEnvironment: "staging" });
    await laptop.store.workflows.put(baseWorkflow({ id: "wf-conflict-env", version: "1", name: "version B (different content, same id@version)" }));
    const dirB = await produceAndWrite(laptop, { workflowId: "wf-conflict-env", workflowVersion: "1", targetEnvironment: "staging" });

    server = await createTestFixture();
    await server.store.environments.put({ id: "env_conflict_staging", name: "staging", config: { trustMode: "dev" } });
    await hydrateBundleFromDisk(server.store, dirA);
    await expect(hydrateBundleFromDisk(server.store, dirB)).rejects.toThrow(/already hydrated.*different bundle/i);
    const workflow = await server.store.workflows.get("wf-conflict-env", "1");
    expect(workflow?.name).toBe("version A"); // refused, not silently overwritten

    await fs.rm(dirA, { recursive: true, force: true });
    await fs.rm(dirB, { recursive: true, force: true });
  });

  it("same workflow@version hydrated into TWO DIFFERENT real environments: independent rows, both legal, neither refused", async () => {
    laptop = await createTestFixture();
    await laptop.store.workflows.put(baseWorkflow({ id: "wf-multi-env", version: "1" }));
    const dirStaging = await produceAndWrite(laptop, { workflowId: "wf-multi-env", workflowVersion: "1", targetEnvironment: "staging" });
    const dirProd = await produceAndWrite(laptop, { workflowId: "wf-multi-env", workflowVersion: "1", targetEnvironment: "production" });

    server = await createTestFixture();
    await server.store.environments.put({ id: "env_multi_staging", name: "staging", config: { trustMode: "dev" } });
    await server.store.environments.put({ id: "env_multi_prod", name: "production", config: { trustMode: "dev" } });

    const stagingResult = await hydrateBundleFromDisk(server.store, dirStaging);
    const prodResult = await hydrateBundleFromDisk(server.store, dirProd);
    expect(stagingResult.kind).toBe("hydrated");
    expect(prodResult.kind).toBe("hydrated");
    expect(stagingResult.deploymentId).not.toBe(prodResult.deploymentId);
    expect(stagingResult.deploymentId).toBe("bundle:wf-multi-env@1:env_multi_staging");
    expect(prodResult.deploymentId).toBe("bundle:wf-multi-env@1:env_multi_prod");

    await fs.rm(dirStaging, { recursive: true, force: true });
    await fs.rm(dirProd, { recursive: true, force: true });
  });

  it("a real-target hydration and a legacy (no targetEnvironment) hydration of the SAME workflow@version never collide — different key shapes entirely", async () => {
    laptop = await createTestFixture();
    await laptop.store.workflows.put(baseWorkflow({ id: "wf-legacy-vs-real", version: "1" }));
    const dirReal = await produceAndWrite(laptop, { workflowId: "wf-legacy-vs-real", workflowVersion: "1", targetEnvironment: "staging" });
    const dirLegacy = await produceAndWrite(laptop, { workflowId: "wf-legacy-vs-real", workflowVersion: "1" });

    server = await createTestFixture();
    await server.store.environments.put({ id: "env_legacy_vs_real", name: "staging", config: { trustMode: "dev" } });

    const realResult = await hydrateBundleFromDisk(server.store, dirReal);
    const legacyResult = await hydrateBundleFromDisk(server.store, dirLegacy);
    expect(realResult.kind).toBe("hydrated");
    expect(legacyResult.kind).toBe("hydrated"); // NOT already_hydrated — genuinely independent rows
    expect(realResult.deploymentId).toBe("bundle:wf-legacy-vs-real@1:env_legacy_vs_real");
    expect(legacyResult.deploymentId).toBe("bundle:wf-legacy-vs-real@1");

    await fs.rm(dirReal, { recursive: true, force: true });
    await fs.rm(dirLegacy, { recursive: true, force: true });
  });
});
