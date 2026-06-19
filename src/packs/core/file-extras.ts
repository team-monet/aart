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
  // Symlink check: resolve the real path of the deepest existing ancestor
  // (the target file may not exist yet for write/append ops) and verify it
  // still lives inside the workspace's real path. This catches symlinks like
  // `logs -> /tmp/outside` that pass the syntactic check above.
  const realRoot = fs.realpathSync(root)
  // Walk up from abs to find the deepest existing ancestor directory.
  let existing = abs
  while (existing !== path.dirname(existing)) {
    try {
      fs.accessSync(existing)
      break
    } catch {
      existing = path.dirname(existing)
    }
  }
  let realExisting: string
  try {
    realExisting = fs.realpathSync(existing)
  } catch {
    // If even the ancestor can't be resolved, fall back to the root check already done.
    realExisting = realRoot
  }
  if (realExisting !== realRoot && !realExisting.startsWith(realRoot + path.sep)) {
    throw new Error(`path escapes the workspace (via symlink): ${p}`)
  }
  // Re-check .aa against the real path so a symlink pointing into .aa is also caught.
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
    names.sort((a, b) => a.localeCompare(b))
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
