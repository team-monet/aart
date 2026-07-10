import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileListBlock } from "./list.js";
import { fakeExecutionContext } from "../test-support/fake-context.js";
import { setWorkspaceRoot, WorkspacePathError } from "../lib/workspace-fs.js";

let workspaceDir: string;

beforeAll(async () => {
  workspaceDir = await mkdtemp(join(tmpdir(), "aart-file-list-test-"));
  await writeFile(join(workspaceDir, "a.txt"), "a", "utf8");
  await writeFile(join(workspaceDir, "b.txt"), "b", "utf8");
  await writeFile(join(workspaceDir, "c.json"), "{}", "utf8");
  setWorkspaceRoot(workspaceDir);
});

afterAll(async () => {
  await rm(workspaceDir, { recursive: true, force: true });
});

describe("file.list", () => {
  it("has complete, correctly-declared metadata", () => {
    expect(fileListBlock.manifest.id).toBe("file.list");
    expect(fileListBlock.manifest.capabilities).toEqual(["file.read"]);
    expect(fileListBlock.manifest.category).toBe("file");
  });

  it("lists all entries in a directory when no pattern is given", async () => {
    const result = (await fileListBlock.execute({ path: "." }, fakeExecutionContext())) as { entries: string[] };
    expect(result.entries.sort()).toEqual(["a.txt", "b.txt", "c.json"].sort());
  });

  it("filters entries by a simple glob pattern", async () => {
    const result = (await fileListBlock.execute({ path: ".", pattern: "*.txt" }, fakeExecutionContext())) as { entries: string[] };
    expect(result.entries.sort()).toEqual(["a.txt", "b.txt"]);
  });

  it("rejects a path that escapes the workspace root", async () => {
    await expect(fileListBlock.execute({ path: "../../etc" }, fakeExecutionContext())).rejects.toThrow(WorkspacePathError);
  });
});
