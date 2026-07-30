import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  openOperationalState,
  sealOperationalState,
} from "./operational-state-seal.js";
import {
  openWaitOperation,
  sealWaitOperation,
} from "./wait-operation-seal.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(
    join(tmpdir(), "aart-operational-seal-"),
  );
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("operational key loading", () => {
  it("retries a generic operational-state key after a transient load failure", async () => {
    const keyPath = join(root, "state-key");
    await fs.mkdir(keyPath);
    await expect(
      sealOperationalState(
        keyPath,
        ["run", "step"],
        { value: "raw" },
      ),
    ).rejects.toThrow();

    await fs.rm(keyPath, { recursive: true });
    const sealed = await sealOperationalState(
      keyPath,
      ["run", "step"],
      { value: "raw" },
    );
    await expect(
      openOperationalState(
        keyPath,
        ["run", "step"],
        sealed,
      ),
    ).resolves.toEqual({ value: "raw" });
  });

  it("retries a wait-operation key after a transient load failure", async () => {
    const keyPath = join(root, "wait-key");
    const wait = {
      type: "manual" as const,
      schemaVersion: 1,
    };
    await fs.mkdir(keyPath);
    await expect(
      sealWaitOperation(
        keyPath,
        "run",
        "step",
        "generation",
        wait,
      ),
    ).rejects.toThrow();

    await fs.rm(keyPath, { recursive: true });
    const sealed = await sealWaitOperation(
      keyPath,
      "run",
      "step",
      "generation",
      wait,
    );
    await expect(
      openWaitOperation(
        keyPath,
        "run",
        "step",
        "generation",
        sealed,
      ),
    ).resolves.toEqual(wait);
  });
});
