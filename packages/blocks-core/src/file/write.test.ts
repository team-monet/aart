import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileWriteBlock } from "./write.js";
import { fakeExecutionContext } from "../test-support/fake-context.js";
import { setWorkspaceRoot, WorkspacePathError } from "../lib/workspace-fs.js";

let workspaceDir: string;

beforeAll(async () => {
  workspaceDir = await mkdtemp(join(tmpdir(), "aart-file-write-test-"));
  setWorkspaceRoot(workspaceDir);
});

afterAll(async () => {
  await rm(workspaceDir, { recursive: true, force: true });
});

describe("file.write", () => {
  it("has complete, correctly-declared metadata", () => {
    expect(fileWriteBlock.manifest.id).toBe("file.write");
    expect(fileWriteBlock.manifest.capabilities).toEqual(["file.write"]);
    expect(fileWriteBlock.manifest.category).toBe("file");
  });

  it("writes a utf8 file that can be read back", async () => {
    const result = (await fileWriteBlock.execute({ path: "out.txt", content: "hello world" }, fakeExecutionContext())) as { path: string; bytes: number };
    expect(result.bytes).toBe(Buffer.byteLength("hello world", "utf8"));
    const written = await readFile(join(workspaceDir, "out.txt"), "utf8");
    expect(written).toBe("hello world");
  });

  it("writes a base64-encoded file, decoded correctly on disk", async () => {
    const content = Buffer.from("binary-ish content", "utf8").toString("base64");
    await fileWriteBlock.execute({ path: "out.b64", content, encoding: "base64" }, fakeExecutionContext());
    const written = await readFile(join(workspaceDir, "out.b64"), "utf8");
    expect(written).toBe("binary-ish content");
  });

  it("creates missing parent directories before writing", async () => {
    const result = (await fileWriteBlock.execute({ path: "nested/deep/file.txt", content: "nested" }, fakeExecutionContext())) as { path: string };
    const written = await readFile(result.path, "utf8");
    expect(written).toBe("nested");
  });

  it("rejects a path that escapes the workspace root", async () => {
    await expect(fileWriteBlock.execute({ path: "../../etc/passwd", content: "x" }, fakeExecutionContext())).rejects.toThrow(WorkspacePathError);
  });
});
