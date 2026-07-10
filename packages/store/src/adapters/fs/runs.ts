// RunStore's fs implementation — architecture §5.2/§5.8: `runs/<runId>.json`
// co-locates the RunRecord with an adapter-internal (non-spec-visible,
// same status as job_queue) `_dedupeConsumed` sidecar array, so that a
// dedupe-check-and-run-state-update inside one `transact()` call becomes a
// single write-temp-then-rename of one file — both halves land or neither
// does.
import type { RunRecord, RunStatus } from "@aart/types";
import type { RunStore } from "../../types.js";
import { KeyedJsonCollection, type StagingBuffer } from "./json-file.js";

interface StoredRun {
  record: RunRecord;
  _dedupeConsumed: string[];
}

export class FsRunStore implements RunStore {
  private readonly collection: KeyedJsonCollection<StoredRun>;

  constructor(dir: string, staging?: StagingBuffer) {
    this.collection = new KeyedJsonCollection<StoredRun>(dir, staging);
  }

  async get(runId: string): Promise<RunRecord | undefined> {
    const stored = await this.collection.get(runId);
    return stored?.record;
  }

  async put(run: RunRecord): Promise<void> {
    const existing = await this.collection.get(run.runId);
    await this.collection.put(run.runId, { record: run, _dedupeConsumed: existing?._dedupeConsumed ?? [] });
  }

  async list(filter?: { status?: RunStatus; workflowId?: string }): Promise<RunRecord[]> {
    const stored = await this.collection.list();
    return stored
      .map((s) => s.record)
      .filter((r) => (filter?.status ? r.status === filter.status : true))
      .filter((r) => (filter?.workflowId ? r.workflowId === filter.workflowId : true));
  }

  async hasDedupeKey(runId: string, dedupeKey: string): Promise<boolean> {
    const stored = await this.collection.get(runId);
    return stored?._dedupeConsumed.includes(dedupeKey) ?? false;
  }

  async recordDedupeKey(runId: string, dedupeKey: string): Promise<void> {
    const existing = await this.collection.get(runId);
    if (!existing) {
      throw new Error(`recordDedupeKey: no run ${runId} exists to attach a dedupe key to — put() the RunRecord first.`);
    }
    if (existing._dedupeConsumed.includes(dedupeKey)) return;
    await this.collection.put(runId, { ...existing, _dedupeConsumed: [...existing._dedupeConsumed, dedupeKey] });
  }
}
