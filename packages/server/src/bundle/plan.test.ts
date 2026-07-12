// findCurrentVersion — D1 fix pass (AMENDMENTS.md A57). Dedicated,
// backend-independent coverage for the id tie-break: findCurrentVersion's
// own doc comment explains why an fs-store-backed end-to-end test (e.g.
// through POST /bundles/plan, http/server.test.ts) can't actually
// distinguish pre-fix from post-fix behavior — createFsStore's own
// KeyedJsonCollection.list() already returns rows sorted alphabetically by
// id, which coincidentally matches this fix's own tie-break output
// regardless of whether the fix exists. This file constructs a minimal
// store double whose deployments.list() returns a DELIBERATELY
// adversarial order (the correct-per-this-fix winner listed FIRST, not
// last) so the only way these assertions pass is if findCurrentVersion
// genuinely re-sorts by id itself, never trusting the store's own order.
import { describe, expect, it } from "vitest";
import type { AartStore } from "@aart/store";
import type { Deployment } from "@aart/types";
import { findCurrentVersion } from "./plan.js";

/** Only `deployments.list` is exercised by findCurrentVersion (verified by reading its own body) — every other AartStore member is deliberately absent, not stubbed, so a test that accidentally exercises one fails loudly (a TypeError) rather than silently passing against an unintended no-op. */
function fakeStoreReturning(deployments: Deployment[]): AartStore {
  return {
    deployments: {
      list: async () => deployments,
    },
  } as unknown as AartStore;
}

function deployment(id: string, workflowVersion: string, createdAt: string, promoted: boolean | undefined = true): Deployment {
  return { id, workflowId: "wf_tie", workflowVersion, environmentId: "env_tie", triggerConfig: {}, createdAt, promoted };
}

describe("findCurrentVersion — id tie-break on createdAt collisions (AMENDMENTS.md A57 fix pass)", () => {
  it("picks the lexicographically-largest id when createdAt ties, regardless of the store's own returned order", async () => {
    const sameCreatedAt = "2026-07-01T00:00:00.000Z";
    // The "correct" (largest-id) winner is listed FIRST here — the OLD
    // "sort by createdAt only" code's stable sort would preserve this
    // input order on a tie and take the LAST element (.at(-1)), i.e. the
    // SMALLER id — the wrong answer. Only an explicit id-ascending
    // secondary sort recovers the larger id regardless of input order.
    const store = fakeStoreReturning([deployment("dep_zzz_last", "2", sameCreatedAt), deployment("dep_aaa_first", "1", sameCreatedAt)]);

    await expect(findCurrentVersion(store, "wf_tie", "env_tie")).resolves.toBe("2");
  });

  it("the SAME result comes back no matter which order the store lists the tied rows in", async () => {
    const sameCreatedAt = "2026-07-01T00:00:00.000Z";
    const a = deployment("dep_aaa_first", "1", sameCreatedAt);
    const z = deployment("dep_zzz_last", "2", sameCreatedAt);

    await expect(findCurrentVersion(fakeStoreReturning([a, z]), "wf_tie", "env_tie")).resolves.toBe("2");
    await expect(findCurrentVersion(fakeStoreReturning([z, a]), "wf_tie", "env_tie")).resolves.toBe("2");
  });

  it("createdAt still wins when it does NOT tie — the id tie-break only ever applies on a genuine collision", async () => {
    const store = fakeStoreReturning([deployment("dep_earlier_by_id", "1", "2026-07-01T00:00:00.001Z"), deployment("dep_later_by_time", "2", "2026-07-01T00:00:00.002Z")]);
    await expect(findCurrentVersion(store, "wf_tie", "env_tie")).resolves.toBe("2"); // later createdAt wins, even though its id sorts earlier
  });

  it("a promoted:false row is excluded from the tie-break entirely, same as before this fix", async () => {
    const sameCreatedAt = "2026-07-01T00:00:00.000Z";
    const store = fakeStoreReturning([deployment("dep_zzz_last", "2", sameCreatedAt, false), deployment("dep_aaa_first", "1", sameCreatedAt, true)]);
    await expect(findCurrentVersion(store, "wf_tie", "env_tie")).resolves.toBe("1");
  });

  it("no active deployments -> undefined, unchanged", async () => {
    await expect(findCurrentVersion(fakeStoreReturning([]), "wf_tie", "env_tie")).resolves.toBeUndefined();
  });
});
