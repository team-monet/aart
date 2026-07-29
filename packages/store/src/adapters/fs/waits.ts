// WaitStore's fs implementation — keyed by (runId, stepId), architecture
// §5.2/§5.6: "a run can have at most one outstanding wait per step... but a
// run *can* have had multiple waits over its lifetime... so the composite
// key is necessary." File name: `<runId>__<stepId>.json`.
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { WaitCondition } from "@aart/types";
import type { WaitStore } from "../../types.js";
import {
  openWaitOperation,
  sealWaitOperation,
} from "../wait-operation-seal.js";
import { KeyedJsonCollection, type StagingBuffer } from "./json-file.js";

interface StoredWait {
  runId: string;
  stepId: string;
  /** Redacted, user-visible audit copy. */
  wait: WaitCondition;
  /** One-way exact-match key; never exposes the original correlation. */
  signalMatchFingerprint?: string;
  /** AES-GCM sealed operational copy; never returned by audit listing. */
  operationalWait?: string;
  /** Unique authenticated generation for repeated entries of one step. */
  operationalGeneration?: string;
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
  private readonly operationKeyPath: string;

  constructor(dir: string, staging?: StagingBuffer) {
    this.collection = new KeyedJsonCollection<StoredWait>(dir, staging);
    this.operationKeyPath = join(dir, ".operational-key");
  }

  async get(runId: string, stepId: string): Promise<WaitCondition | undefined> {
    const stored = await this.collection.get(waitKey(runId, stepId));
    return stored ? this.operationalWait(stored) : undefined;
  }

  async put(runId: string, stepId: string, wait: WaitCondition, createdAt: string): Promise<void> {
    const operationalGeneration = randomUUID();
    await this.collection.put(waitKey(runId, stepId), {
      runId,
      stepId,
      wait,
      signalMatchFingerprint: fingerprintForWait(wait),
      operationalWait: await sealWaitOperation(
        this.operationKeyPath,
        runId,
        stepId,
        operationalGeneration,
        wait,
      ),
      operationalGeneration,
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
    const operationalWait = await this.operationalWait(stored);
    const operationalGeneration =
      stored.operationalGeneration ?? randomUUID();
    await this.collection.put(key, {
      ...stored,
      wait,
      operationalWait:
        stored.operationalWait ??
        (await sealWaitOperation(
          this.operationKeyPath,
          runId,
          stepId,
          operationalGeneration,
          operationalWait,
        )),
      operationalGeneration,
      signalMatchFingerprint:
        stored.signalMatchFingerprint ?? fingerprintForWait(stored.wait),
    });
  }

  async delete(runId: string, stepId: string): Promise<void> {
    await this.collection.delete(waitKey(runId, stepId));
  }

  async list(filter?: { runId?: string }): Promise<Array<{ runId: string; stepId: string; wait: WaitCondition; createdAt: string }>> {
    return (await this.collection.list())
      .filter((entry) =>
        filter?.runId === undefined
          ? true
          : entry.runId === filter.runId,
      )
      .map(
      ({ runId, stepId, wait, createdAt }) => ({
        runId,
        stepId,
        wait,
        createdAt,
      }),
    );
  }

  async listOperational(filter?: {
    runId?: string;
    type?: WaitCondition["type"];
  }): Promise<Array<{ runId: string; stepId: string; wait: WaitCondition; createdAt: string }>> {
    const stored = (await this.collection.list()).filter((entry) =>
      filter?.runId === undefined
        ? true
        : entry.runId === filter.runId,
    );
    const rows = await Promise.all(
      stored.map(async (entry) => ({
        runId: entry.runId,
        stepId: entry.stepId,
        wait: await this.operationalWait(entry),
        createdAt: entry.createdAt,
      })),
    );
    return rows.filter((entry) =>
      filter?.type === undefined
        ? true
        : entry.wait.type === filter.type,
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
    // Only `timer` waits are determinable as "due" purely from
    // WaitCondition's own frozen shape (resumeAt <= now). Poll-mode
    // external_job waits (architecture §4.4.1) additionally require the
    // originating trigger/poll config to know their condition/interval —
    // that cross-reference is Wave-1 scope (S2's scheduler ticker), not
    // buildable from the store layer alone.
    const stored = (await this.collection.list()).filter(
      (entry) => entry.wait.type === "timer",
    );
    const due: Array<{
      runId: string;
      stepId: string;
      wait: WaitCondition;
    }> = [];
    for (const entry of stored) {
      const operational = await this.operationalWait(entry);
      if (
        operational.type === "timer" &&
        operational.resumeAt <= now
      ) {
        due.push({
          runId: entry.runId,
          stepId: entry.stepId,
          wait: entry.wait,
        });
      }
    }
    return due;
  }

  private async operationalWait(stored: StoredWait): Promise<WaitCondition> {
    if (stored.operationalWait === undefined) return stored.wait;
    const wait = await openWaitOperation(
      this.operationKeyPath,
      stored.runId,
      stored.stepId,
      stored.operationalGeneration,
      stored.operationalWait,
    );
    if (stored.operationalGeneration === undefined) {
      const operationalGeneration = randomUUID();
      const operationalWait = await sealWaitOperation(
        this.operationKeyPath,
        stored.runId,
        stored.stepId,
        operationalGeneration,
        wait,
      );
      stored.operationalGeneration = operationalGeneration;
      stored.operationalWait = operationalWait;
      await this.collection.put(
        waitKey(stored.runId, stored.stepId),
        stored,
      );
    }
    return wait;
  }
}
