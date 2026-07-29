// SignalStore's fs implementation. Kept separate from the generic
// KeyedJsonCollection: initial filenames are
// `<correlationId>__<receivedAt>.json`
// (architecture §5.2, append-only for audit), lookup is by (name,
// correlationId) rather than by the file's own key, and a signal carries an
// adapter-internal `consumed` flag not present on the frozen `Signal` type
// itself (same pattern as run.ts's `_dedupeConsumed` sidecar — architecture
// §5.2's own parenthetical on this file: "marked consumed:true"). A later
// audit rewrite writes safe content first, then renames to a collision-safe
// `<redactedCorrelation>__<receivedAt>__<opaqueNonce>.json` path.
//
// Deliberately NOT staged by transact() — see the doc comment on
// SignalStore.append/markConsumed in ../../types.ts and architecture §5.8's
// documented non-atomic gap.
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { Signal } from "@aart/types";
import type { SignalStore } from "../../types.js";
import { JsonFileHandle } from "./json-file.js";

interface StoredSignal extends Signal {
  consumed: boolean;
  consumedByRunId?: string;
  consumedByStepId?: string;
}

function sanitizeForFilename(value: string): string {
  return value.replace(/[/\\:*?"<>|]/g, "_");
}

export class FsSignalStore implements SignalStore {
  constructor(private readonly dir: string) {}

  private pathFor(signal: Pick<Signal, "correlationId" | "receivedAt">): string {
    return join(this.dir, `${sanitizeForFilename(signal.correlationId)}__${sanitizeForFilename(signal.receivedAt)}.json`);
  }

  private replacementPathFor(
    signal: Pick<Signal, "correlationId" | "receivedAt">,
  ): string {
    return join(
      this.dir,
      `${sanitizeForFilename(signal.correlationId)}__${sanitizeForFilename(signal.receivedAt)}__${randomUUID()}.json`,
    );
  }

  async append(signal: Signal): Promise<void> {
    const stored: StoredSignal = { ...signal, consumed: false };
    await new JsonFileHandle<StoredSignal>(this.pathFor(signal)).write(stored);
  }

  private async listStoredRows(): Promise<
    Array<{ signal: StoredSignal; path: string }>
  > {
    let files: string[];
    try {
      files = (await fs.readdir(this.dir)).filter((f) => f.endsWith(".json") && !f.startsWith(".tmp-"));
    } catch (err) {
      if (typeof err === "object" && err !== null && "code" in err && (err as { code?: string }).code === "ENOENT") return [];
      throw err;
    }
    const values = await Promise.all(
      files.map(async (file) => ({
        signal: await new JsonFileHandle<StoredSignal>(
          join(this.dir, file),
        ).read(),
        path: join(this.dir, file),
      })),
    );
    return values.flatMap((entry) =>
      entry.signal === undefined
        ? []
        : [{ signal: entry.signal, path: entry.path }],
    );
  }

  private async listStored(): Promise<StoredSignal[]> {
    return (await this.listStoredRows()).map((entry) => entry.signal);
  }

  async findUnconsumedMatch(name: string, correlationId: string): Promise<Signal | undefined> {
    const all = await this.listStored();
    const match = all.find((s) => !s.consumed && s.name === name && s.correlationId === correlationId);
    if (!match) return undefined;
    return this.publicSignal(match);
  }

  async markConsumed(
    signalId: string,
    options?: {
      payload?: unknown;
      consumedBy?: { runId: string; stepId: string };
    },
  ): Promise<void> {
    const rows = await this.listStoredRows();
    const match = rows.find((entry) => entry.signal.id === signalId);
    if (!match) return;
    const updated: StoredSignal = {
      ...match.signal,
      ...(options !== undefined && "payload" in options
        ? { payload: options.payload }
        : {}),
      ...(options?.consumedBy !== undefined
        ? {
            consumedByRunId: options.consumedBy.runId,
            consumedByStepId: options.consumedBy.stepId,
          }
        : {}),
      consumed: true,
    };
    await new JsonFileHandle<StoredSignal>(match.path).write(updated);
  }

  async listConsumedByRun(runId: string): Promise<Signal[]> {
    return (await this.listStored())
      .filter(
        (signal) =>
          signal.consumed && signal.consumedByRunId === runId,
      )
      .map((signal) => this.publicSignal(signal));
  }

  async listConsumedWithoutProvenance(): Promise<Signal[]> {
    return (await this.listStored())
      .filter(
        (signal) =>
          signal.consumed &&
          signal.consumedByRunId === undefined,
      )
      .map((signal) => this.publicSignal(signal));
  }

  async replaceConsumedAudit(
    signalId: string,
    audit: Pick<Signal, "name" | "correlationId" | "payload">,
  ): Promise<void> {
    const rows = await this.listStoredRows();
    const match = rows.find(
      (entry) =>
        entry.signal.id === signalId && entry.signal.consumed,
    );
    if (!match) return;
    const updated: StoredSignal = {
      ...match.signal,
      ...audit,
    };
    const replacementPath = this.replacementPathFor(updated);
    // First atomically replace the old file's CONTENT, then rename that
    // already-safe file. A crash between the two operations can at worst
    // leave a redacted record under the old name; it cannot leave the raw
    // payload durable while a new redacted sibling appears beside it.
    await new JsonFileHandle<StoredSignal>(match.path).write(updated);
    if (replacementPath !== match.path) {
      await fs.rename(match.path, replacementPath);
    }
  }

  async list(): Promise<Signal[]> {
    const all = await this.listStored();
    return all.map((signal) => this.publicSignal(signal));
  }

  private publicSignal(signal: StoredSignal): Signal {
    const {
      consumed: _consumed,
      consumedByRunId: _consumedByRunId,
      consumedByStepId: _consumedByStepId,
      ...publicSignal
    } = signal;
    return publicSignal;
  }
}
