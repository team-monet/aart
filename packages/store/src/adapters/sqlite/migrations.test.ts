// D1 "remotes + push" (AMENDMENTS.md A56) — the mandatory pre-populated-db
// regression test the design memo calls for: a database that has only ever
// run migration 0001_init (i.e. every Deployment row written by a pre-D1
// build, with no `promoted` column at all) must, after upgrading through
// 0002_deployment_promoted, read those rows back with `promoted: undefined`
// (still active — today's implicit behavior) — NEVER `false` (which would
// silently deactivate every trigger that row's deployment was already
// firing; deploymentToBinding, triggers/registry.ts, treats `promoted ===
// false` as "skip this binding entirely"). This is exactly the failure mode
// a naive `fromBool` (collapses SQL NULL into JS `false`) would produce —
// this test proves `fromBoolOrNull` (db.ts) is wired correctly end-to-end,
// against a REAL migration run over a REAL pre-existing row, not merely
// correct in isolation (that narrower unit-level guarantee is separately
// covered by conformance.ts's own promoted round-trip test, run against
// this adapter via sqlite-store.conformance.test.ts).
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MigrationRunner } from "../../migrations/index.js";
import { runMigrationDdl } from "./db.js";
import { openSqliteStore, type SqliteStoreHandle } from "./index.js";
import { ALL_SQLITE_MIGRATIONS } from "./migrations.js";
import { SqliteMigrationWatermarkStore } from "./watermark.js";

let dir: string | undefined;
let handle: SqliteStoreHandle | undefined;

afterEach(async () => {
  handle?.close();
  handle = undefined;
  if (dir) await fs.rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("0002_deployment_promoted — pre-populated-db upgrade (D1, AMENDMENTS.md A56)", () => {
  it("a row written before this migration existed reads back promoted:undefined (active), never false", async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "aart-sqlite-migration-test-"));
    const dbPath = join(dir, "aart.db");

    // Simulate a database that has only ever run 0001_init: open WITHOUT
    // auto-running migrations, apply 0001's raw DDL by hand (no `promoted`
    // column on `deployments` at all — see schema.ts's own note on why),
    // and set the watermark to 1 directly — bypassing MigrationRunner/
    // ALL_SQLITE_MIGRATIONS entirely, which would otherwise also apply 0002
    // in the same call and defeat the point of this fixture.
    handle = await openSqliteStore(dbPath, { runMigrations: false });
    runMigrationDdl(handle.db);
    await new SqliteMigrationWatermarkStore(handle.db).write(1);

    // A raw INSERT with no `promoted` column at all — the exact on-disk
    // shape every Deployment row written by a pre-D1 build actually has.
    handle.db.exec(
      `INSERT INTO deployments (id, workflow_id, workflow_version, environment_id, trigger_config_json, bundle_hash, created_at)
       VALUES ('dep_legacy', 'wf', '1', 'env_prod', '{}', NULL, '2026-01-01T00:00:00.000Z')`,
    );

    // The real upgrade path: MigrationRunner sees watermark 1, applies
    // exactly 0002 (0001 is already accounted for), advances to 2.
    const runner = new MigrationRunner(ALL_SQLITE_MIGRATIONS(handle.db), new SqliteMigrationWatermarkStore(handle.db), handle.store);
    expect(await runner.currentVersion()).toBe(1);
    await expect(runner.up()).resolves.toBe(2);

    // Read the pre-existing row back through the REAL store surface (not a
    // raw SELECT) — this is what actually proves fromBoolOrNull is wired
    // correctly end-to-end, not just correct as an isolated helper.
    const row = await handle.store.deployments.get("dep_legacy");
    expect(row).toBeDefined();
    expect(row?.promoted).toBeUndefined();
    expect(row?.promoted).not.toBe(false); // the specific regression this test guards against

    // The rest of the legacy row's fields are untouched by the upgrade.
    expect(row).toMatchObject({ id: "dep_legacy", workflowId: "wf", workflowVersion: "1", environmentId: "env_prod" });

    // A freshly-written row on the SAME now-upgraded database can still set
    // promoted explicitly — the new column is fully live, not read-only.
    await handle.store.deployments.put({ ...row!, id: "dep_new", promoted: false });
    expect((await handle.store.deployments.get("dep_new"))?.promoted).toBe(false);
  });

  it("up() tolerates the column already existing at watermark 1 (AMENDMENTS.md A58 belt-and-braces) — advances to 2 instead of throwing 'duplicate column name'", async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "aart-sqlite-migration-test-"));
    const dbPath = join(dir, "aart.db");

    // Same watermark-1, 0001-only fixture as the test above, EXCEPT the
    // `promoted` column has somehow already been added — modeling a
    // database whose on-disk schema fell out of sync with its own
    // watermark through some path outside MigrationRunner's own tracking
    // (the exact residual-symptom shape this belt-and-braces defense
    // targets — see migrations.ts's own createSqliteAddDeploymentPromotedMigration
    // doc comment; the real fix for the CONCURRENCY race itself is
    // index.ts's runMigrationsCoordinated, exercised by
    // src/e2e/migration-race.e2e.test.ts).
    handle = await openSqliteStore(dbPath, { runMigrations: false });
    runMigrationDdl(handle.db);
    handle.db.exec(`ALTER TABLE deployments ADD COLUMN promoted INTEGER`);
    await new SqliteMigrationWatermarkStore(handle.db).write(1);

    const runner = new MigrationRunner(ALL_SQLITE_MIGRATIONS(handle.db), new SqliteMigrationWatermarkStore(handle.db), handle.store);
    expect(await runner.currentVersion()).toBe(1);
    // Without the tolerance, this throws "duplicate column name: promoted"
    // instead of resolving — verified directly (this fix's own development):
    // reverting just the try/catch in createSqliteAddDeploymentPromotedMigration's
    // up() while keeping this exact fixture reproduces that rejection.
    await expect(runner.up()).resolves.toBe(2);

    // The watermark genuinely advanced (this isn't a silent early-return
    // that leaves the store thinking it's still on 1) and the column is
    // still exactly one column, still usable normally.
    await expect(new SqliteMigrationWatermarkStore(handle.db).read()).resolves.toBe(2);
    await handle.store.deployments.put({
      id: "dep_after_tolerant_upgrade",
      workflowId: "wf",
      workflowVersion: "1",
      environmentId: "env_prod",
      triggerConfig: {},
      createdAt: "2026-01-01T00:00:00.000Z",
      promoted: true,
    });
    expect((await handle.store.deployments.get("dep_after_tolerant_upgrade"))?.promoted).toBe(true);
  });

  it("down() reverts 0002 (drops the column) cleanly, and up() re-adds it", async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "aart-sqlite-migration-test-"));
    const dbPath = join(dir, "aart.db");
    handle = await openSqliteStore(dbPath); // default: runs 0001 + 0002

    const runner = new MigrationRunner(ALL_SQLITE_MIGRATIONS(handle.db), new SqliteMigrationWatermarkStore(handle.db), handle.store);
    expect(await runner.currentVersion()).toBe(2);

    await expect(runner.down()).resolves.toBe(1);
    // The column is genuinely gone — asserted directly against the DDL,
    // not inferred from the watermark alone.
    expect(() => handle!.db.exec("SELECT promoted FROM deployments LIMIT 1")).toThrow();

    // And re-applying up() restores it (a real operator running down() to
    // roll back a bad deploy, then up() again, must not be a one-way trip).
    await expect(runner.up()).resolves.toBe(2);
    expect(() => handle!.db.exec("SELECT promoted FROM deployments LIMIT 1")).not.toThrow();
  });
});
