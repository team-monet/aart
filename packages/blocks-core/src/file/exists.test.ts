import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileExistsBlock } from "./exists.js";
import { fakeExecutionContext } from "../test-support/fake-context.js";
import { setWorkspaceRoot, WorkspacePathError } from "../lib/workspace-fs.js";

let workspaceDir: string;

beforeAll(async () => {
  workspaceDir = await mkdtemp(join(tmpdir(), "aart-file-exists-test-"));
  await writeFile(join(workspaceDir, "present.txt"), "here", "utf8");
  setWorkspaceRoot(workspaceDir);
});

afterAll(async () => {
  await rm(workspaceDir, { recursive: true, force: true });
});

describe("file.exists", () => {
  it("has complete, correctly-declared metadata", () => {
    expect(fileExistsBlock.manifest.id).toBe("file.exists");
    expect(fileExistsBlock.manifest.capabilities).toEqual(["file.read"]);
    expect(fileExistsBlock.manifest.category).toBe("file");
  });

  it("reports true for a file that exists", async () => {
    const result = await fileExistsBlock.execute({ path: "present.txt" }, fakeExecutionContext());
    expect(result).toEqual({ exists: true });
  });

  it("reports false, without throwing, for a file that does not exist", async () => {
    const result = await fileExistsBlock.execute({ path: "absent.txt" }, fakeExecutionContext());
    expect(result).toEqual({ exists: false });
  });

  it("still throws WorkspacePathError for a path that escapes the workspace root", async () => {
    await expect(fileExistsBlock.execute({ path: "../../etc/passwd" }, fakeExecutionContext())).rejects.toThrow(WorkspacePathError);
  });
});
