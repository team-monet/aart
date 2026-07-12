// @aart/store — the AartStore interface, fs adapter, migration framework,
// adapter-conformance suite, and the shared structured logger (architecture
// §5, §16). SQLite/Postgres adapters are Wave-1 scope and live in
// adapters/{sqlite,postgres}/** as a declared carve-out into this same
// package (implementation plan §3's preamble / Appendix ownership table).

export * from "./types.js";
export * from "./logger.js";
export * from "./conformance.js";
export * from "./event-log.js";

export { createFsStore } from "./adapters/fs/index.js";
export { FsMigrationWatermarkStore } from "./adapters/fs/watermark.js";

export { ALL_MIGRATIONS, MigrationRunner, migration0001Init, type Migration, type MigrationWatermarkStore } from "./migrations/index.js";
