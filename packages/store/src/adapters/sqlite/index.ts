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
import { AsyncMutex, createDirectExec, createLockedExec, openSqliteDb, type SqlExec } from "./db.js";
import { ALL_SQLITE_MIGRATIONS } from "./migrations.js";
import { SqliteArtifactStore } from "./stores/artifacts.js";
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

function buildStore(exec: SqlExec, blobsDir: string, transact: AartStore["transact"]): AartStore {
  return {
    workflows: new SqliteWorkflowStore(exec),
    runs: new SqliteRunStore(exec),
    waits: new SqliteWaitStore(exec),
    signals: new SqliteSignalStore(exec),
    artifacts: new SqliteArtifactStore(exec, blobsDir),
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
  const db = openSqliteDb(path);
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
  const txStore: AartStore = buildStore(directExec, blobsDir, async (fn) => fn(txStore));

  // The top-level view: every member's SQL acquires the mutex per call
  // (auto-committing per SQLite statement when issued outside an explicit
  // transaction). Its `transact` is the real BEGIN/COMMIT/ROLLBACK,
  // architecture §5.8.
  const topStore: AartStore = buildStore(lockedExec, blobsDir, (fn) =>
    mutex.run(async () => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = await fn(txStore);
        db.exec("COMMIT");
        return result;
      } catch (err) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // The connection may already have aborted the transaction on its
          // own (e.g. the error came from SQLite itself) — nothing further
          // to roll back in that case; the original `err` is what matters
          // to the caller regardless, re-thrown below.
        }
        throw err;
      }
    }),
  );

  if (options.runMigrations !== false) {
    const runner = new MigrationRunner(ALL_SQLITE_MIGRATIONS(db), new SqliteMigrationWatermarkStore(db), topStore);
    await runner.up();
  }

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
export { createSqliteInitMigration, ALL_SQLITE_MIGRATIONS } from "./migrations.js";
export { SqliteMigrationWatermarkStore } from "./watermark.js";
