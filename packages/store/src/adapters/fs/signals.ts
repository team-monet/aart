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
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { Signal } from "@aart/types";
import type { SignalStore } from "../../types.js";
import {
  openOperationalState,
  sealOperationalState,
} from "../operational-state-seal.js";
import { JsonFileHandle } from "./json-file.js";

interface StoredSignal extends Signal {
  consumed: boolean;
  consumedByRunId?: string;
  consumedByStepId?: string;
  /** Recovery identity for a late-redacted, correlation-safe filename. */
  auditFileNonce?: string;
  /** One-way exact-match association retained after audit redaction. */
  signalMatchFingerprint?: string;
  /** AES-GCM-sealed unconsumed signal used only for early-arrival matching. */
  operationalSignal?: string;
  /** Authenticated generation preventing ciphertext replay across rewrites. */
  operationalGeneration?: string;
}

interface OperationalSignalState {
  signal: Signal;
  resolvedSecretValues: string[];
}

function sanitizeForFilename(value: string): string {
  return value.replace(/[/\\:*?"<>|]/g, "_");
}

export class FsSignalStore implements SignalStore {
  private readonly operationKeyPath: string;

  constructor(private readonly dir: string) {
    this.operationKeyPath = join(dir, ".operational-key");
  }

  private fingerprint(name: string, correlationId: string): string {
    return createHash("sha256")
      .update(JSON.stringify([name, correlationId]))
      .digest("hex");
  }

  private pathFor(signal: Pick<Signal, "correlationId" | "receivedAt">): string {
    return join(this.dir, `${sanitizeForFilename(signal.correlationId)}__${sanitizeForFilename(signal.receivedAt)}.json`);
  }

  private replacementPathFor(
    signal: Pick<Signal, "correlationId" | "receivedAt"> & {
      auditFileNonce: string;
    },
  ): string {
    return join(
      this.dir,
      `${sanitizeForFilename(signal.correlationId)}__${sanitizeForFilename(signal.receivedAt)}__${signal.auditFileNonce}.json`,
    );
  }

  async append(signal: Signal): Promise<void> {
    await this.normalizeLateRedactedFilenames();
    const operationalGeneration = randomUUID();
    const stored: StoredSignal = {
      ...signal,
      consumed: false,
      signalMatchFingerprint: this.fingerprint(
        signal.name,
        signal.correlationId,
      ),
      operationalSignal: await sealOperationalState(
        this.operationKeyPath,
        [signal.id, operationalGeneration, "signal"],
        { signal, resolvedSecretValues: [] },
      ),
      operationalGeneration,
    };
    await new JsonFileHandle<StoredSignal>(this.pathFor(signal)).write(stored);
  }

  private async readStoredRows(): Promise<
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

  /**
   * Completes a filename move interrupted after the safe JSON rewrite.
   * Every public operation runs this gate before exposing or mutating the
   * signal store, so a restarted process repairs a secret-bearing legacy
   * path before the store becomes observable.
   */
  private async normalizeLateRedactedFilenames(): Promise<void> {
    const rows = await this.readStoredRows();
    for (const row of rows) {
      if (row.signal.auditFileNonce === undefined) continue;
      const replacementPath = this.replacementPathFor({
        ...row.signal,
        auditFileNonce: row.signal.auditFileNonce,
      });
      if (replacementPath === row.path) continue;
      try {
        await fs.rename(row.path, replacementPath);
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          await fs.access(replacementPath);
          continue;
        }
        throw error;
      }
    }
  }

  private async listStoredRows(): Promise<
    Array<{ signal: StoredSignal; path: string }>
  > {
    await this.normalizeLateRedactedFilenames();
    return this.readStoredRows();
  }

  private async listStored(): Promise<StoredSignal[]> {
    return (await this.listStoredRows()).map((entry) => entry.signal);
  }

  async findUnconsumedMatch(name: string, correlationId: string): Promise<Signal | undefined> {
    const expected = this.fingerprint(name, correlationId);
    const all = await this.listStored();
    const match = all.find(
      (signal) =>
        !signal.consumed &&
        (signal.signalMatchFingerprint ??
          this.fingerprint(signal.name, signal.correlationId)) ===
          expected,
    );
    if (!match) return undefined;
    return this.operationalSignal(match);
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
      operationalSignal: undefined,
      operationalGeneration: undefined,
      signalMatchFingerprint: undefined,
    };
    await new JsonFileHandle<StoredSignal>(match.path).write(updated);
  }

  async getOperationalSecretValues(
    signalId: string,
  ): Promise<string[]> {
    const signal = (await this.listStored()).find(
      (candidate) => candidate.id === signalId,
    );
    if (!signal || signal.consumed) return [];
    return (await this.operationalSignalState(signal))
      .resolvedSecretValues;
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

  async replaceAudit(
    signalId: string,
    audit: Pick<Signal, "name" | "correlationId" | "payload">,
    resolvedSecretValues: readonly string[] = [],
  ): Promise<void> {
    const rows = await this.listStoredRows();
    const match = rows.find((entry) => entry.signal.id === signalId);
    if (!match) return;
    const auditFileNonce =
      match.signal.auditFileNonce ?? randomUUID();
    const operationalGeneration =
      match.signal.consumed
        ? undefined
        : randomUUID();
    const priorOperationalState =
      match.signal.consumed
        ? undefined
        : await this.operationalSignalState(match.signal);
    const operationalSignal =
      match.signal.consumed
        ? undefined
        : await sealOperationalState(
            this.operationKeyPath,
            [match.signal.id, operationalGeneration!, "signal"],
            {
              signal:
                priorOperationalState?.signal ??
                this.publicSignal(match.signal),
              resolvedSecretValues: [
                ...new Set([
                  ...(priorOperationalState?.resolvedSecretValues ??
                    []),
                  ...resolvedSecretValues,
                ]),
              ],
            } satisfies OperationalSignalState,
          );
    const updated: StoredSignal = {
      ...match.signal,
      ...audit,
      auditFileNonce,
      ...(match.signal.consumed
        ? {}
        : {
            signalMatchFingerprint:
              match.signal.signalMatchFingerprint ??
              this.fingerprint(
                match.signal.name,
                match.signal.correlationId,
              ),
            operationalSignal,
            operationalGeneration,
          }),
    };
    const replacementPath = this.replacementPathFor({
      ...updated,
      auditFileNonce,
    });
    // Persist the recovery nonce together with safe content first. If the
    // process exits before rename, the next store operation completes the
    // move before exposing any signal row.
    await new JsonFileHandle<StoredSignal>(match.path).write(updated);
    if (replacementPath !== match.path) {
      try {
        await fs.rename(match.path, replacementPath);
      } catch (error) {
        if (
          typeof error !== "object" ||
          error === null ||
          !("code" in error) ||
          error.code !== "ENOENT"
        ) {
          throw error;
        }
        await fs.access(replacementPath);
      }
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
      auditFileNonce: _auditFileNonce,
      signalMatchFingerprint: _signalMatchFingerprint,
      operationalSignal: _operationalSignal,
      operationalGeneration: _operationalGeneration,
      ...publicSignal
    } = signal;
    return publicSignal;
  }

  private async operationalSignal(
    signal: StoredSignal,
  ): Promise<Signal> {
    return (await this.operationalSignalState(signal)).signal;
  }

  private async operationalSignalState(
    signal: StoredSignal,
  ): Promise<OperationalSignalState> {
    if (
      signal.operationalSignal === undefined ||
      signal.operationalGeneration === undefined
    ) {
      return {
        signal: this.publicSignal(signal),
        resolvedSecretValues: [],
      };
    }
    const opened = await openOperationalState<
      OperationalSignalState | Signal
    >(
      this.operationKeyPath,
      [signal.id, signal.operationalGeneration, "signal"],
      signal.operationalSignal,
    );
    return "signal" in opened
      ? opened
      : { signal: opened, resolvedSecretValues: [] };
  }
}
