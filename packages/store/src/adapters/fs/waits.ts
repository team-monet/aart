// WaitStore's fs implementation — keyed by (runId, stepId), architecture
// §5.2/§5.6: "a run can have at most one outstanding wait per step... but a
// run *can* have had multiple waits over its lifetime... so the composite
// key is necessary." File name: `<runId>__<stepId>.json`.
import { createHash } from "node:crypto";
import type { WaitCondition } from "@aart/types";
import type { WaitStore } from "../../types.js";
import { KeyedJsonCollection, type StagingBuffer } from "./json-file.js";

interface StoredWait {
  runId: string;
  stepId: string;
  /** Redacted, user-visible audit copy. */
  wait: WaitCondition;
  /** One-way exact-match key; never exposes the original correlation. */
  signalMatchFingerprint?: string;
  createdAt: string;
}

function waitKey(runId: string, stepId: string): string {
  return `${runId}__${stepId}`;
}

function signalCorrelation(
  wait: WaitCondition,
): { name: string; correlationId: string } | undefined {
  switch (wait.type) {
    case "signal":
      return { name: wait.name, correlationId: wait.correlationId };
    case "webhook":
      return { name: wait.event, correlationId: wait.correlationId };
    case "queue":
      return { name: wait.queue, correlationId: wait.correlationId };
    case "external_job":
      return { name: wait.provider, correlationId: wait.jobId };
    case "approval":
    case "timer":
    case "manual":
      return undefined;
  }
}

function signalMatchFingerprint(
  name: string,
  correlationId: string,
): string {
  return createHash("sha256")
    .update(JSON.stringify([name, correlationId]))
    .digest("hex");
}

function fingerprintForWait(wait: WaitCondition): string | undefined {
  const correlation = signalCorrelation(wait);
  return correlation
    ? signalMatchFingerprint(correlation.name, correlation.correlationId)
    : undefined;
}

export class FsWaitStore implements WaitStore {
  private readonly collection: KeyedJsonCollection<StoredWait>;

  constructor(dir: string, staging?: StagingBuffer) {
    this.collection = new KeyedJsonCollection<StoredWait>(dir, staging);
  }

  async get(runId: string, stepId: string): Promise<WaitCondition | undefined> {
    const stored = await this.collection.get(waitKey(runId, stepId));
    return stored?.wait;
  }

  async put(runId: string, stepId: string, wait: WaitCondition, createdAt: string): Promise<void> {
    await this.collection.put(waitKey(runId, stepId), {
      runId,
      stepId,
      wait,
      signalMatchFingerprint: fingerprintForWait(wait),
      createdAt,
    });
  }

  async redactAudit(
    runId: string,
    stepId: string,
    wait: WaitCondition,
  ): Promise<void> {
    const key = waitKey(runId, stepId);
    const stored = await this.collection.get(key);
    if (!stored) return;
    await this.collection.put(key, {
      ...stored,
      wait,
      signalMatchFingerprint:
        stored.signalMatchFingerprint ?? fingerprintForWait(stored.wait),
    });
  }

  async delete(runId: string, stepId: string): Promise<void> {
    await this.collection.delete(waitKey(runId, stepId));
  }

  async list(): Promise<Array<{ runId: string; stepId: string; wait: WaitCondition; createdAt: string }>> {
    return (await this.collection.list()).map(
      ({ runId, stepId, wait, createdAt }) => ({
        runId,
        stepId,
        wait,
        createdAt,
      }),
    );
  }

  async findSignalMatches(
    name: string,
    correlationId: string,
  ): Promise<Array<{ runId: string; stepId: string }>> {
    const expected = signalMatchFingerprint(name, correlationId);
    return (await this.collection.list())
      .filter(
        (stored) =>
          (stored.signalMatchFingerprint ??
            fingerprintForWait(stored.wait)) === expected,
      )
      .map(({ runId, stepId }) => ({ runId, stepId }));
  }

  async listDue(now: string): Promise<Array<{ runId: string; stepId: string; wait: WaitCondition }>> {
    const all = await this.collection.list();
    // Only `timer` waits are determinable as "due" purely from
    // WaitCondition's own frozen shape (resumeAt <= now). Poll-mode
    // external_job waits (architecture §4.4.1) additionally require the
    // originating trigger/poll config to know their condition/interval —
    // that cross-reference is Wave-1 scope (S2's scheduler ticker), not
    // buildable from the store layer alone.
    return all
      .filter((entry) => entry.wait.type === "timer" && entry.wait.resumeAt <= now)
      .map(({ runId, stepId, wait }) => ({ runId, stepId, wait }));
  }
}
