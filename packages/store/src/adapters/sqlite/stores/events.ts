// EventLogStore — V1 event log foundation (AMENDMENTS.md A61), the `events`
// table created by migration `0004_events_table` (../migrations.ts). Writes
// participate in SQLite's real transaction; the filesystem sibling now
// provides equivalent logical atomicity through its durable redo journal
// (A76).
import type { EventLogEntry } from "@aart/types";
import type { EventLogStore } from "../../../types.js";
import { dbAll, dbRun, type SqlExec, type SqlParam } from "../db.js";

interface EventRow {
  id: string;
  type: string;
  occurred_at: string;
  summary: string;
  workflow_id: string | null;
  workflow_version: string | null;
  run_id: string | null;
  deployment_id: string | null;
  environment_id: string | null;
  approval_task_id: string | null;
  actor: string | null;
}

function rowToEvent(row: EventRow): EventLogEntry {
  return {
    id: row.id,
    type: row.type,
    occurredAt: row.occurred_at,
    summary: row.summary,
    workflowId: row.workflow_id ?? undefined,
    workflowVersion: row.workflow_version ?? undefined,
    runId: row.run_id ?? undefined,
    deploymentId: row.deployment_id ?? undefined,
    environmentId: row.environment_id ?? undefined,
    approvalTaskId: row.approval_task_id ?? undefined,
    actor: row.actor ?? undefined,
  };
}

export class SqliteEventLogStore implements EventLogStore {
  constructor(private readonly exec: SqlExec) {}

  async append(entry: EventLogEntry): Promise<void> {
    await this.exec((db) =>
      dbRun(
        db,
        `INSERT INTO events (id, type, occurred_at, summary, workflow_id, workflow_version, run_id, deployment_id, environment_id, approval_task_id, actor)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          entry.id,
          entry.type,
          entry.occurredAt,
          entry.summary,
          entry.workflowId ?? null,
          entry.workflowVersion ?? null,
          entry.runId ?? null,
          entry.deploymentId ?? null,
          entry.environmentId ?? null,
          entry.approvalTaskId ?? null,
          entry.actor ?? null,
        ],
      ),
    );
  }

  async replaceAudit(
    eventId: string,
    audit: { summary: string; actor?: string },
  ): Promise<void> {
    await this.exec((db) =>
      dbRun(
        db,
        "UPDATE events SET summary = ?, actor = ? WHERE id = ?",
        [audit.summary, audit.actor ?? null, eventId],
      ),
    );
  }

  async list(filter?: {
    since?: string;
    limit?: number;
    runId?: string;
  }): Promise<EventLogEntry[]> {
    const clauses: string[] = [];
    const params: SqlParam[] = [];
    if (filter?.since) {
      clauses.push("occurred_at >= ?");
      params.push(filter.since);
    }
    if (filter?.runId) {
      clauses.push("run_id = ?");
      params.push(filter.runId);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    let limitClause = "";
    if (filter?.limit !== undefined) {
      // D2b/V1 fix pass (AMENDMENTS.md A63, FIX 3) — SQLite treats a
      // negative `LIMIT` as "no limit at all" (its own documented
      // behavior), the OPPOSITE of the fs sibling adapter's pre-fix
      // `slice(0, -N)` ("drop the last N") — two adapters silently
      // disagreeing about what a negative limit even means, let alone
      // returning the same rows. Clamped to 0 here — "zero rows," the same
      // safe-direction choice `adapters/fs/events.ts` makes, never
      // "unlimited" (the route layer, http/server.ts's parseEventsLimit,
      // already keeps a negative value from reaching here via HTTP, but
      // this store is not reachable only through that one route).
      const safeLimit = filter.limit < 0 ? 0 : filter.limit;
      limitClause = " LIMIT ?";
      params.push(safeLimit);
    }
    // Newest-first by occurred_at; ties (e.g. a burst of same-ms events,
    // aart_approve's own 3-event emission) broken DESC by `id` (D2b/V1 fix
    // pass, AMENDMENTS.md A63 FIX 4) — without a secondary key, SQLite's tie
    // order for equal occurred_at values is unspecified (no ORDER BY key
    // forces one), which is NOT a total order this store's own contract
    // promises and is not guaranteed to agree with the fs adapter's own tie
    // behavior.
    const rows = await this.exec((db) => dbAll<EventRow>(db, `SELECT * FROM events${where} ORDER BY occurred_at DESC, id DESC${limitClause}`, params));
    return rows.map(rowToEvent);
  }
}
