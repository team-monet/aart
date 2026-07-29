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
import {
  ALL_SQLITE_MIGRATIONS,
  createSqliteAddApprovalTaskAuthenticatedAsMigration,
  createSqliteAddDeploymentPromotedMigration,
  createSqliteInitMigration,
} from "./migrations.js";
import { SqliteMigrationWatermarkStore } from "./watermark.js";

/** [0001, 0002, 0003] only — NOT ALL_SQLITE_MIGRATIONS, which now (AMENDMENTS.md A61) also includes 0004_events_table. Every test below this point that's specifically about 0003's OWN behavior (not "whatever the latest migration happens to be") must scope its runner to exactly this list — see the "down() reverts 0003" test's own doc comment for the trap this closes. */
function migrationsThrough0003(db: Parameters<typeof createSqliteInitMigration>[0]) {
  return [createSqliteInitMigration(db), createSqliteAddDeploymentPromotedMigration(db), createSqliteAddApprovalTaskAuthenticatedAsMigration(db)];
}

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
    // exactly 0002 (0001 is already accounted for), advances to 2. Scoped
    // to [0001, 0002] explicitly (NOT ALL_SQLITE_MIGRATIONS, which also
    // includes D2a's later 0003_approval_task_authenticated_as) — this
    // describe block is specifically about 0002's own behavior; 0003 gets
    // its own, identically-shaped describe block below.
    const runner = new MigrationRunner([createSqliteInitMigration(handle.db), createSqliteAddDeploymentPromotedMigration(handle.db)], new SqliteMigrationWatermarkStore(handle.db), handle.store);
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

    const runner = new MigrationRunner([createSqliteInitMigration(handle.db), createSqliteAddDeploymentPromotedMigration(handle.db)], new SqliteMigrationWatermarkStore(handle.db), handle.store);
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
    // Deliberately NOT `openSqliteStore(dbPath)`'s default (which now runs
    // every registered migration, including D2a's later 0003) — this test
    // is specifically about 0002's OWN down()/up() round-trip, so its
    // fixture is scoped to exactly [0001, 0002], mirroring the two tests
    // above rather than depending on ALL_SQLITE_MIGRATIONS' current total.
    handle = await openSqliteStore(dbPath, { runMigrations: false });
    runMigrationDdl(handle.db);

    const runner = new MigrationRunner([createSqliteInitMigration(handle.db), createSqliteAddDeploymentPromotedMigration(handle.db)], new SqliteMigrationWatermarkStore(handle.db), handle.store);
    await expect(runner.up()).resolves.toBe(2);
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

// D2a security hardening, token-derived attribution (AMENDMENTS.md A59) —
// the mandatory pre-populated-db regression test, same discipline as
// 0002's own describe block above: a database that has only ever run
// 0001_init + 0002_deployment_promoted (i.e. every ApprovalTask row written
// by a pre-D2a build, with no `authenticated_as` column at all) must, after
// upgrading through 0003, read those rows back with `authenticatedAs:
// undefined` — never a false "" or any other collapsed value.
describe("0003_approval_task_authenticated_as — pre-populated-db upgrade (D2a, AMENDMENTS.md A59)", () => {
  it("a row written before this migration existed reads back authenticatedAs:undefined, never a collapsed empty string", async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "aart-sqlite-migration-test-"));
    const dbPath = join(dir, "aart.db");

    // Simulate a database that has only ever run 0001+0002: open WITHOUT
    // auto-running migrations, apply 0001's raw DDL by hand, run 0002
    // explicitly (no `authenticated_as` column on `approval_tasks` at all),
    // and set the watermark to 2 directly — bypassing ALL_SQLITE_MIGRATIONS
    // entirely, which would otherwise also apply 0003 in the same call and
    // defeat the point of this fixture.
    handle = await openSqliteStore(dbPath, { runMigrations: false });
    runMigrationDdl(handle.db);
    await createSqliteAddDeploymentPromotedMigration(handle.db).up(handle.store);
    await new SqliteMigrationWatermarkStore(handle.db).write(2);

    // A raw INSERT with no `authenticated_as` column at all — the exact
    // on-disk shape every ApprovalTask row written by a pre-D2a build
    // actually has.
    handle.db.exec(
      `INSERT INTO approval_tasks (id, run_id, step_id, title, description, status, reviewer, decision_json, created_at, decided_at)
       VALUES ('at_legacy', 'run_1', 'step_1', 'Approve', 'desc', 'approved', 'alice', NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:05:00.000Z')`,
    );

    // The real upgrade path: MigrationRunner sees watermark 2, applies
    // exactly 0003 (0001/0002 already accounted for), advances to 3. Scoped
    // to [0001, 0002, 0003] explicitly (NOT ALL_SQLITE_MIGRATIONS, which as
    // of AMENDMENTS.md A61 also includes 0004_events_table) — this describe
    // block is specifically about 0003's own behavior; 0004 gets its own,
    // identically-shaped describe block below.
    const runner = new MigrationRunner(migrationsThrough0003(handle.db), new SqliteMigrationWatermarkStore(handle.db), handle.store);
    expect(await runner.currentVersion()).toBe(2);
    await expect(runner.up()).resolves.toBe(3);

    // Read the pre-existing row back through the REAL store surface (not a
    // raw SELECT) — proves the ApprovalTaskRow -> ApprovalTask mapping is
    // wired correctly end-to-end, not just correct as an isolated helper.
    const row = await handle.store.approvals.get("at_legacy");
    expect(row).toBeDefined();
    expect(row?.authenticatedAs).toBeUndefined();
    expect(row).toMatchObject({ id: "at_legacy", runId: "run_1", stepId: "step_1", status: "approved", reviewer: "alice" }); // the rest of the legacy row is untouched by the upgrade

    // A freshly-written row on the SAME now-upgraded database can still set
    // authenticatedAs explicitly — the new column is fully live, not
    // read-only.
    await handle.store.approvals.put({ ...row!, id: "at_new", authenticatedAs: "deploy-token" });
    expect((await handle.store.approvals.get("at_new"))?.authenticatedAs).toBe("deploy-token");
  });

  it("up() tolerates the column already existing at watermark 2 (mirrors 0002's own A58 belt-and-braces tolerance) — advances to 3 instead of throwing 'duplicate column name'", async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "aart-sqlite-migration-test-"));
    const dbPath = join(dir, "aart.db");

    handle = await openSqliteStore(dbPath, { runMigrations: false });
    runMigrationDdl(handle.db);
    await createSqliteAddDeploymentPromotedMigration(handle.db).up(handle.store);
    handle.db.exec(`ALTER TABLE approval_tasks ADD COLUMN authenticated_as TEXT`);
    await new SqliteMigrationWatermarkStore(handle.db).write(2);

    const runner = new MigrationRunner(migrationsThrough0003(handle.db), new SqliteMigrationWatermarkStore(handle.db), handle.store);
    expect(await runner.currentVersion()).toBe(2);
    // Without the tolerance, this throws "duplicate column name:
    // authenticated_as" instead of resolving.
    await expect(runner.up()).resolves.toBe(3);
    await expect(new SqliteMigrationWatermarkStore(handle.db).read()).resolves.toBe(3);

    await handle.store.approvals.put({
      id: "at_after_tolerant_upgrade",
      runId: "run_1",
      stepId: "step_1",
      title: "t",
      description: "d",
      status: "pending",
      createdAt: "2026-01-01T00:00:00.000Z",
      authenticatedAs: "deploy-token",
    });
    expect((await handle.store.approvals.get("at_after_tolerant_upgrade"))?.authenticatedAs).toBe("deploy-token");
  });

  it("down() reverts 0003 (drops the column) cleanly, and up() re-adds it", async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "aart-sqlite-migration-test-"));
    const dbPath = join(dir, "aart.db");
    // Deliberately NOT `openSqliteStore(dbPath)`'s default (which now runs
    // every registered migration, including AMENDMENTS.md A61's later
    // 0004_events_table) and NOT ALL_SQLITE_MIGRATIONS — this test is
    // specifically about 0003's OWN down()/up() round-trip. `MigrationRunner
    // .down()` only ever reverts the single migration currently AT the
    // watermark (types.ts's own documented contract) — with 0004 in the
    // mix, a runner built from ALL_SQLITE_MIGRATIONS sitting at watermark 4
    // would have `down()` revert 0004 (drop the events TABLE), not 0003
    // (drop the authenticated_as COLUMN this test actually means to
    // exercise) — exactly the "down() reverts only the LAST migration" trap
    // AMENDMENTS.md A58 first caught. Scoped to exactly [0001, 0002, 0003],
    // mirroring the "down() reverts 0002" test above rather than depending
    // on ALL_SQLITE_MIGRATIONS' current total.
    handle = await openSqliteStore(dbPath, { runMigrations: false });
    runMigrationDdl(handle.db);

    const runner = new MigrationRunner(migrationsThrough0003(handle.db), new SqliteMigrationWatermarkStore(handle.db), handle.store);
    await expect(runner.up()).resolves.toBe(3);
    expect(await runner.currentVersion()).toBe(3);

    await expect(runner.down()).resolves.toBe(2);
    // The column is genuinely gone — asserted directly against the DDL,
    // not inferred from the watermark alone.
    expect(() => handle!.db.exec("SELECT authenticated_as FROM approval_tasks LIMIT 1")).toThrow();

    // And re-applying up() restores it.
    await expect(runner.up()).resolves.toBe(3);
    expect(() => handle!.db.exec("SELECT authenticated_as FROM approval_tasks LIMIT 1")).not.toThrow();
  });
});

// V1 event log foundation (AMENDMENTS.md A61) — the mandatory
// pre-populated-db regression test, same discipline as 0002/0003's own
// describe blocks above: a database that has only ever run
// 0001_init + 0002_deployment_promoted + 0003_approval_task_authenticated_as
// (i.e. no `events` table at all) must, after upgrading through 0004, gain
// a fully working `events` table — proven through the real store surface,
// not just a raw DDL check.
describe("0004_events_table — pre-populated-db upgrade (V1, AMENDMENTS.md A61)", () => {
  it("a database that has only ever run 0001-0003 gains a working events table after upgrading through 0004", async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "aart-sqlite-migration-test-"));
    const dbPath = join(dir, "aart.db");

    // Simulate a database that has only ever run 0001+0002+0003: open
    // WITHOUT auto-running migrations, apply 0001's raw DDL by hand, run
    // 0002+0003 explicitly (no `events` table at all), and set the
    // watermark to 3 directly — bypassing ALL_SQLITE_MIGRATIONS entirely,
    // which would otherwise also apply 0004 in the same call and defeat the
    // point of this fixture.
    handle = await openSqliteStore(dbPath, { runMigrations: false });
    runMigrationDdl(handle.db);
    await createSqliteAddDeploymentPromotedMigration(handle.db).up(handle.store);
    await createSqliteAddApprovalTaskAuthenticatedAsMigration(handle.db).up(handle.store);
    await new SqliteMigrationWatermarkStore(handle.db).write(3);

    // The real upgrade path: MigrationRunner sees watermark 3, applies
    // exactly 0004 (0001/0002/0003 already accounted for), advances to 4.
    const runner = new MigrationRunner(ALL_SQLITE_MIGRATIONS(handle.db).slice(0, 4), new SqliteMigrationWatermarkStore(handle.db), handle.store);
    expect(await runner.currentVersion()).toBe(3);
    await expect(runner.up()).resolves.toBe(4);

    // Proven through the REAL store surface (not a raw INSERT/SELECT) —
    // append then list, exactly like any other real event-log write site.
    const entry = { id: "evt_legacy_upgrade", type: "run.completed", occurredAt: "2026-01-01T00:00:00.000Z", summary: "post-upgrade smoke test" };
    await handle.store.events.append(entry);
    await expect(handle.store.events.list()).resolves.toEqual([entry]);
  });

  it("down() reverts 0004 (drops the events table) cleanly, and up() re-adds it", async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "aart-sqlite-migration-test-"));
    const dbPath = join(dir, "aart.db");
    handle = await openSqliteStore(dbPath, { runMigrations: false });

    const runner = new MigrationRunner(ALL_SQLITE_MIGRATIONS(handle.db).slice(0, 4), new SqliteMigrationWatermarkStore(handle.db), handle.store);
    await expect(runner.up()).resolves.toBe(4);
    expect(await runner.currentVersion()).toBe(4);

    await expect(runner.down()).resolves.toBe(3);
    // The table is genuinely gone — asserted directly against the DDL, not
    // inferred from the watermark alone.
    expect(() => handle!.db.exec("SELECT * FROM events LIMIT 1")).toThrow();

    // And re-applying up() restores it, fully usable again.
    await expect(runner.up()).resolves.toBe(4);
    expect(() => handle!.db.exec("SELECT * FROM events LIMIT 1")).not.toThrow();
    await expect(handle.store.events.list()).resolves.toEqual([]);
  });
});

describe("0005_idempotency_schema_version", () => {
  it("keeps legacy rows readable as unversioned and persists versioned rows", async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "aart-sqlite-migration-test-"));
    const dbPath = join(dir, "aart.db");
    handle = await openSqliteStore(dbPath, { runMigrations: false });

    const through0004 = new MigrationRunner(
      ALL_SQLITE_MIGRATIONS(handle.db).slice(0, 4),
      new SqliteMigrationWatermarkStore(handle.db),
      handle.store,
    );
    await expect(through0004.up()).resolves.toBe(4);
    handle.db.exec(`
      INSERT INTO idempotency_ledger
        (resolved_key, run_id, step_id, recorded_output_json, created_at)
      VALUES
        ('v2:legacy-collision', 'legacy-run', 'work', '{"value":"legacy"}', '2026-01-01T00:00:00.000Z')
    `);

    const all = new MigrationRunner(
      ALL_SQLITE_MIGRATIONS(handle.db),
      new SqliteMigrationWatermarkStore(handle.db),
      handle.store,
    );
    await expect(all.up()).resolves.toBe(5);
    const legacy = await handle.store.idempotencyLedger.get(
      "v2:legacy-collision",
    );
    expect(legacy?.resolvedKey).toBe("v2:legacy-collision");
    expect(legacy?.schemaVersion).toBeUndefined();

    await handle.store.idempotencyLedger.put({
      resolvedKey: "v2:current",
      runId: "current-run",
      stepId: "work",
      recordedOutput: { value: "current" },
      createdAt: "2026-01-01T00:00:00.000Z",
      schemaVersion: 2,
    });
    await expect(
      handle.store.idempotencyLedger.get("v2:current"),
    ).resolves.toMatchObject({ schemaVersion: 2 });
  });
});
