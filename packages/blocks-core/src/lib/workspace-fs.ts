// Workspace-scoped path resolution for the `file.*` block group (spec
// §31.1: "file.read (workspace-scoped)", "file.write (workspace-scoped)").
// `file.*` blocks never touch a caller-supplied path directly — every path
// goes through `resolveWorkspacePath` first, which rejects any path that
// would resolve outside the configured workspace root (a `../../etc/passwd`
// traversal, or an absolute path pointing elsewhere entirely). This is the
// same "structural guarantee over sanitization" preference architecture
// §15 states for the rest of this system's security model, applied to the
// one part of the File group's threat surface that isn't already covered
// by the coarse `file.read`/`file.write` capability grant (declaring the
// capability says "this workflow may touch files at all," not "may only
// touch files inside its own workspace" — that second, narrower guarantee
// is this module's job, the same division of labor ADR-09 draws between
// engine-level capability dispatch and provider-level domain/path checks).
import { isAbsolute, relative, resolve, sep } from "node:path";

export class WorkspacePathError extends Error {
  constructor(
    public readonly requestedPath: string,
    public readonly workspaceRoot: string,
  ) {
    super(`path ${JSON.stringify(requestedPath)} escapes the workspace root ${JSON.stringify(workspaceRoot)}`);
    this.name = "WorkspacePathError";
  }
}

let currentWorkspaceRoot = process.cwd();

/** Composition-root call — analogous to `setEgressPolicy`. Defaults to `process.cwd()` at module load. */
export function setWorkspaceRoot(root: string): void {
  currentWorkspaceRoot = resolve(root);
}

export function getWorkspaceRoot(): string {
  return currentWorkspaceRoot;
}

/** Resolves `requestedPath` (relative or absolute) against `workspaceRoot` (defaults to the current module-level root), throwing `WorkspacePathError` if the result would land outside it. */
export function resolveWorkspacePath(requestedPath: string, workspaceRoot: string = currentWorkspaceRoot): string {
  const root = resolve(workspaceRoot);
  const resolved = resolve(root, requestedPath);
  const rel = relative(root, resolved);
  const escapes = rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  if (escapes) {
    throw new WorkspacePathError(requestedPath, root);
  }
  return resolved;
}
