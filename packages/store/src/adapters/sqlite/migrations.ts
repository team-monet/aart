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
import { createHash } from "node:crypto";
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

export function createSqliteAddIdempotencySchemaVersionMigration(db: DatabaseSync): Migration {
  return {
    id: "0005_idempotency_schema_version",
    async up(): Promise<void> {
      try {
        db.exec(`ALTER TABLE idempotency_ledger ADD COLUMN schema_version INTEGER`);
      } catch (err) {
        if (
          err instanceof Error &&
          err.message.includes("duplicate column name")
        ) {
          // A prior interrupted/retried migration may already have added
          // the column. Continue so the companion lookup index is repaired.
        } else {
          throw err;
        }
      }
      db.exec(`CREATE INDEX IF NOT EXISTS idx_idempotency_ledger_run_id ON idempotency_ledger(run_id)`);
    },
    async down(): Promise<void> {
      db.exec(`DROP INDEX IF EXISTS idx_idempotency_ledger_run_id`);
      db.exec(`ALTER TABLE idempotency_ledger DROP COLUMN schema_version`);
    },
  };
}

export function createSqliteAddRunRootTaintPathsMigration(db: DatabaseSync): Migration {
  const addColumn = (name: string): void => {
    try {
      db.exec(`ALTER TABLE runs ADD COLUMN ${name} TEXT`);
    } catch (err) {
      if (
        !(
          err instanceof Error &&
          err.message.includes("duplicate column name")
        )
      ) {
        throw err;
      }
    }
  };
  return {
    id: "0006_run_root_taint_paths",
    async up(): Promise<void> {
      addColumn("secret_tainted_input_paths_json");
      addColumn("secret_tainted_trigger_paths_json");
    },
    async down(): Promise<void> {
      db.exec(`ALTER TABLE runs DROP COLUMN secret_tainted_trigger_paths_json`);
      db.exec(`ALTER TABLE runs DROP COLUMN secret_tainted_input_paths_json`);
    },
  };
}

/**
 * Separates redacted audit values from the operational values required to
 * resume an outstanding wait, and records which run consumed a signal so a
 * later secret discovery can repair that audit copy without scanning or
 * consuming unrelated signals.
 */
export function createSqliteAddSecretAuditProvenanceMigration(
  db: DatabaseSync,
): Migration {
  const addColumn = (table: string, definition: string): void => {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
    } catch (err) {
      if (
        !(
          err instanceof Error &&
          err.message.includes("duplicate column name")
        )
      ) {
        throw err;
      }
    }
  };
  return {
    id: "0007_secret_audit_provenance",
    async up(): Promise<void> {
      addColumn("waits", "signal_match_fingerprint TEXT");
      const waitRows = db
        .prepare(
          "SELECT run_id, step_id, wait_condition_json FROM waits WHERE signal_match_fingerprint IS NULL",
        )
        .all() as Array<{
        run_id: string;
        step_id: string;
        wait_condition_json: string;
      }>;
      const updateWait = db.prepare(
        "UPDATE waits SET signal_match_fingerprint = ? WHERE run_id = ? AND step_id = ?",
      );
      for (const row of waitRows) {
        const wait = JSON.parse(row.wait_condition_json) as Record<
          string,
          unknown
        >;
        let name: string | undefined;
        let correlationId: string | undefined;
        switch (wait["type"]) {
          case "signal":
            name = wait["name"] as string | undefined;
            correlationId = wait["correlationId"] as string | undefined;
            break;
          case "webhook":
            name = wait["event"] as string | undefined;
            correlationId = wait["correlationId"] as string | undefined;
            break;
          case "queue":
            name = wait["queue"] as string | undefined;
            correlationId = wait["correlationId"] as string | undefined;
            break;
          case "external_job":
            name = wait["provider"] as string | undefined;
            correlationId = wait["jobId"] as string | undefined;
            break;
        }
        if (name !== undefined && correlationId !== undefined) {
          updateWait.run(
            createHash("sha256")
              .update(JSON.stringify([name, correlationId]))
              .digest("hex"),
            row.run_id,
            row.step_id,
          );
        }
      }
      addColumn("signals", "consumed_by_run_id TEXT");
      addColumn("signals", "consumed_by_step_id TEXT");
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_signals_consumed_by_run ON signals(consumed_by_run_id)",
      );
    },
    async down(): Promise<void> {
      db.exec("DROP INDEX IF EXISTS idx_signals_consumed_by_run");
      db.exec("ALTER TABLE signals DROP COLUMN consumed_by_step_id");
      db.exec("ALTER TABLE signals DROP COLUMN consumed_by_run_id");
      db.exec("ALTER TABLE waits DROP COLUMN signal_match_fingerprint");
    },
  };
}

/**
 * Separates customer-visible audit values from the operational state needed
 * to resume waits, and retains a non-sensitive text/binary classification
 * before artifact MIME metadata can be redacted.
 *
 * Existing waits remain readable through the audit column until their next
 * put/security rewrite, which seals the operational copy before replacing
 * any audit value. Existing artifacts are backfilled from their current MIME
 * while that original classification is still available.
 */
export function createSqliteAddSealedOperationalStateMigration(
  db: DatabaseSync,
): Migration {
  const addColumn = (table: string, definition: string): void => {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("duplicate column name")
      ) {
        return;
      }
      throw error;
    }
  };

  return {
    id: "0008_sealed_operational_state",
    async up(): Promise<void> {
      addColumn("waits", "operational_wait_ciphertext TEXT");
      addColumn("artifacts", "redaction_text_eligible INTEGER");
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_events_run_id ON events(run_id)",
      );
      db.exec(
        `UPDATE artifacts
         SET redaction_text_eligible =
           CASE
             WHEN lower(mime) LIKE 'text/%'
               OR lower(mime) LIKE '%json%'
               OR lower(mime) LIKE '%xml%'
               OR lower(mime) LIKE '%javascript%'
               OR lower(mime) LIKE '%yaml%'
             THEN 1
             ELSE 0
           END
         WHERE redaction_text_eligible IS NULL`,
      );
    },
    async down(): Promise<void> {
      db.exec("DROP INDEX IF EXISTS idx_events_run_id");
      db.exec(
        "ALTER TABLE artifacts DROP COLUMN redaction_text_eligible",
      );
      db.exec(
        "ALTER TABLE waits DROP COLUMN operational_wait_ciphertext",
      );
    },
  };
}

/**
 * Gives every wait entry a fresh authenticated generation. Existing v1
 * ciphertext remains readable and is lazily rotated to generation-bound
 * v2 on the first operational access.
 */
export function createSqliteAddWaitOperationGenerationMigration(
  db: DatabaseSync,
): Migration {
  return {
    id: "0009_wait_operation_generation",
    async up(): Promise<void> {
      try {
        db.exec(
          "ALTER TABLE waits ADD COLUMN operational_generation TEXT",
        );
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes("duplicate column name")
        ) {
          return;
        }
        throw error;
      }
    },
    async down(): Promise<void> {
      db.exec(
        "ALTER TABLE waits DROP COLUMN operational_generation",
      );
    },
  };
}

/**
 * Separates still-actionable signal values plus pending/active/suspended run
 * continuation state from their customer-visible audit copies. Existing
 * signal rows are lazily sealed before the first audit rewrite, while new
 * operational state is sealed at its lifecycle transition.
 */
export function createSqliteAddProtectedContinuationStateMigration(
  db: DatabaseSync,
): Migration {
  const addColumn = (table: string, definition: string): void => {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("duplicate column name")
      ) {
        return;
      }
      throw error;
    }
  };
  return {
    id: "0010_protected_continuation_state",
    async up(): Promise<void> {
      addColumn("signals", "signal_match_fingerprint TEXT");
      addColumn("signals", "operational_signal_ciphertext TEXT");
      addColumn("signals", "operational_generation TEXT");
      addColumn(
        "waits",
        "operational_run_state_ciphertext TEXT",
      );
      addColumn("runs", "operational_generation TEXT");
      addColumn(
        "runs",
        "operational_run_state_ciphertext TEXT",
      );
      addColumn("idempotency_ledger", "trace_seq INTEGER");
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_signals_match_fingerprint ON signals(signal_match_fingerprint)",
      );
    },
    async down(): Promise<void> {
      db.exec(
        "DROP INDEX IF EXISTS idx_signals_match_fingerprint",
      );
      db.exec(
        "ALTER TABLE waits DROP COLUMN operational_run_state_ciphertext",
      );
      db.exec(
        "ALTER TABLE runs DROP COLUMN operational_run_state_ciphertext",
      );
      db.exec(
        "ALTER TABLE runs DROP COLUMN operational_generation",
      );
      db.exec(
        "ALTER TABLE idempotency_ledger DROP COLUMN trace_seq",
      );
      db.exec(
        "ALTER TABLE signals DROP COLUMN operational_generation",
      );
      db.exec(
        "ALTER TABLE signals DROP COLUMN operational_signal_ciphertext",
      );
      db.exec(
        "ALTER TABLE signals DROP COLUMN signal_match_fingerprint",
      );
    },
  };
}

/**
 * Separates an artifact's engine-retained repair source from its public
 * audit visibility. Existing artifacts remain visible; redaction may only
 * move the flag from 1 to 0.
 */
export function createSqliteAddArtifactAuditVisibilityMigration(
  db: DatabaseSync,
): Migration {
  return {
    id: "0011_artifact_audit_visibility",
    async up(): Promise<void> {
      try {
        db.exec(
          "ALTER TABLE artifacts ADD COLUMN redaction_audit_visible INTEGER NOT NULL DEFAULT 1",
        );
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes("duplicate column name")
        ) {
          return;
        }
        throw error;
      }
    },
    async down(): Promise<void> {
      db.exec(
        "ALTER TABLE artifacts DROP COLUMN redaction_audit_visible",
      );
    },
  };
}

/**
 * Makes the SQLite metadata row the atomic pointer to immutable artifact
 * bytes. A transaction writes a fresh generation file, then commits this
 * pointer with the audit metadata; rollback leaves the prior pointer intact.
 * Legacy rows keep NULL and continue reading `<artifactId>.blob`.
 */
export function createSqliteAddArtifactBlobGenerationMigration(
  db: DatabaseSync,
): Migration {
  return {
    id: "0012_artifact_blob_generation",
    async up(): Promise<void> {
      try {
        db.exec(
          "ALTER TABLE artifacts ADD COLUMN blob_generation TEXT",
        );
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes("duplicate column name")
        ) {
          return;
        }
        throw error;
      }
    },
    async down(): Promise<void> {
      db.exec(
        "ALTER TABLE artifacts DROP COLUMN blob_generation",
      );
    },
  };
}

export const ALL_SQLITE_MIGRATIONS = (db: DatabaseSync): Migration[] => [
  createSqliteInitMigration(db),
  createSqliteAddDeploymentPromotedMigration(db),
  createSqliteAddApprovalTaskAuthenticatedAsMigration(db),
  createSqliteAddEventsTableMigration(db),
  createSqliteAddIdempotencySchemaVersionMigration(db),
  createSqliteAddRunRootTaintPathsMigration(db),
  createSqliteAddSecretAuditProvenanceMigration(db),
  createSqliteAddSealedOperationalStateMigration(db),
  createSqliteAddWaitOperationGenerationMigration(db),
  createSqliteAddProtectedContinuationStateMigration(db),
  createSqliteAddArtifactAuditVisibilityMigration(db),
  createSqliteAddArtifactBlobGenerationMigration(db),
];
