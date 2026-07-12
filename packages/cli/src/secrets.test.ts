// createRealSecretResolver (AMENDMENTS.md A45) — env var / secrets-file
// resolution, ref normalization, and precedence. real-server-port.test.ts
// covers this wired end to end through a real HTTP webhook delivery;
// TEST-DRIVE.md's own webhook walkthrough is the founder-facing live proof.
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRealSecretResolver, resolveDeployToken } from "./secrets.js";

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
  const root = await fs.mkdtemp(join(tmpdir(), "aart-secrets-test-"));
  cleanupPaths.push(root);
  return root;
}

describe("createRealSecretResolver", () => {
  it("resolves from AART_SECRET_<NAME>, accepting the full secrets.<NAME> ref form", async () => {
    const root = await freshRoot();
    setEnv("AART_SECRET_WEBHOOK_SECRET", "env-value-123");
    const resolver = createRealSecretResolver(root);
    await expect(resolver("secrets.WEBHOOK_SECRET")).resolves.toBe("env-value-123");
  });

  it("also accepts a bare NAME ref (no secrets. prefix)", async () => {
    const root = await freshRoot();
    setEnv("AART_SECRET_WEBHOOK_SECRET", "env-value-456");
    const resolver = createRealSecretResolver(root);
    await expect(resolver("WEBHOOK_SECRET")).resolves.toBe("env-value-456");
  });

  it("falls back to <root>/secrets.json when the env var is unset", async () => {
    const root = await freshRoot();
    await fs.writeFile(join(root, "secrets.json"), JSON.stringify({ WEBHOOK_SECRET: "file-value-789" }), "utf8");
    const resolver = createRealSecretResolver(root);
    await expect(resolver("secrets.WEBHOOK_SECRET")).resolves.toBe("file-value-789");
  });

  it("env var takes precedence over the secrets file when both are configured for the same name", async () => {
    const root = await freshRoot();
    await fs.writeFile(join(root, "secrets.json"), JSON.stringify({ WEBHOOK_SECRET: "file-value" }), "utf8");
    setEnv("AART_SECRET_WEBHOOK_SECRET", "env-value-wins");
    const resolver = createRealSecretResolver(root);
    await expect(resolver("secrets.WEBHOOK_SECRET")).resolves.toBe("env-value-wins");
  });

  it("resolves to undefined (not a throw) when neither the env var nor the file has the name", async () => {
    const root = await freshRoot();
    const resolver = createRealSecretResolver(root);
    await expect(resolver("secrets.NEVER_CONFIGURED")).resolves.toBeUndefined();
  });

  it("resolves to undefined (not a throw) when there's no secrets.json at all", async () => {
    const root = await freshRoot();
    const resolver = createRealSecretResolver(root);
    await expect(resolver("secrets.ANYTHING")).resolves.toBeUndefined();
  });

  it("resolves to undefined (not a throw) when secrets.json exists but is malformed", async () => {
    const root = await freshRoot();
    await fs.writeFile(join(root, "secrets.json"), "{ not valid json", "utf8");
    const resolver = createRealSecretResolver(root);
    await expect(resolver("secrets.WEBHOOK_SECRET")).resolves.toBeUndefined();
  });
});

// D1 "remotes + push" (AMENDMENTS.md A56) — a DELIBERATELY separate
// resolution convention from createRealSecretResolver above (no
// AART_SECRET_ prefix, no secrets.<NAME> ref stripping — see
// resolveDeployToken's own doc comment for why reusing the other resolver
// would double-prefix to AART_SECRET_AART_DEPLOY_TOKEN).
describe("resolveDeployToken", () => {
  it("resolves from the plain AART_DEPLOY_TOKEN env var — NOT AART_SECRET_AART_DEPLOY_TOKEN", async () => {
    const root = await freshRoot();
    setEnv("AART_DEPLOY_TOKEN", "env-token-123");
    await expect(resolveDeployToken(root)).resolves.toBe("env-token-123");
  });

  it("setting AART_SECRET_AART_DEPLOY_TOKEN instead (the double-prefixed mistake) does NOT resolve", async () => {
    const root = await freshRoot();
    setEnv("AART_SECRET_AART_DEPLOY_TOKEN", "wrong-convention-value");
    await expect(resolveDeployToken(root)).resolves.toBeUndefined();
  });

  it("falls back to <root>/secrets.json's own AART_DEPLOY_TOKEN key when the env var is unset", async () => {
    const root = await freshRoot();
    await fs.writeFile(join(root, "secrets.json"), JSON.stringify({ AART_DEPLOY_TOKEN: "file-token-789" }), "utf8");
    await expect(resolveDeployToken(root)).resolves.toBe("file-token-789");
  });

  it("env var takes precedence over the secrets file when both are configured", async () => {
    const root = await freshRoot();
    await fs.writeFile(join(root, "secrets.json"), JSON.stringify({ AART_DEPLOY_TOKEN: "file-token" }), "utf8");
    setEnv("AART_DEPLOY_TOKEN", "env-token-wins");
    await expect(resolveDeployToken(root)).resolves.toBe("env-token-wins");
  });

  it("resolves to undefined (not a throw) when neither the env var nor the file configures it", async () => {
    const root = await freshRoot();
    await expect(resolveDeployToken(root)).resolves.toBeUndefined();
  });

  it("resolves to undefined (not a throw) when there's no secrets.json at all", async () => {
    const root = await freshRoot();
    await expect(resolveDeployToken(root)).resolves.toBeUndefined();
  });

  it("resolves to undefined (not a throw) when secrets.json exists but is malformed", async () => {
    const root = await freshRoot();
    await fs.writeFile(join(root, "secrets.json"), "{ not valid json", "utf8");
    await expect(resolveDeployToken(root)).resolves.toBeUndefined();
  });

  it("sharing secrets.json with createRealSecretResolver's own webhook secrets does not cross-contaminate", async () => {
    const root = await freshRoot();
    await fs.writeFile(join(root, "secrets.json"), JSON.stringify({ AART_DEPLOY_TOKEN: "the-deploy-token", WEBHOOK_SECRET: "the-webhook-secret" }), "utf8");
    await expect(resolveDeployToken(root)).resolves.toBe("the-deploy-token");
    await expect(createRealSecretResolver(root)("secrets.WEBHOOK_SECRET")).resolves.toBe("the-webhook-secret");
  });
});
