import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileReadBlock } from "./read.js";
import { fakeExecutionContext } from "../test-support/fake-context.js";
import { setWorkspaceRoot, WorkspacePathError } from "../lib/workspace-fs.js";

let workspaceDir: string;

beforeAll(async () => {
  workspaceDir = await mkdtemp(join(tmpdir(), "aart-file-read-test-"));
  await writeFile(join(workspaceDir, "hello.txt"), "hello world", "utf8");
  setWorkspaceRoot(workspaceDir);
});

afterAll(async () => {
  await rm(workspaceDir, { recursive: true, force: true });
});

describe("file.read", () => {
  it("has complete, correctly-declared metadata", () => {
    expect(fileReadBlock.manifest.id).toBe("file.read");
    expect(fileReadBlock.manifest.capabilities).toEqual(["file.read"]);
  });

  it("reads a utf8 file inside the workspace root", async () => {
    const result = await fileReadBlock.execute({ path: "hello.txt" }, fakeExecutionContext());
    expect(result).toEqual({ content: "hello world" });
  });

  it("reads a file as base64 when requested", async () => {
    const result = (await fileReadBlock.execute({ path: "hello.txt", encoding: "base64" }, fakeExecutionContext())) as { content: string };
    expect(Buffer.from(result.content, "base64").toString("utf8")).toBe("hello world");
  });

  it("rejects a path that escapes the workspace root", async () => {
    await expect(fileReadBlock.execute({ path: "../../etc/passwd" }, fakeExecutionContext())).rejects.toThrow(WorkspacePathError);
  });

  it("propagates a clear error for a missing file", async () => {
    await expect(fileReadBlock.execute({ path: "does-not-exist.txt" }, fakeExecutionContext())).rejects.toThrow();
  });
});
