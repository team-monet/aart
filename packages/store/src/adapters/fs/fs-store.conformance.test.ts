// Runs the shared AartStore conformance suite (../../conformance.ts)
// against the fs adapter — the reference invocation Wave-1's SQLite/
// Postgres adapters mirror for themselves.
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { runAartStoreConformanceSuite } from "../../conformance.js";
import { createFsStore } from "./index.js";

const roots: string[] = [];

runAartStoreConformanceSuite("fs adapter", {
  createStore: async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "aart-store-conformance-"));
    roots.push(root);
    return createFsStore(root);
  },
});

afterAll(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
