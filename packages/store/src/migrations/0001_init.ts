// The initial migration — establishes watermark 1. Every AartStore member
// directory is created lazily on first write (adapters/fs/json-file.ts's
// atomicWriteFile does `mkdir({ recursive: true })`), so there is no real
// fs-specific setup this migration must perform for the fs adapter; its
// job is to exist as the baseline every later migration's `down()` reverts
// toward. A hypothetical SQLite/Postgres adapter's own 0001_init (Wave-1
// scope, S2/S9) would have real DDL here instead.
import type { Migration } from "./types.js";

export const migration0001Init: Migration = {
  id: "0001_init",
  async up(): Promise<void> {
    // No-op for the fs adapter — see module doc comment above.
  },
  async down(): Promise<void> {
    // No-op — reverting below the baseline migration has no meaningful
    // action for the fs adapter (there is no prior state to restore to).
  },
};
