// SQLite-backed MigrationWatermarkStore — `_migration_watermark` table (see
// schema.ts's doc comment for why this table is deliberately NOT named
// `schema_version`, unlike the fs adapter's `schema-version.json`).
import type { DatabaseSync } from "node:sqlite";
import type { MigrationWatermarkStore } from "../../migrations/types.js";
import { dbGet, dbRun } from "./db.js";

export class SqliteMigrationWatermarkStore implements MigrationWatermarkStore {
  constructor(private readonly db: DatabaseSync) {}

  async read(): Promise<number> {
    const row = dbGet<{ version: number }>(this.db, "SELECT version FROM _migration_watermark WHERE id = 1");
    return row?.version ?? 0;
  }

  async write(version: number): Promise<void> {
    dbRun(
      this.db,
      "INSERT INTO _migration_watermark (id, version) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET version = excluded.version",
      [version],
    );
  }
}
