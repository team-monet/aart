// SQLite's own `0001_init` migration — real DDL, unlike the fs adapter's
// no-op `migrations/0001_init.ts` (that module's own doc comment: "A
// hypothetical SQLite/Postgres adapter's own 0001_init (Wave-1 scope,
// S2/S9) would have real DDL here instead" — this is that adapter).
//
// Reuses the S0-frozen `Migration`/`MigrationRunner` shapes from
// ../../migrations/types.js (read-only import — packages/store/src/
// migrations/** is NOT part of this session's carve-out, only
// packages/store/src/adapters/sqlite/** is). This module does not modify
// anything outside this carve-out; it only imports the generic, already-
// exported migration-framework types/classes S0 built to be adapter-
// agnostic (packages/store/src/migrations/index.ts's own doc comment:
// "written against the AartStore interface... so the same Migration/
// MigrationRunner shapes are reusable by the SQLite/Postgres adapters Wave
// 1 builds").
import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "../../migrations/types.js";
import { runMigrationDdl } from "./db.js";

/**
 * Unlike the generic `Migration` shape (which takes an `AartStore`), this
 * migration operates directly on the raw `DatabaseSync` connection — DDL is
 * adapter-internal, not expressible through the `AartStore` interface (no
 * `AartStore` member has a "create my own table" method, nor should one).
 * `sqliteMigration0001Init.up`/`.down` below adapt this shape to satisfy
 * the generic `Migration` interface's signature so `MigrationRunner` can
 * still track/sequence it identically to any other migration.
 */
export function createSqliteInitMigration(db: DatabaseSync): Migration {
  return {
    id: "0001_init",
    async up(): Promise<void> {
      runMigrationDdl(db);
    },
    async down(): Promise<void> {
      // Reverting the baseline migration means dropping everything this
      // adapter created — matches the fs adapter's 0001_init.down()
      // being a no-op "no prior state to restore to," except here there
      // IS real state (tables) to tear down.
      const tables = [
        "workflows",
        "runs",
        "run_dedupe_keys",
        "waits",
        "signals",
        "artifacts",
        "approval_tasks",
        "standing_approvals",
        "corrections",
        "eval_suites",
        "eval_examples",
        "eval_runs",
        "deployments",
        "environments",
        "schedules",
        "prompt_registry",
        "schema_registry",
        "pack_manifests",
        "job_queue",
        "idempotency_ledger",
        "rejected_triggers",
      ];
      for (const table of tables) {
        db.exec(`DROP TABLE IF EXISTS ${table}`);
      }
      // `_migration_watermark` itself is intentionally NOT dropped here —
      // MigrationRunner.down() writes the new (lower) watermark back to it
      // immediately after this resolves; dropping the table it's about to
      // write to would break that write, not just this migration's own
      // bookkeeping.
    },
  };
}

/**
 * D1 "remotes + push" (AMENDMENTS.md A56) — this adapter's first migration
 * PAST `0001_init`, i.e. the precedent proving `MigrationRunner`'s ordinal
 * sequencing genuinely works against this adapter, not just a single
 * hardcoded step. Adds `deployments.promoted` (nullable INTEGER, no
 * DEFAULT — deliberately NOT added to `SQLITE_SCHEMA_STATEMENTS`'
 * `deployments` DDL in schema.ts, which stays exactly as `0001_init` always
 * created it; see that file's own note on the `deployments` table) so a
 * pre-existing row's column reads back SQL `NULL`, which `fromBoolOrNull`
 * (db.ts) maps to `undefined` — "unset, always was active" — never
 * `false`/"newly made inactive." A fresh database (0001 then 0002 both run
 * in sequence, watermark 0 -> 2) ends up with the identical final schema an
 * upgraded pre-existing database does; there is exactly one `deployments`
 * table shape reachable either way.
 */
export function createSqliteAddDeploymentPromotedMigration(db: DatabaseSync): Migration {
  return {
    id: "0002_deployment_promoted",
    async up(): Promise<void> {
      // AMENDMENTS.md A58 — belt-and-braces, NOT a substitute for
      // index.ts's own runMigrationsCoordinated (the real fix for the
      // concurrent-startup race this tolerates a residual symptom of).
      // `ALTER TABLE` has no `IF NOT EXISTS` in SQLite (unlike 0001_init's
      // `CREATE TABLE IF NOT EXISTS`, which was always naturally idempotent)
      // — so a database whose schema already has this column, for whatever
      // reason the in-process watermark check didn't catch (e.g. a
      // watermark that fell out of sync with the actual schema through some
      // path outside this adapter's own tracking), would otherwise throw
      // here even though there is nothing left to DO. Tolerating exactly
      // this one, specifically-matched failure and returning (log-and-
      // continue) mirrors `MigrationRunner.up()`'s own silent
      // `if (ordinal <= current) continue` skip for an already-applied
      // migration — "already done" is success, not an error, on either
      // path. Matched on the message text, not a numeric error code:
      // verified directly (node:sqlite) that `errcode`/`errstr` for this
      // specific SQLite failure are the generic SQLITE_ERROR/"SQL logic
      // error" shared by every other schema-mismatch error this driver can
      // throw — only `message` distinguishes "duplicate column name" from
      // any other reason this statement could fail, the same message-
      // substring-matching discipline `packages/server/src/http/server.ts`'s
      // `bundleErrorStatus` already uses for the identical reason (no typed
      // error hierarchy to switch on instead).
      try {
        db.exec(`ALTER TABLE deployments ADD COLUMN promoted INTEGER`);
      } catch (err) {
        if (err instanceof Error && err.message.includes("duplicate column name")) {
          return;
        }
        throw err;
      }
    },
    async down(): Promise<void> {
      // Modern SQLite (3.35+, well below node:sqlite's bundled floor —
      // AMENDMENTS.md A17) supports DROP COLUMN directly; no need for the
      // legacy "rebuild the table" workaround older SQLite versions required.
      db.exec(`ALTER TABLE deployments DROP COLUMN promoted`);
    },
  };
}

/**
 * D2a security hardening, token-derived attribution (AMENDMENTS.md A59) —
 * this adapter's THIRD migration, same shape as `createSqliteAddDeploymentPromotedMigration`
 * above (D1's own precedent for "add a nullable column, don't touch the
 * baseline DDL"): adds `approval_tasks.authenticated_as` (nullable TEXT, no
 * DEFAULT — deliberately NOT added to `SQLITE_SCHEMA_STATEMENTS`' own
 * `approval_tasks` DDL in schema.ts, which stays exactly as `0001_init`
 * always created it) so a pre-existing row's column reads back SQL `NULL`,
 * which this adapter's `ApprovalTaskRow` -> `ApprovalTask` mapping
 * (`stores/simple-stores.ts`'s `rowToApprovalTask`) maps to `undefined` —
 * "no attribution available" (the correct reading for every row written
 * before this field existed), never a false "definitely anonymous"
 * `authenticatedAs: ""`.
 */
export function createSqliteAddApprovalTaskAuthenticatedAsMigration(db: DatabaseSync): Migration {
  return {
    id: "0003_approval_task_authenticated_as",
    async up(): Promise<void> {
      // Belt-and-braces, mirroring 0002's own identical tolerance (see that
      // migration's doc comment for the full reasoning — a watermark that
      // fell out of sync with the actual schema through some path outside
      // this adapter's own tracking must not throw here when there is
      // nothing left to DO).
      try {
        db.exec(`ALTER TABLE approval_tasks ADD COLUMN authenticated_as TEXT`);
      } catch (err) {
        if (err instanceof Error && err.message.includes("duplicate column name")) {
          return;
        }
        throw err;
      }
    },
    async down(): Promise<void> {
      db.exec(`ALTER TABLE approval_tasks DROP COLUMN authenticated_as`);
    },
  };
}

/**
 * V1 event log foundation (AMENDMENTS.md A61) — this adapter's FOURTH
 * migration, and its first that adds a whole new TABLE rather than a
 * column on an existing one (0002/0003's own precedent above). Unlike
 * `ALTER TABLE ... ADD COLUMN` (which SQLite gives no `IF NOT EXISTS` for
 * — see 0002's own doc comment on exactly this gap), `CREATE TABLE IF NOT
 * EXISTS`/`CREATE INDEX IF NOT EXISTS` ARE naturally idempotent (the same
 * primitive `0001_init`'s own baseline DDL already relies on, schema.ts) —
 * so this migration does NOT need 0002/0003's try/catch
 * "duplicate column name" tolerance dance; a database whose schema already
 * has this table (for whatever reason its watermark fell out of sync)
 * simply no-ops on re-`CREATE TABLE IF NOT EXISTS`, no special-casing
 * required.
 *
 * The `events` table itself is NOT added to `SQLITE_SCHEMA_STATEMENTS`
 * (schema.ts) — same reasoning 0002/0003 already established for their
 * own added columns (that file's own note on the `deployments` table):
 * `0001_init`'s baseline DDL stays exactly as it always was, so a fresh
 * database running 0001→0002→0003→0004 in sequence and a pre-existing
 * database upgrading through 0004 both converge on the identical final
 * schema — there is exactly one `events` table shape reachable either way.
 */
export function createSqliteAddEventsTableMigration(db: DatabaseSync): Migration {
  return {
    id: "0004_events_table",
    async up(): Promise<void> {
      db.exec(`CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        summary TEXT NOT NULL,
        workflow_id TEXT,
        workflow_version TEXT,
        run_id TEXT,
        deployment_id TEXT,
        environment_id TEXT,
        approval_task_id TEXT,
        actor TEXT
      )`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_events_occurred_at ON events(occurred_at)`);
    },
    async down(): Promise<void> {
      // Mirrors 0001_init's own down() idiom (DROP TABLE IF EXISTS per
      // table) rather than 0002/0003's DROP COLUMN — this migration adds a
      // whole table, so reverting it means dropping the table entirely.
      db.exec(`DROP TABLE IF EXISTS events`);
    },
  };
}

export const ALL_SQLITE_MIGRATIONS = (db: DatabaseSync): Migration[] => [
  createSqliteInitMigration(db),
  createSqliteAddDeploymentPromotedMigration(db),
  createSqliteAddApprovalTaskAuthenticatedAsMigration(db),
  createSqliteAddEventsTableMigration(db),
];
