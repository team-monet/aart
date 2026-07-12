// EventLogStore's fs implementation (V1 event log foundation, AMENDMENTS.md
// A61) — mirrors signals.ts's append-only, scan-oriented pattern: each
// entry is its own file (not a KeyedJsonCollection — this store's `list`
// contract needs newest-first ordering plus `since`/`limit` filtering,
// which a plain "every file in this directory, insertion order" collection
// doesn't give for free), and filenames are self-describing
// (`<occurredAt>__<id>.json`) the same way signals.ts's are
// (`<correlationId>__<receivedAt>.json`) — the two fields that matter most
// for a human skimming the directory.
//
// Deliberately NOT staged by transact() — see the doc comment on
// AartStore.transact in ../../types.ts (the `tx.events` paragraph) for why
// this mirrors SignalStore's own non-atomic-gap precedent rather than the
// staged default every other "simple" fs store (simple-stores.ts) uses.
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { EventLogEntry } from "@aart/types";
import type { EventLogStore } from "../../types.js";
import { JsonFileHandle } from "./json-file.js";

function sanitizeForFilename(value: string): string {
  return value.replace(/[/\\:*?"<>|]/g, "_");
}

export class FsEventLogStore implements EventLogStore {
  constructor(private readonly dir: string) {}

  private pathFor(entry: Pick<EventLogEntry, "id" | "occurredAt">): string {
    return join(this.dir, `${sanitizeForFilename(entry.occurredAt)}__${sanitizeForFilename(entry.id)}.json`);
  }

  async append(entry: EventLogEntry): Promise<void> {
    await new JsonFileHandle<EventLogEntry>(this.pathFor(entry)).write(entry);
  }

  private async listStored(): Promise<EventLogEntry[]> {
    let files: string[];
    try {
      files = (await fs.readdir(this.dir)).filter((f) => f.endsWith(".json") && !f.startsWith(".tmp-"));
    } catch (err) {
      if (typeof err === "object" && err !== null && "code" in err && (err as { code?: string }).code === "ENOENT") return [];
      throw err;
    }
    const values = await Promise.all(files.map((f) => new JsonFileHandle<EventLogEntry>(join(this.dir, f)).read()));
    return values.filter((v): v is EventLogEntry => v !== undefined);
  }

  async list(filter?: { since?: string; limit?: number }): Promise<EventLogEntry[]> {
    const all = await this.listStored();
    const filtered = all
      .filter((e) => (filter?.since ? e.occurredAt >= filter.since : true))
      // Newest-first by occurredAt; ties (e.g. a burst of same-ms events,
      // aart_approve's own 3-event emission) broken DESC by `id` (D2b/V1 fix
      // pass, AMENDMENTS.md A63 FIX 4) — without this, ties fell back to
      // Array.prototype.sort's stability, i.e. whatever order `readdir()`
      // (listStored, above) happened to return them in, which is NOT a
      // total order this store's own contract promises and is not
      // guaranteed to agree with the sqlite adapter's own tie behavior.
      .sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : a.occurredAt > b.occurredAt ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    if (filter?.limit === undefined) return filtered;
    // D2b/V1 fix pass (AMENDMENTS.md A63, FIX 3) — a negative limit must
    // never reach `slice()` directly: `slice(0, -N)` means "drop the last N
    // items," not "give me none" or "give me everything," which silently
    // returned MORE of the log than a caller passing a negative number could
    // have intended. The route layer (http/server.ts's parseEventsLimit)
    // already prevents a negative value from reaching here via HTTP, but
    // this store is not reachable only through that one route — treated as
    // "zero" here, the same safe-direction choice this store's sqlite
    // sibling adapter (adapters/sqlite/stores/events.ts) makes, never
    // "unlimited."
    if (filter.limit < 0) return [];
    return filtered.slice(0, filter.limit);
  }
}
