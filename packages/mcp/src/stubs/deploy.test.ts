// D1 "remotes + push" (AMENDMENTS.md A56) — createStubBundlerPort /
// createRemotesPort (exported as both createStubRemotesPort and, from
// real-context.ts, createRealRemotesPort — see this module's own doc
// comment for why there's exactly one implementation). Mirrors
// packages/cli/src/secrets.test.ts's own style for the analogous
// env-var/file-precedence logic this module deliberately duplicates.
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFsStore, type AartStore } from "@aart/store";
import { createRemotesPort, createStubBundlerPort, createStubRemotesPort } from "./deploy.js";

let cleanupPaths: string[] = [];
const envKeysToRestore: Array<[string, string | undefined]> = [];
afterEach(async () => {
  await Promise.all(cleanupPaths.map((p) => fs.rm(p, { recursive: true, force: true })));
  cleanupPaths = [];
  for (const [key, value] of envKeysToRestore.splice(0)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function setEnv(key: string, value: string): void {
  envKeysToRestore.push([key, process.env[key]]);
  process.env[key] = value;
}

async function freshRoot(): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), "aart-mcp-deploy-stub-test-"));
  cleanupPaths.push(root);
  return root;
}

function freshStore(root: string): AartStore {
  return createFsStore(root);
}

describe("createStubBundlerPort", () => {
  it("produces a minimal, structurally-correct bundle (manifest + one workflow definition + empty triggers)", async () => {
    const root = await freshRoot();
    const store = freshStore(root);
    await store.workflows.put({ id: "wf1", name: "n", version: "1", inputs: [], outputs: [], execution: { type: "workflow", steps: [] }, approval: "approved", gates: { validate: "passed", readiness: "passed", evals: "passed", riskReview: "passed", humanReview: "passed" } });
    const bundler = createStubBundlerPort(store);
    const bundle = await bundler.produceBundle({ workflowId: "wf1", workflowVersion: "1" });
    expect(bundle.manifest["workflowId"]).toBe("wf1");
    expect(bundle.manifest["workflowVersion"]).toBe("1");
    expect(bundle.files["manifest.json"]).toBeDefined();
    expect(bundle.files["definitions/workflow.json"]).toBeDefined();
    expect(JSON.parse(bundle.files["triggers.json"]!)).toEqual({});
  });

  it("records targetEnvironment on the manifest when --environment is given, omits it entirely when not", async () => {
    const root = await freshRoot();
    const store = freshStore(root);
    await store.workflows.put({ id: "wf2", name: "n", version: "1", inputs: [], outputs: [], execution: { type: "workflow", steps: [] }, approval: "approved", gates: { validate: "passed", readiness: "passed", evals: "passed", riskReview: "passed", humanReview: "passed" } });
    const bundler = createStubBundlerPort(store);
    const withEnv = await bundler.produceBundle({ workflowId: "wf2", workflowVersion: "1", environment: "staging" });
    expect(withEnv.manifest["targetEnvironment"]).toBe("staging");
    const withoutEnv = await bundler.produceBundle({ workflowId: "wf2", workflowVersion: "1" });
    expect(Object.keys(withoutEnv.manifest)).not.toContain("targetEnvironment");
  });

  it("throws a clear error when the workflow doesn't exist", async () => {
    const root = await freshRoot();
    const bundler = createStubBundlerPort(freshStore(root));
    await expect(bundler.produceBundle({ workflowId: "no-such-wf", workflowVersion: "1" })).rejects.toThrow(/not found/);
  });
});

describe("createRemotesPort — list/get", () => {
  it("list() returns {} when remotes.json doesn't exist yet", async () => {
    const root = await freshRoot();
    await expect(createRemotesPort(root).list()).resolves.toEqual({});
  });

  it("list()/get() round-trip real remotes.json content", async () => {
    const root = await freshRoot();
    const config = { production: { url: "https://prod.example.com", environment: "production", tokenRef: "secrets.PROD_TOKEN" } };
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(join(root, "remotes.json"), JSON.stringify(config), "utf8");
    const remotes = createRemotesPort(root);
    await expect(remotes.list()).resolves.toEqual(config);
    await expect(remotes.get("production")).resolves.toEqual(config.production);
    await expect(remotes.get("no-such-remote")).resolves.toBeUndefined();
  });

  it("list() returns {} (not a throw) when remotes.json is malformed", async () => {
    const root = await freshRoot();
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(join(root, "remotes.json"), "{ not valid json", "utf8");
    await expect(createRemotesPort(root).list()).resolves.toEqual({});
  });
});

describe("createRemotesPort — resolveToken", () => {
  it("undefined when the remote has no tokenRef at all", async () => {
    const root = await freshRoot();
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(join(root, "remotes.json"), JSON.stringify({ dev: { url: "https://dev.example.com", environment: "dev" } }), "utf8");
    await expect(createRemotesPort(root).resolveToken("dev")).resolves.toBeUndefined();
  });

  it("undefined for an unknown remote name", async () => {
    const root = await freshRoot();
    await expect(createRemotesPort(root).resolveToken("no-such-remote")).resolves.toBeUndefined();
  });

  it("resolves tokenRef from AART_SECRET_<NAME>, accepting the full secrets.<NAME> ref form", async () => {
    const root = await freshRoot();
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(join(root, "remotes.json"), JSON.stringify({ production: { url: "https://prod.example.com", environment: "production", tokenRef: "secrets.PROD_TOKEN" } }), "utf8");
    setEnv("AART_SECRET_PROD_TOKEN", "env-token-value");
    await expect(createRemotesPort(root).resolveToken("production")).resolves.toBe("env-token-value");
  });

  it("also accepts a bare NAME tokenRef (no secrets. prefix)", async () => {
    const root = await freshRoot();
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(join(root, "remotes.json"), JSON.stringify({ production: { url: "https://prod.example.com", environment: "production", tokenRef: "PROD_TOKEN" } }), "utf8");
    setEnv("AART_SECRET_PROD_TOKEN", "env-token-value-2");
    await expect(createRemotesPort(root).resolveToken("production")).resolves.toBe("env-token-value-2");
  });

  it("falls back to <root>/secrets.json when the env var is unset", async () => {
    const root = await freshRoot();
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(join(root, "remotes.json"), JSON.stringify({ production: { url: "https://prod.example.com", environment: "production", tokenRef: "secrets.PROD_TOKEN" } }), "utf8");
    await fs.writeFile(join(root, "secrets.json"), JSON.stringify({ PROD_TOKEN: "file-token-value" }), "utf8");
    await expect(createRemotesPort(root).resolveToken("production")).resolves.toBe("file-token-value");
  });

  it("env var takes precedence over the secrets file when both are configured", async () => {
    const root = await freshRoot();
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(join(root, "remotes.json"), JSON.stringify({ production: { url: "https://prod.example.com", environment: "production", tokenRef: "secrets.PROD_TOKEN" } }), "utf8");
    await fs.writeFile(join(root, "secrets.json"), JSON.stringify({ PROD_TOKEN: "file-token" }), "utf8");
    setEnv("AART_SECRET_PROD_TOKEN", "env-token-wins");
    await expect(createRemotesPort(root).resolveToken("production")).resolves.toBe("env-token-wins");
  });

  it("resolves to undefined (not a throw) when the tokenRef doesn't resolve anywhere", async () => {
    const root = await freshRoot();
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(join(root, "remotes.json"), JSON.stringify({ production: { url: "https://prod.example.com", environment: "production", tokenRef: "secrets.NEVER_CONFIGURED" } }), "utf8");
    await expect(createRemotesPort(root).resolveToken("production")).resolves.toBeUndefined();
  });
});

describe("createStubRemotesPort is createRemotesPort (structural pairing, not a simplification)", () => {
  it("is the exact same function reference", () => {
    expect(createStubRemotesPort).toBe(createRemotesPort);
  });
});
