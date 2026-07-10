import { createFsStore, createLogger, type Logger } from "@aart/store";
import type { PackManifest } from "@aart/types";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyPackApprovalDecision, isPackSealBroken, writePackApprovalDecision } from "./pack-approval.js";

function manifest(overrides: Partial<PackManifest> = {}): PackManifest {
  return {
    name: "aart-pack-github",
    version: "1.0.0",
    contentHash: "sha256:abc123",
    manifest: { capabilities: ["github.read", "github.write"] },
    approvalStatus: "unapproved",
    ...overrides,
  };
}

describe("applyPackApprovalDecision — pure", () => {
  it("returns a new manifest with approvalStatus set to the decision", () => {
    const original = manifest();
    const updated = applyPackApprovalDecision({ manifest: original, decision: "approved", reviewer: "jane", decidedAt: "2026-07-10T00:00:00.000Z" });
    expect(updated.approvalStatus).toBe("approved");
    expect(original.approvalStatus).toBe("unapproved"); // input untouched
  });
});

describe("writePackApprovalDecision — spec §16.2's approval-gate wiring, against a real store", () => {
  let root: string;
  let store: ReturnType<typeof createFsStore>;
  let logger: Logger;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), "aart-governance-packs-"));
    store = createFsStore(root);
    logger = createLogger();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("persists the approval decision, retrievable via store.packManifests", async () => {
    const result = await writePackApprovalDecision(
      store,
      { manifest: manifest(), decision: "approved", reviewer: "jane@example.com", decidedAt: "2026-07-10T00:00:00.000Z" },
      logger,
    );
    expect(result.approvalStatus).toBe("approved");
    const stored = await store.packManifests.get("aart-pack-github", "1.0.0");
    expect(stored?.approvalStatus).toBe("approved");
  });

  it("routes through the redaction chokepoint before persisting", async () => {
    const secret = "sk-live-pack-manifest-secret";
    const result = await writePackApprovalDecision(
      store,
      {
        manifest: manifest({ manifest: { note: `configured with ${secret}` } }),
        decision: "approved",
        reviewer: "jane",
        decidedAt: "2026-07-10T00:00:00.000Z",
      },
      logger,
      new Set([secret]),
    );
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});

describe("isPackSealBroken — 'any edit breaks approval seal' (spec §16.2)", () => {
  it("is false when the content hash is unchanged since approval", () => {
    const approved = manifest({ contentHash: "sha256:abc123" });
    const current = manifest({ contentHash: "sha256:abc123" });
    expect(isPackSealBroken(approved, current)).toBe(false);
  });

  it("is true when the content hash has changed — the seal is broken by any edit", () => {
    const approved = manifest({ contentHash: "sha256:abc123" });
    const current = manifest({ contentHash: "sha256:def456" }); // block code edited, hash recomputed by S7
    expect(isPackSealBroken(approved, current)).toBe(true);
  });
});
