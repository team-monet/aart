import type { AartStore } from "@aart/store";
import { afterEach, describe, expect, it } from "vitest";
import { checkIdempotency, recordIdempotency } from "./idempotency.js";
import { createTestStore, uniqueId } from "./test-utils/fixtures.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

async function setup(): Promise<AartStore> {
  const { store, cleanup } = await createTestStore();
  cleanups.push(cleanup);
  return store;
}

describe("checkIdempotency / recordIdempotency (spec §30.2, architecture §4.2/§5.7)", () => {
  it("checkIdempotency reports not-completed for a never-seen key", async () => {
    const store = await setup();
    expect(await checkIdempotency(store, "never-seen")).toEqual({ alreadyCompleted: false });
  });

  it("recordIdempotency then checkIdempotency reports completed with the recorded output", async () => {
    const store = await setup();
    const runId = uniqueId("run");
    const key = `${runId}:send_email`;
    await recordIdempotency(store, key, runId, "send_email", { sent: true, messageId: "m1" }, new Date());
    const check = await checkIdempotency(store, key);
    expect(check).toEqual({ alreadyCompleted: true, recordedOutput: { sent: true, messageId: "m1" } });
  });

  it("a second attempt with the same resolved key can be checked WITHOUT needing that attempt's own StepTrace to exist yet (architecture §5.7's placement rationale)", async () => {
    // This is exactly the property the dedicated idempotency_ledger
    // collection exists for: check-before-execute, independent of trace
    // history.
    const store = await setup();
    const key = "run1:send_email";
    await recordIdempotency(store, key, "run1", "send_email", { sent: true }, new Date());
    // No StepTrace was ever written for this "second attempt" — checking
    // idempotency doesn't require one.
    expect(await checkIdempotency(store, key)).toMatchObject({ alreadyCompleted: true });
  });
});
