import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFsStore } from "../adapters/fs/index.js";
import { FsMigrationWatermarkStore } from "../adapters/fs/watermark.js";
import type { AartStore } from "../types.js";
import { migration0001Init } from "./0001_init.js";
import { MigrationRunner } from "./types.js";

let root: string;
let store: AartStore;
let watermark: FsMigrationWatermarkStore;

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "aart-store-migrations-"));
  store = createFsStore(root);
  watermark = new FsMigrationWatermarkStore(root);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("MigrationWatermarkStore (fs: schema-version.json)", () => {
  it("reads 0 when no schema-version.json exists yet", async () => {
    await expect(watermark.read()).resolves.toBe(0);
  });

  it("round-trips a written watermark", async () => {
    await watermark.write(3);
    await expect(watermark.read()).resolves.toBe(3);
  });

  it("writes schema-version.json in the documented shape ({ version: N }, architecture §5.2)", async () => {
    await watermark.write(1);
    const onDisk = JSON.parse(await fs.readFile(join(root, "schema-version.json"), "utf8"));
    expect(onDisk).toEqual({ version: 1 });
  });
});

describe("MigrationRunner — 0001_init", () => {
  it("starts at watermark 0 before any migration runs", async () => {
    const runner = new MigrationRunner([migration0001Init], watermark, store);
    await expect(runner.currentVersion()).resolves.toBe(0);
  });

  it("up() applies 0001_init and advances the watermark to 1", async () => {
    const runner = new MigrationRunner([migration0001Init], watermark, store);
    await expect(runner.up()).resolves.toBe(1);
    await expect(runner.currentVersion()).resolves.toBe(1);
  });

  it("up() is idempotent — calling it again with nothing new to apply stays at 1", async () => {
    const runner = new MigrationRunner([migration0001Init], watermark, store);
    await runner.up();
    await expect(runner.up()).resolves.toBe(1);
  });

  it("down() reverts 0001_init and drops the watermark back to 0", async () => {
    const runner = new MigrationRunner([migration0001Init], watermark, store);
    await runner.up();
    await expect(runner.down()).resolves.toBe(0);
    await expect(runner.currentVersion()).resolves.toBe(0);
  });

  it("down() at watermark 0 is a no-op", async () => {
    const runner = new MigrationRunner([migration0001Init], watermark, store);
    await expect(runner.down()).resolves.toBe(0);
  });

  it("rejects a migration set with a duplicate ordinal", () => {
    const duplicate = { ...migration0001Init };
    expect(() => new MigrationRunner([migration0001Init, duplicate], watermark, store)).toThrow();
  });

  it("rejects a migration id that doesn't start with a zero-padded ordinal", () => {
    // Ordinal validation happens eagerly in the constructor (it sorts and
    // dedup-checks every migration's ordinal up front), not lazily on
    // first up()/down() call.
    expect(() => new MigrationRunner([{ id: "init", up: async () => {}, down: async () => {} }], watermark, store)).toThrow();
  });
});
