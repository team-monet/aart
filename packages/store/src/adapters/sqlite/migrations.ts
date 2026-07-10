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

export const ALL_SQLITE_MIGRATIONS = (db: DatabaseSync): Migration[] => [createSqliteInitMigration(db)];
