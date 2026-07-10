import { afterEach, describe, expect, it } from "vitest";
import { join, resolve } from "node:path";
import { getWorkspaceRoot, resolveWorkspacePath, setWorkspaceRoot, WorkspacePathError } from "./workspace-fs.js";

describe("resolveWorkspacePath", () => {
  const root = resolve("/tmp/aart-workspace-fs-test-root");

  afterEach(() => {
    setWorkspaceRoot(process.cwd());
  });

  it("resolves a plain relative path inside the workspace root", () => {
    expect(resolveWorkspacePath("a/b/c.txt", root)).toBe(join(root, "a/b/c.txt"));
  });

  it("resolves the workspace root itself", () => {
    expect(resolveWorkspacePath(".", root)).toBe(root);
    expect(resolveWorkspacePath("", root)).toBe(root);
  });

  it("rejects a ../ traversal that escapes the root", () => {
    expect(() => resolveWorkspacePath("../../etc/passwd", root)).toThrow(WorkspacePathError);
  });

  it("rejects an absolute path pointing outside the root", () => {
    expect(() => resolveWorkspacePath("/etc/passwd", root)).toThrow(WorkspacePathError);
  });

  it("allows a deeply nested relative path that stays inside the root", () => {
    expect(() => resolveWorkspacePath("a/b/c/d/e.txt", root)).not.toThrow();
  });

  it("rejects a path that traverses out and back in a way that still nets outside the root", () => {
    expect(() => resolveWorkspacePath("a/../../b", root)).toThrow(WorkspacePathError);
  });

  it("uses the module-level configured root when no explicit root is passed", () => {
    setWorkspaceRoot(root);
    expect(getWorkspaceRoot()).toBe(root);
    expect(resolveWorkspacePath("x.txt")).toBe(join(root, "x.txt"));
    expect(() => resolveWorkspacePath("../outside.txt")).toThrow(WorkspacePathError);
  });
});
