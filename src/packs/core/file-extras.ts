import fs from 'node:fs'
import path from 'node:path'
import { nativeBlock } from '../../pack/types'
import type { ExecutionContext } from '../../core/context'

/**
 * Workspace-scoped file extras. Paths are workspace-relative and confined to it —
 * `..` escapes are rejected, and the runtime's own `.aa` state is off-limits.
 * Mirrors the confinement logic from file.ts exactly.
 */

function resolveInWorkspace(ctx: ExecutionContext, p: string): string {
  const abs = path.resolve(ctx.workspace, p)
  const root = path.resolve(ctx.workspace)
  // Syntactic check: reject obvious path-traversal without touching the filesystem.
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`path escapes the workspace: ${p}`)
  }
  const rel = path.relative(root, abs)
  if (rel === '.aa' || rel.startsWith('.aa' + path.sep)) {
    throw new Error(`path is inside .aa (runtime state, includes secrets) — not allowed: ${p}`)
  }
  // Symlink check: walk the workspace-relative path segment-by-segment using
  // lstatSync (which does NOT follow symlinks) so we catch DANGLING symlinks
  // too (accessSync/realpathSync follow the link and throw ENOENT on a dangling
  // target, causing the old walk to skip the symlink entirely).
  //
  // Algorithm: split the relative path into segments; for each prefix that
  // exists on disk, lstat it — if it's a symlink (live OR dangling), reject
  // immediately.  An ENOENT means the component doesn't exist yet (fine for
  // write/append ops), so we stop walking deeper.
  const realRoot = fs.realpathSync(root)
  const segments = rel === '' ? [] : rel.split(path.sep)
  let current = root
  for (const seg of segments) {
    current = path.join(current, seg)
    let lstat: fs.Stats
    try {
      lstat = fs.lstatSync(current)
    } catch {
      // ENOENT — component doesn't exist yet (fine for write/append ops); stop walking.
      break
    }
    if (lstat.isSymbolicLink()) {
      throw new Error(`path contains a symlinked component (not allowed): ${p}`)
    }
  }
  // Belt-and-suspenders: confirm the deepest existing prefix (with OS-level
  // aliasing normalised) is still inside the workspace.
  const existingPrefix = (() => {
    let e = abs
    while (e !== path.dirname(e)) {
      try { fs.lstatSync(e); return e } catch { e = path.dirname(e) }
    }
    return root
  })()
  let realExisting: string
  try {
    realExisting = fs.realpathSync(existingPrefix)
  } catch {
    realExisting = realRoot
  }
  if (realExisting !== realRoot && !realExisting.startsWith(realRoot + path.sep)) {
    throw new Error(`path escapes the workspace (via symlink): ${p}`)
  }
  // Re-check .aa against the real path so a symlink pointing into .aa is caught.
  const realRel = path.relative(realRoot, realExisting)
  if (realRel === '.aa' || realRel.startsWith('.aa' + path.sep)) {
    throw new Error(`path is inside .aa (runtime state, includes secrets) — not allowed: ${p}`)
  }
  return abs
}

// ---------------------------------------------------------------------------
// file.exists — non-throwing existence check
// ---------------------------------------------------------------------------

export const fileExists = nativeBlock(
  {
    id: 'file.exists',
    name: 'File Exists',
    version: '0.1.0',
    description:
      'Check whether a workspace-relative path exists without throwing if it is absent. ' +
      'Returns exists, isFile, and isDir flags. `.aa/**` is off-limits.',
    category: 'file',
    keywords: ['exists', 'check', 'file', 'directory', 'stat', 'present'],
    examples: [
      {
        description: 'Check whether a config file exists before reading it',
        inputs: { path: 'config/settings.json' },
      },
    ],
    inputs: [{ name: 'path', type: 'string', required: true }],
    outputs: [
      { name: 'exists', type: 'boolean' },
      { name: 'isFile', type: 'boolean' },
      { name: 'isDir', type: 'boolean' },
    ],
  },
  async (ctx, inputs) => {
    const abs = resolveInWorkspace(ctx, String(inputs.path))
    try {
      const stat = fs.statSync(abs)
      return { exists: true, isFile: stat.isFile(), isDir: stat.isDirectory() }
    } catch {
      return { exists: false, isFile: false, isDir: false }
    }
  },
)

// ---------------------------------------------------------------------------
// dir.list — list directory entries, optional glob filter
// ---------------------------------------------------------------------------

/** Minimal glob: supports * as a wildcard anywhere in the pattern. */
function matchGlob(name: string, glob: string): boolean {
  // Escape regex metacharacters except *, then replace * with .*
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`).test(name)
}

export const dirList = nativeBlock(
  {
    id: 'dir.list',
    name: 'List Directory',
    version: '0.1.0',
    description:
      'List entries in a workspace-relative directory. ' +
      'If `glob` is given, only names matching the pattern are returned (supports `*` as a wildcard). ' +
      '`.aa/**` is off-limits.',
    category: 'file',
    keywords: ['list', 'directory', 'dir', 'ls', 'glob', 'entries', 'files'],
    examples: [
      {
        description: 'List all JSON files in a directory',
        inputs: { path: 'reports', glob: '*.json' },
      },
    ],
    inputs: [
      { name: 'path', type: 'string', default: '.' },
      { name: 'glob', type: 'string' },
    ],
    outputs: [{ name: 'entries', type: 'array' }],
  },
  async (ctx, inputs) => {
    const abs = resolveInWorkspace(ctx, String(inputs.path ?? '.'))
    let names: string[]
    try {
      names = fs.readdirSync(abs)
    } catch {
      throw new Error(`dir.list: cannot read directory: ${String(inputs.path ?? '.')}`)
    }
    // Sort before filtering so the result is deterministic regardless of the
    // underlying filesystem's readdir order (ext4, APFS, etc. differ).
    // Use default lexicographic (UTF-16 code-unit) sort — locale-independent
    // and stable across Node versions and process locales.
    names.sort()
    if (inputs.glob !== undefined && inputs.glob !== null && String(inputs.glob) !== '') {
      const glob = String(inputs.glob)
      names = names.filter((n) => matchGlob(n, glob))
    }
    return { entries: names }
  },
)

// ---------------------------------------------------------------------------
// file.append — append to a file (creates file + parents if missing)
// ---------------------------------------------------------------------------

export const fileAppend = nativeBlock(
  {
    id: 'file.append',
    name: 'Append to File',
    version: '0.1.0',
    description:
      'Append `content` to a workspace-relative file. ' +
      'Creates the file and any missing parent directories if needed. ' +
      '`.aa/**` is off-limits. For per-run outputs prefer artifact.write; ' +
      'file.append is for durable workspace state (logs, accumulated lists).',
    category: 'file',
    keywords: ['append', 'write', 'file', 'log', 'accumulate', 'add'],
    examples: [
      {
        description: 'Append a line to a running log file',
        inputs: { path: 'logs/run.log', content: 'Step completed at 2025-01-01T00:00:00Z\n' },
      },
    ],
    inputs: [
      { name: 'path', type: 'string', required: true },
      { name: 'content', type: 'string', required: true },
    ],
    outputs: [{ name: 'path', type: 'string' }],
  },
  async (ctx, inputs) => {
    const abs = resolveInWorkspace(ctx, String(inputs.path))
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.appendFileSync(abs, String(inputs.content), 'utf8')
    return { path: path.relative(path.resolve(ctx.workspace), abs) }
  },
)
