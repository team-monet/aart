// loadTriggerBindingsFromDeployments's environmentId filter (AMENDMENTS.md
// A45) — fast, store-level coverage of the filter itself; server.test.ts
// covers the full HTTP-level "a scoped server activates exactly one
// binding" proof end to end.
import { afterEach, describe, expect, it } from "vitest";
import { createFsStore, type AartStore } from "@aart/store";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTriggerBindingsFromDeployments } from "./registry.js";

let cleanupPaths: string[] = [];
afterEach(async () => {
  await Promise.all(cleanupPaths.map((p) => fs.rm(p, { recursive: true, force: true })));
  cleanupPaths = [];
});

async function freshStore(): Promise<AartStore> {
  const root = await fs.mkdtemp(join(tmpdir(), "aart-registry-test-"));
  cleanupPaths.push(root);
  return createFsStore(root);
}

describe("loadTriggerBindingsFromDeployments — environmentId filter (AMENDMENTS.md A45)", () => {
  it("omitted filter returns bindings from every environment (unchanged default)", async () => {
    const store = await freshStore();
    await store.deployments.put({
      id: "dep_a",
      workflowId: "wf",
      workflowVersion: "1",
      environmentId: "env_a",
      triggerConfig: { type: "webhook", webhookPath: "/a" },
      createdAt: new Date().toISOString(),
    });
    await store.deployments.put({
      id: "dep_b",
      workflowId: "wf",
      workflowVersion: "1",
      environmentId: "env_b",
      triggerConfig: { type: "webhook", webhookPath: "/b" },
      createdAt: new Date().toISOString(),
    });

    const bindings = await loadTriggerBindingsFromDeployments(store);
    expect(bindings.map((b) => b.id).sort()).toEqual(["dep_a", "dep_b"]);
  });

  it("a given environmentId returns only that environment's deployment-sourced bindings", async () => {
    const store = await freshStore();
    await store.deployments.put({
      id: "dep_a",
      workflowId: "wf",
      workflowVersion: "1",
      environmentId: "env_a",
      triggerConfig: { type: "webhook", webhookPath: "/a" },
      createdAt: new Date().toISOString(),
    });
    await store.deployments.put({
      id: "dep_b",
      workflowId: "wf",
      workflowVersion: "1",
      environmentId: "env_b",
      triggerConfig: { type: "webhook", webhookPath: "/b" },
      createdAt: new Date().toISOString(),
    });

    const scoped = await loadTriggerBindingsFromDeployments(store, { environmentId: "env_a" });
    expect(scoped.map((b) => b.id)).toEqual(["dep_a"]);

    const scopedOther = await loadTriggerBindingsFromDeployments(store, { environmentId: "env_b" });
    expect(scopedOther.map((b) => b.id)).toEqual(["dep_b"]);
  });

  it("an environmentId with no matching deployments returns an empty list, not an error", async () => {
    const store = await freshStore();
    await store.deployments.put({
      id: "dep_a",
      workflowId: "wf",
      workflowVersion: "1",
      environmentId: "env_a",
      triggerConfig: { type: "webhook", webhookPath: "/a" },
      createdAt: new Date().toISOString(),
    });

    const scoped = await loadTriggerBindingsFromDeployments(store, { environmentId: "env_nonexistent" });
    expect(scoped).toEqual([]);
  });
});
