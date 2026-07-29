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
  consumed_by_run_id: string | null;
  consumed_by_step_id: string | null;
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
        "INSERT INTO signals (signal_id, name, correlation_id, payload_json, received_at, consumed_at, consumed_by_run_id, consumed_by_step_id) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL)",
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
    options?: {
      payload?: unknown;
      consumedBy?: { runId: string; stepId: string };
    },
  ): Promise<void> {
    const assignments = ["consumed_at = COALESCE(consumed_at, ?)"];
    const params: Array<string | null> = [new Date().toISOString()];
    if (options !== undefined && "payload" in options) {
      assignments.push("payload_json = ?");
      params.push(JSON.stringify(options.payload) ?? "null");
    }
    if (options?.consumedBy !== undefined) {
      assignments.push("consumed_by_run_id = ?", "consumed_by_step_id = ?");
      params.push(
        options.consumedBy.runId,
        options.consumedBy.stepId,
      );
    }
    params.push(signalId);
    await this.exec((db) =>
      dbRun(
        db,
        `UPDATE signals SET ${assignments.join(", ")} WHERE signal_id = ?`,
        params,
      ),
    );
  }

  async listConsumedByRun(runId: string): Promise<Signal[]> {
    const rows = await this.exec((db) =>
      dbAll<SignalRow>(
        db,
        "SELECT * FROM signals WHERE consumed_at IS NOT NULL AND consumed_by_run_id = ?",
        [runId],
      ),
    );
    return rows.map(rowToSignal);
  }

  async listConsumedWithoutProvenance(): Promise<Signal[]> {
    const rows = await this.exec((db) =>
      dbAll<SignalRow>(
        db,
        "SELECT * FROM signals WHERE consumed_at IS NOT NULL AND consumed_by_run_id IS NULL",
      ),
    );
    return rows.map(rowToSignal);
  }

  async replaceConsumedAudit(
    signalId: string,
    audit: Pick<Signal, "name" | "correlationId" | "payload">,
  ): Promise<void> {
    await this.exec((db) =>
      dbRun(
        db,
        `UPDATE signals
         SET name = ?, correlation_id = ?, payload_json = ?
         WHERE signal_id = ? AND consumed_at IS NOT NULL`,
        [
          audit.name,
          audit.correlationId,
          JSON.stringify(audit.payload) ?? "null",
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
