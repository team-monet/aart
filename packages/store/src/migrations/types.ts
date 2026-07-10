// Migration framework — architecture §5.5 ("from day one," ADR-03):
// deliberately unglamorous, plain numbered TS modules each exporting
// up(store)/down(store), with a schema_version watermark. No migration DSL
// — "the goal on day one is a place migrations go, not a sophisticated
// migration engine."
//
// Written against the `AartStore` interface (not fs-specific) so the same
// `Migration`/`MigrationRunner` shapes are reusable by the SQLite/Postgres
// adapters Wave 1 builds — only the `MigrationWatermarkStore` needs an
// adapter-specific implementation (the fs one lives at
// adapters/fs/watermark.ts, backing `schema-version.json`).
import type { AartStore } from "../types.js";

export interface Migration {
  /** e.g. "0001_init" — must start with a zero-padded ordinal followed by "_", which is what MigrationRunner sorts and tracks the watermark by. */
  id: string;
  up(store: AartStore): Promise<void>;
  down(store: AartStore): Promise<void>;
}

/**
 * `schema-version.json`'s whole-store migration watermark (architecture
 * §5.5) — distinct from the per-record `schemaVersion` tag on
 * WaitCondition/RunRecord (architecture §4.7, @aart/types' run.ts/wait.ts):
 * this tracks the *store's* applied-migrations watermark, not an individual
 * record's shape version.
 */
export interface MigrationWatermarkStore {
  read(): Promise<number>;
  write(version: number): Promise<void>;
}

function migrationOrdinal(id: string): number {
  const match = /^(\d+)_/.exec(id);
  if (!match) {
    throw new Error(`Migration id "${id}" must start with a zero-padded ordinal followed by "_" (e.g. "0001_init").`);
  }
  return Number(match[1]);
}

export class MigrationRunner {
  private readonly sorted: Migration[];

  constructor(
    migrations: Migration[],
    private readonly watermark: MigrationWatermarkStore,
    private readonly store: AartStore,
  ) {
    this.sorted = [...migrations].sort((a, b) => migrationOrdinal(a.id) - migrationOrdinal(b.id));
    const ordinals = this.sorted.map((m) => migrationOrdinal(m.id));
    if (new Set(ordinals).size !== ordinals.length) {
      throw new Error(`Duplicate migration ordinal among: ${this.sorted.map((m) => m.id).join(", ")}`);
    }
  }

  async currentVersion(): Promise<number> {
    return this.watermark.read();
  }

  /** Applies every migration whose ordinal is greater than the current watermark, in ascending order, advancing the watermark after each one succeeds. Idempotent — re-running with nothing new to apply is a no-op. Returns the resulting watermark. */
  async up(): Promise<number> {
    let current = await this.watermark.read();
    for (const migration of this.sorted) {
      const ordinal = migrationOrdinal(migration.id);
      if (ordinal <= current) continue;
      await migration.up(this.store);
      await this.watermark.write(ordinal);
      current = ordinal;
    }
    return current;
  }

  /** Reverts exactly the single migration currently at the watermark (calling its `down()`), then sets the watermark to the previous migration's ordinal (or 0 if there isn't one). Returns the resulting watermark. A no-op (returns 0) if already at watermark 0. */
  async down(): Promise<number> {
    const current = await this.watermark.read();
    if (current === 0) return 0;
    const currentMigration = this.sorted.find((m) => migrationOrdinal(m.id) === current);
    if (!currentMigration) {
      throw new Error(`No registered migration has ordinal ${current} (the current watermark) — cannot determine how to revert it.`);
    }
    await currentMigration.down(this.store);
    const previous = this.sorted.filter((m) => migrationOrdinal(m.id) < current).at(-1);
    const newWatermark = previous ? migrationOrdinal(previous.id) : 0;
    await this.watermark.write(newWatermark);
    return newWatermark;
  }
}
