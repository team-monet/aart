// The SQLite adapter (architecture §5.1 "SQLite | Single-node production").
// S2's declared carve-out into S0's package (implementation plan §3
// preamble / Appendix ownership table) — everything in this directory is
// this session's to own; the AartStore interface, fs adapter, migration
// framework, and conformance suite one level up remain S0-frozen.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { MigrationRunner } from "../../migrations/index.js";
import type { AartStore } from "../../types.js";
import { AsyncMutex, createDirectExec, createLockedExec, openSqliteDb, withSqliteBusyRetry, type SqlExec } from "./db.js";
import { ALL_SQLITE_MIGRATIONS } from "./migrations.js";
import {
  recoverSqliteArtifactRedactions,
  SqliteArtifactStore,
} from "./stores/artifacts.js";
import { SqliteEventLogStore } from "./stores/events.js";
import { SqliteRunStore } from "./stores/runs.js";
import { SqliteSignalStore } from "./stores/signals.js";
import {
  SqliteApprovalStore,
  SqliteCorrectionStore,
  SqliteDeploymentStore,
  SqliteEnvironmentStore,
  SqliteEvalStore,
  SqliteIdempotencyLedgerStore,
  SqliteJobQueueStore,
  SqlitePackManifestStore,
  SqlitePromptRegistryStore,
  SqliteRejectedTriggerStore,
  SqliteScheduleStore,
  SqliteSchemaRegistryStore,
  SqliteStandingApprovalStore,
} from "./stores/simple-stores.js";
import { SqliteWaitStore } from "./stores/waits.js";
import { SqliteWorkflowStore } from "./stores/workflows.js";
import { SqliteMigrationWatermarkStore } from "./watermark.js";

export interface SqliteStoreHandle {
  store: AartStore;
  /** The raw connection — exposed for adapter-specific tests (WAL-mode assertions, direct-DDL smoke tests) and for advanced callers (e.g. driving `MigrationRunner` explicitly). Store-member implementations never need this directly outside this module; every `AartStore` operation goes through it via the `SqlExec` indirection (db.ts), which is what makes `transact()`'s serialization guarantee hold. */
  db: DatabaseSync;
  close(): void;
}

export interface CreateSqliteStoreOptions {
  /** Directory artifact blobs are written under (architecture §5.4 — SQLite holds only Artifact metadata; bytes live in a separate blob store). Defaults to a sibling `<path>.blobs/` directory next to the database file, or a fresh temp directory for `:memory:`. */
  blobsDir?: string;
  /** Apply this adapter's own migration DDL (0001_init, see migrations.ts) immediately after opening, advancing `_migration_watermark` accordingly. Defaults to true — the common case for tests and simple callers. Pass `false` for explicit control over migration timing (e.g. testing `MigrationRunner` itself, or applying migrations as a distinct deploy step ahead of starting the server/worker). */
  runMigrations?: boolean;
}

function defaultBlobsDir(path: string): string {
  if (path === ":memory:") {
    return join(tmpdir(), `aart-sqlite-blobs-${randomUUID()}`);
  }
  return `${path}.blobs`;
}

/**
 * Cross-process migration coordination (AMENDMENTS.md A58). `MigrationRunner
 * .up()` itself (../../migrations/types.ts, S0-frozen/adapter-agnostic) does
 * a plain "read watermark, apply each pending migration, write watermark"
 * sequence with no locking of its own — correct for a single writer, but
 * `aart server` and `aart worker` are DEPLOY.md's own documented concurrent-
 * startup topology (two separate OS processes, each with its own
 * `DatabaseSync` connection and its own in-process-only `AsyncMutex`, db.ts —
 * that mutex serializes calls WITHIN one connection, it has no cross-process
 * reach at all). Two processes opening the SAME fresh store at once can both
 * read watermark 0 and both attempt migration 0002's non-idempotent `ALTER
 * TABLE ADD COLUMN` (0001 is `CREATE TABLE IF NOT EXISTS`, so this race
 * existed from the day this adapter shipped, just masked until a non-
 * idempotent migration existed to expose it — see migrations.ts's own 0002
 * doc comment). Reproduced directly before this fix (two concurrent
 * `openSqliteStore` calls against the same fresh path, this fix's own
 * verification, reverted-and-confirmed per this session's report): "duplicate
 * column name: promoted" (the loser reads watermark 1 after the winner
 * already advanced it, then re-runs 0002 anyway), and — once busy_timeout's
 * retry window is exhausted under real contention — "database is locked".
 *
 * Fixed with real cross-process mutual exclusion instead: SQLite's `BEGIN
 * IMMEDIATE` acquires the write lock immediately (rather than deferring it
 * to the first write statement, `BEGIN DEFERRED`'s default) — a second
 * process's own `BEGIN IMMEDIATE` against the SAME file blocks (retried by
 * `openSqliteDb`'s `PRAGMA busy_timeout`) until the first commits. Wrapping
 * the ENTIRE read-watermark -> apply-pending -> write-watermark sequence
 * inside one such transaction turns `MigrationRunner.up()`'s own internal
 * `watermark.read()` — the FIRST thing it does — into the "recheck inside
 * the lock" half of double-checked locking: by the time a second process's
 * `BEGIN IMMEDIATE` finally acquires the lock (after the first process's
 * `COMMIT`), its own read inside THIS transaction sees the fully-applied,
 * fully-committed watermark the first process just wrote, and `MigrationRunner
 * .up()`'s own per-migration `if (ordinal <= current) continue;` check
 * correctly skips everything already applied. No separate pre-lock check is
 * needed on top — migrations are a startup-only, not-hot-path operation, so
 * an extra `BEGIN IMMEDIATE`/`COMMIT` pair around an already-migrated store's
 * single watermark read costs microseconds, not a measurable startup delay.
 *
 * `db.ts`'s `withSqliteBusyRetry` wraps the `BEGIN IMMEDIATE` acquire step
 * itself as belt-and-braces on top of `busy_timeout` — see that function's
 * own doc comment for why a bounded application-level retry is needed even
 * with `busy_timeout` already configured (verified directly, not assumed:
 * it does not cover every statement).
 */
async function runMigrationsCoordinated(db: DatabaseSync, topStore: AartStore): Promise<number> {
  await withSqliteBusyRetry(() => db.exec("BEGIN IMMEDIATE"));
  try {
    const runner = new MigrationRunner(ALL_SQLITE_MIGRATIONS(db), new SqliteMigrationWatermarkStore(db), topStore);
    const result = await runner.up();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The connection may already have aborted the transaction on its own
      // (e.g. the error came from SQLite itself) — same pattern/rationale as
      // the identical rollback-may-itself-fail handling in this file's own
      // topStore.transact() below; nothing further to roll back in that
      // case, and the original `err` is what matters to the caller
      // regardless, re-thrown here.
    }
    throw err;
  }
}

function buildStore(
  exec: SqlExec,
  blobsDir: string,
  transact: AartStore["transact"],
  transactionScoped: boolean,
): AartStore {
  return {
    workflows: new SqliteWorkflowStore(exec),
    runs: new SqliteRunStore(exec),
    waits: new SqliteWaitStore(exec, blobsDir),
    signals: new SqliteSignalStore(exec, blobsDir),
    artifacts: new SqliteArtifactStore(
      exec,
      blobsDir,
      transactionScoped,
    ),
    approvals: new SqliteApprovalStore(exec),
    corrections: new SqliteCorrectionStore(exec),
    evals: new SqliteEvalStore(exec),
    deployments: new SqliteDeploymentStore(exec),
    environments: new SqliteEnvironmentStore(exec),
    schedules: new SqliteScheduleStore(exec),
    promptRegistry: new SqlitePromptRegistryStore(exec),
    schemaRegistry: new SqliteSchemaRegistryStore(exec),
    packManifests: new SqlitePackManifestStore(exec),
    rejectedTriggers: new SqliteRejectedTriggerStore(exec),
    standingApprovals: new SqliteStandingApprovalStore(exec),
    events: new SqliteEventLogStore(exec),
    jobQueue: new SqliteJobQueueStore(exec),
    idempotencyLedger: new SqliteIdempotencyLedgerStore(exec),
    transact,
  };
}

/**
 * Opens (creating if necessary) a SQLite-backed `AartStore`. `path` is a
 * filesystem path, or `:memory:` for an ephemeral in-process database
 * (tests / the conformance suite).
 *
 * Async — unlike the fs adapter's synchronous `createFsStore(root):
 * AartStore` — because opening a real connection and applying migration
 * DDL (by default) are both real, if fast, async-shaped work; a caller
 * that wants the bare synchronous connection-construction step without
 * migrations can pass `runMigrations: false` and drive
 * `new MigrationRunner(...)` itself.
 */
export async function openSqliteStore(path: string, options: CreateSqliteStoreOptions = {}): Promise<SqliteStoreHandle> {
  const db = await openSqliteDb(path);
  const blobsDir = options.blobsDir ?? defaultBlobsDir(path);
  if (!existsSync(blobsDir)) {
    mkdirSync(blobsDir, { recursive: true });
  } else if (path !== ":memory:" && !existsSync(dirname(path))) {
    mkdirSync(dirname(path), { recursive: true });
  }

  const mutex = new AsyncMutex();
  const lockedExec = createLockedExec(db, mutex);
  const directExec = createDirectExec(db);

  // The `tx` view: every member's SQL runs directly against `db` (no mutex
  // re-acquisition — see db.ts's AsyncMutex doc comment for why acquiring
  // it a second time here would deadlock against the outer `transact()`
  // call already holding it). Its own `transact` is a reentrant pass-
  // through, matching the fs adapter's documented behavior ("Nested
  // transact() calls reuse the same buffer/view rather than creating a
  // fresh nested one").
  const txStore: AartStore = buildStore(
    directExec,
    blobsDir,
    async (fn) => fn(txStore),
    true,
  );

  // The top-level view: every member's SQL acquires the mutex per call
  // (auto-committing per SQLite statement when issued outside an explicit
  // transaction). Its `transact` is the real BEGIN/COMMIT/ROLLBACK,
  // architecture §5.8.
  const topStore: AartStore = buildStore(lockedExec, blobsDir, (fn) =>
    mutex.run(async () => {
      db.exec("BEGIN IMMEDIATE");
      let result: Awaited<ReturnType<typeof fn>>;
      try {
        result = await fn(txStore);
        db.exec("COMMIT");
      } catch (err) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // The connection may already have aborted the transaction on its
          // own (e.g. the error came from SQLite itself) — nothing further
          // to roll back in that case; the original `err` is what matters
          // to the caller regardless, re-thrown below.
        }
        await recoverSqliteArtifactRedactions(
          directExec,
          blobsDir,
        );
        throw err;
      }
      await recoverSqliteArtifactRedactions(
        directExec,
        blobsDir,
      );
      return result;
    }),
    false,
  );

  if (options.runMigrations !== false) {
    // AMENDMENTS.md A58 — was a bare `new MigrationRunner(...).up()` call
    // here, with no coordination against another OS process doing the exact
    // same thing against the same fresh file at the same time (DEPLOY.md's
    // own documented `aart server` + `aart worker` concurrent-startup
    // topology). See runMigrationsCoordinated's own doc comment for the
    // reproduced crash and the fix.
    await runMigrationsCoordinated(db, topStore);
  }
  await recoverSqliteArtifactRedactions(
    lockedExec,
    blobsDir,
  );

  return {
    store: topStore,
    db,
    close: () => db.close(),
  };
}

/** Convenience wrapper returning just the `AartStore` — for callers (e.g. `@aart/server`'s composition root) that don't need the connection handle directly. Prefer `openSqliteStore` when you need `close()` (tests, short-lived CLI commands) or the raw `db` (adapter-specific diagnostics). */
export async function createSqliteStore(path: string, options: CreateSqliteStoreOptions = {}): Promise<AartStore> {
  const { store } = await openSqliteStore(path, options);
  return store;
}

/** Applies this adapter's migration DDL directly against a connection, bypassing `MigrationRunner`/the watermark table entirely — exposed for the rare case a caller wants schema-only setup with no migration bookkeeping (e.g. a disposable test fixture). Prefer `openSqliteStore`'s default (`runMigrations: true`, watermark-tracked) for anything that behaves like a real deployment. */
export { runMigrationDdl } from "./db.js";
export {
  createSqliteInitMigration,
  createSqliteAddDeploymentPromotedMigration,
  createSqliteAddEventsTableMigration,
  createSqliteAddIdempotencySchemaVersionMigration,
  createSqliteAddSecretAuditProvenanceMigration,
  createSqliteAddSealedOperationalStateMigration,
  createSqliteAddWaitOperationGenerationMigration,
  createSqliteAddProtectedContinuationStateMigration,
  ALL_SQLITE_MIGRATIONS,
} from "./migrations.js";
export { SqliteMigrationWatermarkStore } from "./watermark.js";
