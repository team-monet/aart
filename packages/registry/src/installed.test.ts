import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  approveInstalledPack,
  listActiveApprovedPackStatesSync,
  listInstalledPackStatesSync,
  persistInstalledPack,
  readInstalledPackState,
  type InstalledPackState,
} from "./installed.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function writeState(root: string, state: InstalledPackState): Promise<void> {
  const dir = join(root, "packs", "installed", state.name, state.version);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, "state.json"), JSON.stringify(state), "utf8");
}

function approved(name: string, version: string): InstalledPackState {
  return {
    name,
    version,
    contentHash: `sha256:${"a".repeat(64)}`,
    approvalStatus: "approved",
    installedAt: "2026-07-27T00:00:00.000Z",
    approvedAt: "2026-07-27T00:01:00.000Z",
    reviewer: "reviewer",
    provenance: { kind: "workspace", source: "test" },
  };
}

describe("installed Pack enumeration", () => {
  it("ignores ordinary files at both installed storage levels", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "aart-installed-enumeration-"));
    roots.push(root);
    const base = join(root, "packs", "installed");
    await fs.mkdir(join(base, "demo"), { recursive: true });
    await fs.writeFile(join(base, ".DS_Store"), "noise", "utf8");
    await fs.writeFile(join(base, "demo", "operator-note.txt"), "noise", "utf8");
    await writeState(root, approved("demo", "1.0.0"));

    expect(listInstalledPackStatesSync(root).map((state) => `${state.name}@${state.version}`)).toEqual([
      "demo@1.0.0",
    ]);
  });

  it("uses SemVer precedence so a prerelease or build label cannot replace the stable version", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "aart-installed-semver-"));
    roots.push(root);
    await writeState(root, approved("demo", "1.0.0-beta.1"));
    await writeState(root, approved("demo", "1.0.0"));
    await writeState(root, approved("demo", "1.0.0+build.9"));

    expect(listActiveApprovedPackStatesSync(root)).toEqual([
      expect.objectContaining({ name: "demo", version: "1.0.0" }),
    ]);
  });
});

describe("installed Pack approval", () => {
  it("rechecks the reviewed content hash at the final state transition", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "aart-installed-approval-"));
    roots.push(root);
    const installed = await persistInstalledPack(
      root,
      {
        manifestYaml: "name: demo\nversion: 1.0.0\nblocks: [demo.echo]\n",
        blockSources: {
          "demo.echo": `module.exports = {
            manifest: {
              id: "demo.echo",
              version: "1.0.0",
              capabilities: [],
              inputSchema: {},
              outputSchema: {},
              description: "demo"
            },
            execute: async () => ({ ok: true })
          };`,
        },
      },
      { kind: "workspace", source: "test" },
    );

    await expect(
      approveInstalledPack(
        root,
        "demo",
        "1.0.0",
        "reviewer",
        new Date("2026-07-27T00:01:00.000Z"),
        `${installed.state.contentHash}-replaced`,
      ),
    ).rejects.toThrow(/reviewed content hash no longer matches/);
    expect(await readInstalledPackState(root, "demo", "1.0.0")).toEqual(
      expect.objectContaining({ approvalStatus: "unapproved" }),
    );
  });
});
