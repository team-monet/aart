// findCorrectionByKey — the server-side lookup backing the dashboard's
// correction-outcome routes (`/corrections/:key/update-run-output` etc.,
// AMENDMENTS.md A47: moved here from a dashboard-local implementation of
// the identical logic).
import { describe, expect, it } from "vitest";
import type { Correction } from "@aart/types";
import { findCorrectionByKey } from "./corrections.js";
import { createTestFixture, type TestFixture } from "./test-helpers.js";

function fixtureCorrection(overrides: Partial<Correction> = {}): Correction {
  return {
    runId: "run-1",
    stepId: "step1",
    fieldPath: "outputs.total",
    observed: 1,
    corrected: 2,
    reason: "off by one",
    reviewer: "alice",
    createdAt: "2026-07-10T00:00:00.000Z",
    ...overrides,
  };
}

async function withFixture(fn: (fx: TestFixture) => Promise<void>): Promise<void> {
  const fx = await createTestFixture();
  try {
    await fn(fx);
  } finally {
    await fx.cleanup();
  }
}

describe("findCorrectionByKey", () => {
  it("round-trips: a correction's `${runId}:${stepId}:${fieldPath}` key looks the same correction back up", async () => {
    await withFixture(async (fx) => {
      const correction = fixtureCorrection();
      await fx.store.corrections.put(correction);
      expect(await findCorrectionByKey(fx.store, "run-1:step1:outputs.total")).toEqual(correction);
    });
  });

  it("round-trips correctly even though createdAt (not part of the key) contains colons", async () => {
    await withFixture(async (fx) => {
      const correction = fixtureCorrection({ createdAt: "2026-07-10T12:34:56.789Z" });
      await fx.store.corrections.put(correction);
      expect(await findCorrectionByKey(fx.store, "run-1:step1:outputs.total")).toEqual(correction);
    });
  });

  it("a fieldPath that itself contains a colon still round-trips (splits on the first two colons only)", async () => {
    await withFixture(async (fx) => {
      const correction = fixtureCorrection({ fieldPath: "outputs.time:formatted" });
      await fx.store.corrections.put(correction);
      expect(await findCorrectionByKey(fx.store, "run-1:step1:outputs.time:formatted")).toEqual(correction);
    });
  });

  it("keeps a previously issued exact key resolvable after the public field path is redacted", async () => {
    await withFixture(async (fx) => {
      const correction = fixtureCorrection();
      await fx.store.corrections.put(correction, {
        stepId: correction.stepId,
        fieldPath: correction.fieldPath,
      });
      await fx.store.corrections.replaceAudit(correction, {
        fieldPath: "[REDACTED]",
        observed: correction.observed,
        corrected: correction.corrected,
        reason: correction.reason,
        reviewer: correction.reviewer,
      });
      const [publicCorrection] =
        await fx.store.corrections.list({
          runId: correction.runId,
        });

      await expect(
        findCorrectionByKey(
          fx.store,
          "run-1:step1:outputs.total",
        ),
      ).resolves.toEqual(publicCorrection);
    });
  });

  it("returns undefined for a key that doesn't match any stored correction", async () => {
    await withFixture(async (fx) => {
      expect(await findCorrectionByKey(fx.store, "run-missing:step1:outputs.total")).toBeUndefined();
    });
  });

  it("returns undefined for a malformed key (missing a segment)", async () => {
    await withFixture(async (fx) => {
      expect(await findCorrectionByKey(fx.store, "run-1:step1")).toBeUndefined();
    });
  });
});
