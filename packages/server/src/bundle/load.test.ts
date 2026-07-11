// load.ts — the bundle-consuming half (S12 "deploy story", AMENDMENTS.md).
// Mirrors bundle.test.ts's own fixture style (createTestFixture,
// baseWorkflow) — a bundle round-trips through TWO independent stores here
// (a "laptop" fixture that produces it, a "server" fixture that hydrates
// it), matching how this is actually used in practice.
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Workflow } from "@aart/types";
import { loadTriggerBindingsFromDeployments } from "../triggers/registry.js";
import { createTestFixture, type TestFixture } from "../test-helpers.js";
import { produceBundle, writeBundleToDisk } from "./bundle.js";
import { hydrateBundle, hydrateBundleFromDisk, readBundleFromDisk, verifyBundleHash } from "./load.js";

let laptop: TestFixture | undefined;
let server: TestFixture | undefined;
let outDir: string | undefined;

afterEach(async () => {
  await laptop?.cleanup();
  await server?.cleanup();
  laptop = undefined;
  server = undefined;
  if (outDir) await fs.rm(outDir, { recursive: true, force: true });
  outDir = undefined;
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

describe("readBundleFromDisk / hydrateBundle — round-trip (S12)", () => {
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
