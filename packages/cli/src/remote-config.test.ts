// D1 "remotes + push" (AMENDMENTS.md A56).
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readRemotes, writeRemotes, type RemoteConfig } from "./remote-config.js";

let cleanupPaths: string[] = [];
afterEach(async () => {
  await Promise.all(cleanupPaths.map((p) => fs.rm(p, { recursive: true, force: true })));
  cleanupPaths = [];
});

async function freshRoot(): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), "aart-remote-config-test-"));
  cleanupPaths.push(root);
  return root;
}

describe("readRemotes / writeRemotes", () => {
  it("readRemotes returns {} (not a throw) when remotes.json doesn't exist yet", async () => {
    const root = await freshRoot();
    await expect(readRemotes(root)).resolves.toEqual({});
  });

  it("readRemotes returns {} (not a throw) when remotes.json is malformed", async () => {
    const root = await freshRoot();
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(join(root, "remotes.json"), "{ not valid json", "utf8");
    await expect(readRemotes(root)).resolves.toEqual({});
  });

  it("readRemotes returns {} when remotes.json is a JSON array, not an object", async () => {
    const root = await freshRoot();
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(join(root, "remotes.json"), "[1,2,3]", "utf8");
    await expect(readRemotes(root)).resolves.toEqual({});
  });

  it("writeRemotes then readRemotes round-trips a single entry", async () => {
    const root = await freshRoot();
    const config: RemoteConfig = { production: { url: "https://prod.example.com", environment: "production", tokenRef: "secrets.PROD_DEPLOY_TOKEN" } };
    await writeRemotes(root, config);
    await expect(readRemotes(root)).resolves.toEqual(config);
  });

  it("round-trips multiple entries, tokenRef optional", async () => {
    const root = await freshRoot();
    const config: RemoteConfig = {
      staging: { url: "https://staging.example.com", environment: "staging" }, // no tokenRef
      production: { url: "https://prod.example.com", environment: "production", tokenRef: "secrets.PROD_TOKEN" },
    };
    await writeRemotes(root, config);
    await expect(readRemotes(root)).resolves.toEqual(config);
  });

  it("writeRemotes creates the root directory if it doesn't exist yet", async () => {
    const base = await freshRoot();
    const root = join(base, "nested", "not-yet-created");
    await writeRemotes(root, { x: { url: "https://x.example.com", environment: "x" } });
    await expect(readRemotes(root)).resolves.toEqual({ x: { url: "https://x.example.com", environment: "x" } });
  });

  it("a second writeRemotes call fully replaces the file content (caller's responsibility to merge, matching add/remove's own read-modify-write shape)", async () => {
    const root = await freshRoot();
    await writeRemotes(root, { a: { url: "https://a.example.com", environment: "a" } });
    await writeRemotes(root, { b: { url: "https://b.example.com", environment: "b" } });
    await expect(readRemotes(root)).resolves.toEqual({ b: { url: "https://b.example.com", environment: "b" } });
  });
});
