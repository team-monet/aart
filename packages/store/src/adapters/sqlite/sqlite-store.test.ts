// SQLite-adapter-specific behaviors not covered by the adapter-agnostic
// conformance suite: WAL mode (architecture §5.1), migration-watermark
// tracking via the real MigrationRunner, cross-connection claim race
// safety (architecture ADR-05's ".SELECT ... FOR UPDATE SKIP LOCKED or
// equivalent" concern — SQLite's equivalent is a conditional UPDATE
// serialized by the file-level write lock, see stores/simple-stores.ts's
// SqliteJobQueueStore doc comment), and concurrent transact() serialization
// on one connection (db.ts's AsyncMutex).
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MigrationRunner } from "../../migrations/index.js";
import type { AartStore } from "../../types.js";
import { openSqliteDb } from "./db.js";
import { openSqliteStore, type SqliteStoreHandle } from "./index.js";
import { ALL_SQLITE_MIGRATIONS } from "./migrations.js";
import { SqliteMigrationWatermarkStore } from "./watermark.js";

let dir: string;
let handle: SqliteStoreHandle;
let store: AartStore;

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "aart-store-sqlite-"));
  handle = await openSqliteStore(join(dir, "aart.db"));
  store = handle.store;
});

afterEach(async () => {
  handle.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("SQLite adapter — connection setup (architecture §5.1)", () => {
  it("opens in WAL journal mode", () => {
    const row = handle.db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(row.journal_mode).toBe("wal");
  });

  it("auto-runs migrations by default, advancing the watermark to the latest ordinal (2, since D1's 0002_deployment_promoted — AMENDMENTS.md A56)", async () => {
    const watermark = new SqliteMigrationWatermarkStore(handle.db);
    await expect(watermark.read()).resolves.toBe(2);
  });

  it("runMigrations: false skips DDL — store calls fail against the not-yet-created schema", async () => {
    const dir2 = await fs.mkdtemp(join(tmpdir(), "aart-store-sqlite-nomigrate-"));
    const handle2 = await openSqliteStore(join(dir2, "aart.db"), { runMigrations: false });
    try {
      await expect(handle2.store.workflows.listWorkflowIds()).rejects.toThrow();
    } finally {
      handle2.close();
      await fs.rm(dir2, { recursive: true, force: true });
    }
  });

  it("MigrationRunner can be driven explicitly against a runMigrations:false store, and is idempotent", async () => {
    const dir3 = await fs.mkdtemp(join(tmpdir(), "aart-store-sqlite-explicit-migrate-"));
    const handle3 = await openSqliteStore(join(dir3, "aart.db"), { runMigrations: false });
    try {
      const runner = new MigrationRunner(ALL_SQLITE_MIGRATIONS(handle3.db), new SqliteMigrationWatermarkStore(handle3.db), handle3.store);
      await expect(runner.currentVersion()).resolves.toBe(0);
      // D1 (AMENDMENTS.md A56): two migrations now registered (0001_init,
      // 0002_deployment_promoted) — up() from watermark 0 applies both in
      // one call, landing on the latest ordinal.
      await expect(runner.up()).resolves.toBe(2);
      await expect(handle3.store.workflows.listWorkflowIds()).resolves.toEqual([]);
      // Idempotent re-run.
      await expect(runner.up()).resolves.toBe(2);
    } finally {
      handle3.close();
      await fs.rm(dir3, { recursive: true, force: true });
    }
  });
});

describe("SQLite adapter — job_queue claim race safety across connections (architecture ADR-05)", () => {
  it("two separate connections attempting setClaim on the same run: only one wins", async () => {
    const dbPath = join(dir, "aart.db");
    await store.jobQueue.enqueue("run_race_1", 0);

    // A second, independent connection to the SAME file — simulating a
    // second `aart worker` process racing this one for the same claim.
    const otherDb = await openSqliteDb(dbPath);
    try {
      const future = new Date(Date.now() + 60_000).toISOString();

      // Both "workers" attempt the SAME conditional UPDATE concurrently.
      // node:sqlite is synchronous per call, so within this single Node
      // process these two calls aren't truly concurrent at the OS-thread
      // level — but they exercise the real conditional-UPDATE mechanism
      // (WHERE claimed_by IS NULL OR lease_expires_at <= ?) that is what
      // actually protects against two real worker PROCESSES racing over a
      // shared SQLite file, so this proves the mechanism is genuinely
      // conditional, not merely "last write wins."
      otherDb.exec("BEGIN IMMEDIATE");
      otherDb
        .prepare("UPDATE job_queue SET claimed_by = ?, claimed_at = ?, lease_expires_at = ? WHERE run_id = ? AND (claimed_by IS NULL OR lease_expires_at <= ?)")
        .run("worker-B", new Date().toISOString(), future, "run_race_1", new Date().toISOString());
      otherDb.exec("COMMIT");

      // The first worker's claim attempt, issued AFTER worker-B already
      // committed its claim, must be a no-op (0 rows matched — claimed_by
      // is no longer NULL).
      await store.jobQueue.setClaim("run_race_1", "worker-A", future);
      await expect(store.jobQueue.get("run_race_1")).resolves.toMatchObject({ claimedBy: "worker-B" });
    } finally {
      otherDb.close();
    }
  });

  it("setClaim is a silent no-op (not an overwrite) when the race is lost — caller must re-read to confirm", async () => {
    await store.jobQueue.enqueue("run_race_2", 0);
    const future = new Date(Date.now() + 60_000).toISOString();
    await store.jobQueue.setClaim("run_race_2", "worker-A", future);
    // A second setClaim from a different worker, lease not yet expired —
    // must NOT overwrite worker-A's claim.
    await store.jobQueue.setClaim("run_race_2", "worker-B", future);
    await expect(store.jobQueue.get("run_race_2")).resolves.toMatchObject({ claimedBy: "worker-A" });
  });

  it("a claim IS won once the previous lease has expired", async () => {
    await store.jobQueue.enqueue("run_race_3", 0);
    const past = new Date(Date.now() - 60_000).toISOString();
    await store.jobQueue.setClaim("run_race_3", "worker-A", past);
    const future = new Date(Date.now() + 60_000).toISOString();
    await store.jobQueue.setClaim("run_race_3", "worker-B", future);
    await expect(store.jobQueue.get("run_race_3")).resolves.toMatchObject({ claimedBy: "worker-B" });
  });
});

describe("SQLite adapter — transact() serialization on one connection (db.ts AsyncMutex)", () => {
  it("two concurrent transact() calls on the same store never interleave — the second sees the first's committed result", async () => {
    const events: string[] = [];

    const slow = store.transact(async (tx) => {
      events.push("slow:start");
      await tx.runs.put({
        runId: "run_tx_a",
        workflowId: "wf",
        workflowVersion: "1",
        status: "running",
        approved: true,
        approvalMode: "governed",
        trigger: { type: "manual", id: "t1", source: "cli", payload: null, receivedAt: new Date().toISOString() },
        inputs: {},
        trace: [],
        waits: [],
        artifacts: [],
        snapshot: { definitions: {}, resolvedVersions: {}, packHashes: {}, capturedAt: new Date().toISOString() },
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        schemaVersion: 1,
      });
      // Yield the microtask queue — if the mutex didn't serialize
      // transact() calls, the "fast" transaction below could interleave
      // its own BEGIN here, which node:sqlite would reject (or worse,
      // silently corrupt transaction boundaries).
      await new Promise((resolve) => setTimeout(resolve, 10));
      events.push("slow:end");
    });

    const fast = store.transact(async (tx) => {
      events.push("fast:start");
      await expect(tx.runs.get("run_tx_a")).resolves.toMatchObject(events.includes("slow:end") ? { runId: "run_tx_a" } : {});
      events.push("fast:end");
    });

    await Promise.all([slow, fast]);
    // The mutex guarantees one transaction fully finishes before the next
    // starts — never interleaved.
    expect(events).toEqual(["slow:start", "slow:end", "fast:start", "fast:end"]);
  });

  it("a non-transactional call issued while a transact() is in flight waits its turn rather than erroring", async () => {
    const txPromise = store.transact(async (tx) => {
      await tx.environments.put({ id: "env_wait", name: "staging-wait", config: {} });
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    // Issued concurrently, NOT inside the transaction — must not throw
    // "cannot start a transaction within a transaction" or similar.
    const readPromise = store.environments.list();
    await Promise.all([txPromise, readPromise]);
    await expect(store.environments.getByName("staging-wait")).resolves.toBeDefined();
  });
});
