// Runs the shared AartStore conformance suite (../../conformance.ts)
// against the SQLite adapter — the same suite the fs adapter runs
// (adapters/fs/fs-store.conformance.test.ts), per implementation plan
// Risk 2's direct countermeasure: "every adapter, including ones built
// later (SQLite in S2, Postgres in S9), MUST pass the identical suite."
// Includes the §5.8 transactional-contract test (the crash-between-writes
// all-or-nothing assertion) — this adapter has a REAL BEGIN/COMMIT/
// ROLLBACK (unlike the fs adapter's write-temp-then-rename simulation), so
// this is the genuine article, not a staged-buffer approximation.
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach } from "vitest";
import { runAartStoreConformanceSuite } from "../../conformance.js";
import { openSqliteStore, type SqliteStoreHandle } from "./index.js";

const dirs: string[] = [];
let handle: SqliteStoreHandle | undefined;

runAartStoreConformanceSuite("sqlite adapter", {
  createStore: async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "aart-store-sqlite-conformance-"));
    dirs.push(dir);
    handle = await openSqliteStore(join(dir, "aart.db"));
    return handle.store;
  },
  cleanup: async () => {
    handle?.close();
    handle = undefined;
  },
});

afterEach(() => {
  handle?.close();
  handle = undefined;
});

afterAll(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});
