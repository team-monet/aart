import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertArtifactExistsBlock } from "./artifact-exists.js";
import { BlockAssertionError } from "../lib/assertion.js";
import { fakeExecutionContext } from "../test-support/fake-context.js";

let dir: string;
let existingFile: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "aart-artifact-exists-test-"));
  existingFile = join(dir, "artifact.png");
  await writeFile(existingFile, "fake-bytes");
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("assert.artifact_exists", () => {
  it("has complete, correctly-declared metadata (capability: file.read)", () => {
    expect(assertArtifactExistsBlock.manifest.id).toBe("assert.artifact_exists");
    expect(assertArtifactExistsBlock.manifest.capabilities).toEqual(["file.read"]);
  });

  it("passes when the artifact exists at the given path", async () => {
    await expect(assertArtifactExistsBlock.execute({ path: existingFile }, fakeExecutionContext())).resolves.toEqual({
      passed: true,
      path: existingFile,
    });
  });

  it("throws BlockAssertionError when nothing exists at the path", async () => {
    await expect(assertArtifactExistsBlock.execute({ path: join(dir, "missing.png") }, fakeExecutionContext())).rejects.toThrow(
      BlockAssertionError,
    );
  });

  it("does not apply workspace-root scoping (an artifact path may legitimately live outside it)", async () => {
    // existingFile is under a tmp dir that is NOT the workspace root — this
    // must still pass, unlike file.* blocks which would reject it.
    await expect(assertArtifactExistsBlock.execute({ path: existingFile }, fakeExecutionContext())).resolves.toMatchObject({ passed: true });
  });
});
