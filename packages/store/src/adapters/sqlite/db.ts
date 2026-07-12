// Connection management, statement helpers, and the single-connection
// serialization mutex every store member in this adapter is built on.
//
// Uses Node's built-in `node:sqlite` (DatabaseSync) rather than adding
// `better-sqlite3`/`sqlite3` as a new native-addon dependency — see this
// task's final report / AMENDMENTS.md for the rationale (in short: the
// workspace already carries one native-addon platform-friction risk
// (isolated-vm, implementation plan Risk 3); `node:sqlite` is built into
// Node >=22 — matching this workspace's `engines.node` floor — so this
// adapter adds zero new native dependencies rather than a second one).
// `node:sqlite` is synchronous (DatabaseSync/StatementSync), same
// programming model as better-sqlite3; every AartStore method still
// returns a Promise (the interface is async throughout) so this is an
// internal implementation detail, invisible to callers.
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { MIGRATION_WATERMARK_TABLE_STATEMENT, SQLITE_SCHEMA_STATEMENTS } from "./schema.js";

/**
 * Serializes every operation issued against one `DatabaseSync` connection.
 *
 * Why this is required, not defensive-programming paranoia: `AartStore
 * .transact()` (architecture §5.8) must give a real BEGIN...COMMIT/ROLLBACK
 * around a caller-supplied async callback that itself issues further store
 * calls (`tx.runs.put(...)`, etc.) and may `await` other async work in
 * between. `node:sqlite` has exactly one connection here (one `DatabaseSync`
 * instance for the whole adapter — see `openSqliteDb` below) and SQLite
 * itself has no notion of "which in-process JS call issued this statement"
 * — a second, unrelated store call that runs on the same connection WHILE a
 * transaction is open would either execute as an unwitting part of that
 * open transaction or hit lock contention, neither of which is the
 * semantics any caller asked for. Routing every connection use (inside
 * `transact()` AND every top-level, non-transactional call) through this
 * one mutex guarantees only one logical unit of work ever touches the
 * connection at a time, which is what actually makes `transact()`'s
 * all-or-nothing contract hold under concurrent async callers (e.g. a
 * worker process running multiple claimed runs concurrently under
 * `maxConcurrentRuns`, architecture §4.3).
 */
export class AsyncMutex {
  private tail: Promise<unknown> = Promise.resolve();

  async run<T>(fn: () => Promise<T> | T): Promise<T> {
    const previous = this.tail;
    let release: () => void = () => {
      /* replaced below */
    };
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/** Runs `fn(db)` against the live connection. Two flavors are constructed below: `createLockedExec` (acquires the mutex — every top-level AartStore call) and `createDirectExec` (assumes the mutex is already held by an enclosing `transact()` call — every `tx` view's calls). */
export type SqlExec = <T>(fn: (db: DatabaseSync) => T) => Promise<T>;

export function createLockedExec(db: DatabaseSync, mutex: AsyncMutex): SqlExec {
  return (fn) => mutex.run(() => fn(db));
}

/** No locking — the caller (only ever `transact()`'s own callback machinery, see adapters/sqlite/index.ts) is already running inside a `mutex.run()` turn for the whole transaction's duration. */
export function createDirectExec(db: DatabaseSync): SqlExec {
  return (fn) => Promise.resolve(fn(db));
}

// ---------------------------------------------------------------------------
// Cross-process busy/lock retry (AMENDMENTS.md A58) — shared by this file's
// own openSqliteDb (bootstrapping a brand-new connection) and adapters/
// sqlite/index.ts's runMigrationsCoordinated (applying migrations). Both
// need the identical primitive: "retry a synchronous, possibly-throwing
// sqlite call a bounded number of times if — and only if — it failed because
// another connection currently holds the lock this one needs."
// ---------------------------------------------------------------------------

/**
 * `true` iff `err` is `node:sqlite`'s own SQLITE_BUSY ("database is locked")
 * — verified directly (a real BEGIN IMMEDIATE-vs-BEGIN IMMEDIATE contention
 * and, separately, two connections racing `PRAGMA journal_mode = WAL` on the
 * same brand-new file) that `node:sqlite` attaches a numeric `errcode` (the
 * raw SQLite result code, 5 for SQLITE_BUSY) to every thrown error — matching
 * that stable numeric code rather than `err.message`'s text, since `errstr`
 * for this code is always the same generic "database is locked" string
 * SQLite uses for every SQLITE_BUSY regardless of which statement hit it.
 */
export function isSqliteBusy(err: unknown): boolean {
  return typeof err === "object" && err !== null && "errcode" in err && (err as { errcode?: unknown }).errcode === 5;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retries `fn` — a single synchronous `db.exec`/statement call — with a
 * short, bounded linear backoff, when it throws SQLITE_BUSY. Belt-and-braces
 * on top of `PRAGMA busy_timeout` (openSqliteDb below), not a substitute for
 * it: `busy_timeout` covers the OVERWHELMING majority of real contention
 * (SQLite's own internal wait-then-retry, no application code involved) —
 * but verified directly, not assumed, that it does NOT reliably cover every
 * statement. Two genuinely separate OS processes racing to be the first to
 * switch the SAME brand-new database file to WAL mode (openSqliteDb's own
 * `PRAGMA journal_mode = WAL`) reproducibly threw SQLITE_BUSY immediately —
 * a real SQLITE_BUSY (errcode 5), not a different/unretriable error code —
 * DESPITE `PRAGMA busy_timeout` already being configured on both
 * connections beforehand: switching journal mode for the first time on a
 * file is a one-time operation that apparently doesn't route through the
 * same internal busy-handler retry path a normal statement does. An
 * application-level catch/sleep/retry closes that gap; `MIGRATION_LOCK_*`'s
 * own doc comment (adapters/sqlite/index.ts) has the analogous story for
 * `BEGIN IMMEDIATE` contention during migration application.
 */
export async function withSqliteBusyRetry<T>(fn: () => T, options: { maxAttempts?: number; baseDelayMs?: number } = {}): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 5;
  const baseDelayMs = options.baseDelayMs ?? 50;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return fn();
    } catch (err) {
      if (isSqliteBusy(err) && attempt < maxAttempts) {
        await sleep(baseDelayMs * attempt);
        continue;
      }
      throw err;
    }
  }
  // Unreachable: the loop above always either returns (fn() succeeded) or
  // throws (a non-busy error, or the final attempt's busy error).
  // TypeScript can't see that from the loop shape alone.
  throw new Error("withSqliteBusyRetry: exhausted retry attempts without returning or throwing — unreachable.");
}

/**
 * Async (AMENDMENTS.md A58 — was synchronous before this fix) because
 * bootstrapping a connection against a database file another OS process may
 * be concurrently bootstrapping for the very first time (`aart server` +
 * `aart worker`'s documented concurrent-startup topology, DEPLOY.md) now
 * needs `withSqliteBusyRetry`'s own retry-with-backoff, which requires
 * awaiting a real delay between attempts. Both of this function's only two
 * callers in this package (adapters/sqlite/index.ts's `openSqliteStore`,
 * this file's own sibling test `sqlite-store.test.ts`) already run inside an
 * `async` function — this is not part of this package's public export
 * surface (see adapters/sqlite/index.ts's own bottom-of-file export list),
 * so the blast radius of this signature change is fully contained to this
 * one package.
 */
export async function openSqliteDb(path: string): Promise<DatabaseSync> {
  const db = new DatabaseSync(path);
  // Order matters: busy_timeout MUST be the very first statement on this
  // connection, before anything else touches the file (including `PRAGMA
  // journal_mode = WAL` next) — a second/third connection's busy_timeout
  // can't help a FIRST connection that hasn't reached its own `PRAGMA
  // busy_timeout` line yet, and every statement below this one is itself
  // wrapped in withSqliteBusyRetry precisely because — per that function's
  // own doc comment — busy_timeout being SET is not, by itself, a complete
  // guarantee for every statement.
  await withSqliteBusyRetry(() => db.exec("PRAGMA busy_timeout = 5000"));
  // WAL mode — architecture §5.1: "One file, WAL mode for concurrent
  // worker+server reads." This matters across PROCESSES/connections (e.g.
  // `aart server` and `aart worker` both pointed at the same local SQLite
  // file) even though this adapter's own single connection is internally
  // serialized by AsyncMutex above for a different reason (BEGIN/COMMIT
  // correctness, not read concurrency).
  await withSqliteBusyRetry(() => db.exec("PRAGMA journal_mode = WAL"));
  await withSqliteBusyRetry(() => db.exec("PRAGMA foreign_keys = ON"));
  // Bootstrapping infrastructure, not a migration — see schema.ts's doc
  // comment on MIGRATION_WATERMARK_TABLE_STATEMENT for why this must exist
  // before MigrationRunner's first watermark read, independent of whether
  // migration 0001_init has applied yet.
  await withSqliteBusyRetry(() => db.exec(MIGRATION_WATERMARK_TABLE_STATEMENT));
  return db;
}

export function runMigrationDdl(db: DatabaseSync): void {
  for (const statement of SQLITE_SCHEMA_STATEMENTS) {
    db.exec(statement);
  }
}

// ---------------------------------------------------------------------------
// Statement helpers — thin wrappers so store-member files read as plain SQL
// + a params array rather than repeating StatementSync's get/all/run
// dance and JSON (de)serialization boilerplate at every call site.
// ---------------------------------------------------------------------------

export type SqlParam = string | number | bigint | null | Uint8Array;

const statementCache = new WeakMap<DatabaseSync, Map<string, StatementSync>>();

function prepared(db: DatabaseSync, sql: string): StatementSync {
  let cache = statementCache.get(db);
  if (!cache) {
    cache = new Map();
    statementCache.set(db, cache);
  }
  let stmt = cache.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    cache.set(sql, stmt);
  }
  return stmt;
}

export function dbGet<T = Record<string, unknown>>(db: DatabaseSync, sql: string, params: SqlParam[] = []): T | undefined {
  const row = prepared(db, sql).get(...params);
  return row as T | undefined;
}

export function dbAll<T = Record<string, unknown>>(db: DatabaseSync, sql: string, params: SqlParam[] = []): T[] {
  return prepared(db, sql).all(...params) as T[];
}

export function dbRun(db: DatabaseSync, sql: string, params: SqlParam[] = []): { changes: number | bigint } {
  return prepared(db, sql).run(...params);
}

/** JSON-encode for a TEXT column; `undefined` is stored as SQL NULL (not the string `"undefined"` — `JSON.stringify(undefined)` is itself `undefined`, not valid to bind). */
export function toJson(value: unknown): string | null {
  if (value === undefined) return null;
  return JSON.stringify(value);
}

export function fromJson<T>(text: string | null | undefined): T | undefined {
  if (text === null || text === undefined) return undefined;
  return JSON.parse(text) as T;
}

export function toBool(value: boolean | undefined): number {
  return value ? 1 : 0;
}

export function fromBool(value: number | undefined): boolean {
  return value === 1;
}

/**
 * Tri-state variant of `toBool`/`fromBool` above — for a column where
 * `undefined` is a THIRD, distinct state from `true`/`false`, not just
 * "falsy" (`fromBool`/`toBool` collapse `undefined` into `false`, which is
 * wrong for a column like `deployments.promoted`, D1 "remotes + push"
 * — AMENDMENTS.md A56 — where SQL `NULL` must read back as `undefined`,
 * never as `false`; see that migration's own doc comment for why: a
 * pre-migration row's `NULL` means "unset / always was active," not "made
 * inactive by this upgrade"). `toBoolOrNull` stores `undefined` as SQL
 * `NULL` rather than `0`, so this round-trips losslessly through
 * `fromBoolOrNull` on the way back out.
 */
export function toBoolOrNull(value: boolean | undefined): number | null {
  return value === undefined ? null : value ? 1 : 0;
}

export function fromBoolOrNull(value: number | null | undefined): boolean | undefined {
  return value === null || value === undefined ? undefined : value === 1;
}
