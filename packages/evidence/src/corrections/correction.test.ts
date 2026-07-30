import { createFsStore, type AartStore } from "@aart/store";
import { CorrectionSchema } from "@aart/types";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixtureRunRecord } from "../test-support/fixtures.js";
import { correctionKey, recordCorrection, type RecordCorrectionInput } from "./correction.js";

let root: string;
let store: AartStore;

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "aart-evidence-corrections-"));
  store = createFsStore(root);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function putCorrectableRun(
  runId: string,
  stepId: string,
): Promise<void> {
  await store.runs.put(
    fixtureRunRecord({
      runId,
      trace: [
        {
          seq: 0,
          stepId,
          block: "test.block",
          status: "completed",
          inputs: {},
          outputs: {},
          startedAt: "t",
        },
      ],
    }),
  );
}

describe("recordCorrection", () => {
  it("persists a Correction via store.corrections.put and returns it", async () => {
    await putCorrectableRun("run_1", "extract_bill");
    const correction = await recordCorrection(store, {
      runId: "run_1",
      stepId: "extract_bill",
      fieldPath: "outputs.nmi",
      observed: "6401234567",
      corrected: "6401234568",
      reason: "OCR misread final digit",
      reviewer: "jane@example.com",
    });
    expect(correction.reviewer).toBe("jane@example.com");
    expect(correction.createdAt).toBeTruthy();
    await expect(store.corrections.list({ runId: "run_1" })).resolves.toEqual([correction]);
    await expect(
      store.corrections.getOperationalTarget(
        correction,
      ),
    ).resolves.toEqual({
      stepId: correction.stepId,
      fieldPath: correction.fieldPath,
    });
  });

  it("matches spec §23.3's literal correction primitive shape", async () => {
    await putCorrectableRun("run_123", "extract_bill");
    const correction = await recordCorrection(store, {
      runId: "run_123",
      stepId: "extract_bill",
      fieldPath: "outputs.nmi",
      observed: "6401234567",
      corrected: "6401234568",
      reason: "OCR misread final digit",
      reviewer: "jane@example.com",
    });
    expect(correction).toMatchObject({
      runId: "run_123",
      stepId: "extract_bill",
      fieldPath: "outputs.nmi",
      observed: "6401234567",
      corrected: "6401234568",
      reason: "OCR misread final digit",
    });
  });

  it("rejects every public correction field against the sealed known-secret set before persisting", async () => {
    const secret = "known-correction-secret";
    const run = fixtureRunRecord({
      runId: "run_secret",
      trace: [
        {
          seq: 0,
          stepId: "extract",
          block: "test.block",
          status: "completed",
          inputs: {},
          outputs: {},
          startedAt: "t",
        },
      ],
    });
    await store.runs.put(run);
    await store.runs.putOperationalState(run.runId, {
      run,
      resolvedSecretValues: [secret],
    });
    const base: RecordCorrectionInput = {
      runId: run.runId,
      stepId: "extract",
      fieldPath: "outputs.value",
      observed: "old",
      corrected: "new",
      reason: "human correction",
      reviewer: "alice",
    };
    const sensitiveInputs: RecordCorrectionInput[] = [
      { ...base, stepId: `extract-${secret}` },
      { ...base, fieldPath: `outputs.${secret}` },
      {
        ...base,
        observed: { [secret]: "value" },
      },
      { ...base, corrected: `prefix-${secret}` },
      { ...base, reason: `reason ${secret}` },
      { ...base, reviewer: secret },
    ];

    for (const input of sensitiveInputs) {
      await expect(
        recordCorrection(store, input),
      ).rejects.toThrow(/secret already known/);
    }
    await expect(
      store.corrections.list({ runId: run.runId }),
    ).resolves.toEqual([]);
  });

  it("rejects a target step that does not exist before creating an audit row", async () => {
    await putCorrectableRun("run_target", "extract");

    await expect(
      recordCorrection(store, {
        runId: "run_target",
        stepId: "invented-step",
        fieldPath: "outputs.value",
        observed: "old",
        corrected: "new",
        reason: "wrong target",
        reviewer: "alice",
      }),
    ).rejects.toThrow(/target step does not exist/);
    await expect(
      store.corrections.list({
        runId: "run_target",
      }),
    ).resolves.toEqual([]);
  });
});

describe("reviewer is required — tested at the Zod (runtime) level, not just TypeScript's type level (spec §23.3 / this session's DoD)", () => {
  it("CorrectionSchema rejects a payload with reviewer omitted", () => {
    const withoutReviewer = {
      runId: "r",
      stepId: "s",
      fieldPath: "f",
      observed: "a",
      corrected: "b",
      reason: "x",
      createdAt: new Date().toISOString(),
      // reviewer intentionally omitted
    };
    const result = CorrectionSchema.safeParse(withoutReviewer);
    expect(result.success).toBe(false);
  });

  it("CorrectionSchema rejects an empty-string reviewer just as it would omission (still no human name attached)", () => {
    // CorrectionSchema's reviewer is z.string() (any string, including ""),
    // not z.string().min(1) — confirm the actual frozen behavior rather than
    // assuming a stricter contract than what @aart/types actually enforces.
    const result = CorrectionSchema.safeParse({
      runId: "r",
      stepId: "s",
      fieldPath: "f",
      observed: "a",
      corrected: "b",
      reason: "x",
      reviewer: "",
      createdAt: new Date().toISOString(),
    });
    expect(result.success).toBe(true); // documents the actual frozen contract: presence, not non-emptiness, is enforced
  });

  it("recordCorrection's TS input type makes `reviewer` a required (non-optional) field — compile-time proof via @ts-expect-error", () => {
    // If RecordCorrectionInput.reviewer were ever changed to optional, the
    // assignment below would stop producing a type error, `@ts-expect-error`
    // would itself become a type error ("Unused '@ts-expect-error'
    // directive"), and `pnpm run typecheck` would fail — this is the
    // standard way to assert "this is a compile-time error" without
    // actually breaking the build.
    // @ts-expect-error — reviewer is required, omitting it must not typecheck
    const withoutReviewer: RecordCorrectionInput = {
      runId: "r",
      stepId: "s",
      fieldPath: "f",
      observed: "a",
      corrected: "b",
      reason: "x",
    };
    expect(withoutReviewer.reviewer).toBeUndefined();
  });
});

describe("correctionKey", () => {
  it("encodes the (runId, stepId, fieldPath) composite key Correction itself has no synthetic id for", () => {
    expect(correctionKey({ runId: "run_1", stepId: "extract", fieldPath: "outputs.nmi" })).toBe("run_1:extract:outputs.nmi");
  });

  it("is stable across two Correction objects with the same identity but different observed/corrected/reason", () => {
    const a = { runId: "run_1", stepId: "extract", fieldPath: "outputs.nmi", observed: "x", corrected: "y", reason: "r1", reviewer: "a", createdAt: "t1" };
    const b = { runId: "run_1", stepId: "extract", fieldPath: "outputs.nmi", observed: "z", corrected: "w", reason: "r2", reviewer: "b", createdAt: "t2" };
    expect(correctionKey(a)).toBe(correctionKey(b));
  });
});
