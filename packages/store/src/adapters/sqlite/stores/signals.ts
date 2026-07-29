// SignalStore — architecture §5.3 `signals` table. Unlike the fs adapter's
// SignalStore (deliberately excluded from `transact()` staging per
// architecture §5.8's documented non-atomic gap), THIS adapter's
// `signals` writes DO participate in the real SQLite transaction opened by
// `transact()` — see adapters/sqlite/index.ts's doc comment: SQLite gives a
// genuine BEGIN/COMMIT, so there is no equivalent "fs has no native
// cross-file transaction" gap to preserve here. This is a real, positive
// capability difference between the two adapters, not an inconsistency —
// architecture §5.8 states the fs gap is fs-specific ("SQLite/Postgres have
// no equivalent gap — both `signals.consumed_at` and the `runs`/
// `step_traces` update happen inside the same native transaction").
import type { Signal } from "@aart/types";
import type { SignalStore } from "../../../types.js";
import { dbAll, dbGet, dbRun, type SqlExec } from "../db.js";

interface SignalRow {
  signal_id: string;
  name: string;
  correlation_id: string;
  payload_json: string;
  received_at: string;
  consumed_at: string | null;
}

function rowToSignal(row: SignalRow): Signal {
  return {
    id: row.signal_id,
    name: row.name,
    correlationId: row.correlation_id,
    payload: JSON.parse(row.payload_json) as unknown,
    receivedAt: row.received_at,
  };
}

export class SqliteSignalStore implements SignalStore {
  constructor(private readonly exec: SqlExec) {}

  async append(signal: Signal): Promise<void> {
    await this.exec((db) =>
      dbRun(
        db,
        "INSERT INTO signals (signal_id, name, correlation_id, payload_json, received_at, consumed_at) VALUES (?, ?, ?, ?, ?, NULL)",
        [signal.id, signal.name, signal.correlationId, JSON.stringify(signal.payload), signal.receivedAt],
      ),
    );
  }

  async findUnconsumedMatch(name: string, correlationId: string): Promise<Signal | undefined> {
    const row = await this.exec((db) =>
      dbGet<SignalRow>(
        db,
        "SELECT * FROM signals WHERE name = ? AND correlation_id = ? AND consumed_at IS NULL ORDER BY received_at ASC LIMIT 1",
        [name, correlationId],
      ),
    );
    return row ? rowToSignal(row) : undefined;
  }

  async markConsumed(
    signalId: string,
    options?: { payload: unknown },
  ): Promise<void> {
    await this.exec((db) =>
      options === undefined
        ? dbRun(
            db,
            "UPDATE signals SET consumed_at = ? WHERE signal_id = ?",
            [new Date().toISOString(), signalId],
          )
        : dbRun(
            db,
            "UPDATE signals SET consumed_at = ?, payload_json = ? WHERE signal_id = ?",
            [
              new Date().toISOString(),
              JSON.stringify(options.payload) ?? "null",
              signalId,
            ],
          ),
    );
  }

  async list(): Promise<Signal[]> {
    const rows = await this.exec((db) => dbAll<SignalRow>(db, "SELECT * FROM signals"));
    return rows.map(rowToSignal);
  }
}
