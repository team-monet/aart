// SignalStore's fs implementation. Kept separate from the generic
// KeyedJsonCollection: filenames are `<correlationId>__<receivedAt>.json`
// (architecture §5.2, append-only for audit), lookup is by (name,
// correlationId) rather than by the file's own key, and a signal carries an
// adapter-internal `consumed` flag not present on the frozen `Signal` type
// itself (same pattern as run.ts's `_dedupeConsumed` sidecar — architecture
// §5.2's own parenthetical on this file: "marked consumed:true").
//
// Deliberately NOT staged by transact() — see the doc comment on
// SignalStore.append/markConsumed in ../../types.ts and architecture §5.8's
// documented non-atomic gap.
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

  async append(signal: Signal): Promise<void> {
    const stored: StoredSignal = { ...signal, consumed: false };
    await new JsonFileHandle<StoredSignal>(this.pathFor(signal)).write(stored);
  }

  private async listStored(): Promise<StoredSignal[]> {
    let files: string[];
    try {
      files = (await fs.readdir(this.dir)).filter((f) => f.endsWith(".json") && !f.startsWith(".tmp-"));
    } catch (err) {
      if (typeof err === "object" && err !== null && "code" in err && (err as { code?: string }).code === "ENOENT") return [];
      throw err;
    }
    const values = await Promise.all(files.map((f) => new JsonFileHandle<StoredSignal>(join(this.dir, f)).read()));
    return values.filter((v): v is StoredSignal => v !== undefined);
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
    const all = await this.listStored();
    const match = all.find((s) => s.id === signalId);
    if (!match) return;
    const updated: StoredSignal = {
      ...match,
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
    await new JsonFileHandle<StoredSignal>(this.pathFor(match)).write(updated);
  }

  async listConsumedByRun(runId: string): Promise<Signal[]> {
    return (await this.listStored())
      .filter(
        (signal) =>
          signal.consumed && signal.consumedByRunId === runId,
      )
      .map((signal) => this.publicSignal(signal));
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
