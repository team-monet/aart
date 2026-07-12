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

describe("deploymentToBinding — environmentId carried onto the binding (AMENDMENTS.md S15 — settling the S11/A42 governance-permissiveness finding)", () => {
  it("a deployment's environmentId is threaded onto its TriggerBinding, not just used to filter which deployments load", async () => {
    const store = await freshStore();
    await store.deployments.put({
      id: "dep_a",
      workflowId: "wf",
      workflowVersion: "1",
      environmentId: "env_production",
      triggerConfig: { type: "webhook", webhookPath: "/a" },
      createdAt: new Date().toISOString(),
    });

    const bindings = await loadTriggerBindingsFromDeployments(store);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.environmentId).toBe("env_production");
  });
});

// D1 "remotes + push" (AMENDMENTS.md A56) — the single chokepoint the
// design memo names: deploymentToBinding must skip promoted:false, and only
// promoted:false, regardless of caller (both loadTriggerBindingsFromDeployments'
// two real call sites — webhook/github/slack HTTP ingress via
// http/server.ts's findBinding, and the poll ticker via ticker/ticker.ts —
// funnel through this exact function, so this store-level proof covers both
// without needing a second, duplicated end-to-end test per ingress path).
describe("deploymentToBinding — promoted:false is skipped (AMENDMENTS.md A56)", () => {
  it("promoted:false: no binding produced — the deployment is entirely absent from the returned list", async () => {
    const store = await freshStore();
    await store.deployments.put({
      id: "dep_not_promoted",
      workflowId: "wf",
      workflowVersion: "1",
      environmentId: "env_staging",
      triggerConfig: { type: "webhook", webhookPath: "/not-promoted" },
      createdAt: new Date().toISOString(),
      promoted: false,
    });

    const bindings = await loadTriggerBindingsFromDeployments(store);
    expect(bindings).toEqual([]);
  });

  it("promoted:true: a binding is produced, same as any other active deployment", async () => {
    const store = await freshStore();
    await store.deployments.put({
      id: "dep_promoted",
      workflowId: "wf",
      workflowVersion: "1",
      environmentId: "env_staging",
      triggerConfig: { type: "webhook", webhookPath: "/promoted" },
      createdAt: new Date().toISOString(),
      promoted: true,
    });

    const bindings = await loadTriggerBindingsFromDeployments(store);
    expect(bindings.map((b) => b.id)).toEqual(["dep_promoted"]);
  });

  it("promoted:undefined (omitted — every pre-D1 row, and any row a caller never stamped) is UNAFFECTED — regression against every existing fixture that never sets this field", async () => {
    const store = await freshStore();
    await store.deployments.put({
      id: "dep_legacy_no_promoted_field",
      workflowId: "wf",
      workflowVersion: "1",
      environmentId: "env_staging",
      triggerConfig: { type: "webhook", webhookPath: "/legacy" },
      createdAt: new Date().toISOString(),
      // no `promoted` key at all — the shape of every Deployment this
      // codebase's own tests/fixtures wrote before D1.
    });

    const bindings = await loadTriggerBindingsFromDeployments(store);
    expect(bindings.map((b) => b.id)).toEqual(["dep_legacy_no_promoted_field"]);
  });

  it("a mix of promoted/unpromoted/legacy deployments: only the non-false ones bind", async () => {
    const store = await freshStore();
    await store.deployments.put({ id: "dep_1", workflowId: "wf", workflowVersion: "1", environmentId: "env_a", triggerConfig: { type: "webhook", webhookPath: "/1" }, createdAt: new Date().toISOString(), promoted: false });
    await store.deployments.put({ id: "dep_2", workflowId: "wf", workflowVersion: "1", environmentId: "env_b", triggerConfig: { type: "webhook", webhookPath: "/2" }, createdAt: new Date().toISOString(), promoted: true });
    await store.deployments.put({ id: "dep_3", workflowId: "wf", workflowVersion: "1", environmentId: "env_c", triggerConfig: { type: "webhook", webhookPath: "/3" }, createdAt: new Date().toISOString() });

    const bindings = await loadTriggerBindingsFromDeployments(store);
    expect(bindings.map((b) => b.id).sort()).toEqual(["dep_2", "dep_3"]);
  });
});
