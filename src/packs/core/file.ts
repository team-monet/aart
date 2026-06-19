import fs from 'node:fs'
import path from 'node:path'
import { nativeBlock } from '../../pack/types'
import type { ExecutionContext } from '../../core/context'

/**
 * Workspace-scoped file I/O. Paths are workspace-relative and confined to it —
 * `..` escapes are rejected, and the runtime's own `.aa` state (which includes
 * `secrets.json`) is off-limits in both directions. For per-run outputs prefer
 * `artifact.write`; files are for durable workspace state automations maintain
 * (a tracked list, a generated doc, a config a workflow updates).
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
  // (the target file may not exist yet for write ops) and verify it still
  // lives inside the workspace's real path. Catches symlinks like
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

export const fileRead = nativeBlock(
  {
    id: 'file.read',
    name: 'Read File',
    version: '0.1.0',
    description:
      'Read a UTF-8 file by workspace-relative path. Clamped at `maxChars` ' +
      '(default 200000); `truncated` reports clipping. `.aa/**` is off-limits.',
    category: 'file',
    keywords: ['file', 'read', 'load', 'open', 'text', 'workspace', 'path', 'content'],
    examples: [
      {
        description: 'Read a config file from the workspace',
        inputs: { path: 'config/settings.json' },
      },
    ],
    inputs: [
      { name: 'path', type: 'string', required: true },
      { name: 'maxChars', type: 'number' },
    ],
    outputs: [
      { name: 'text', type: 'string' },
      { name: 'truncated', type: 'boolean' },
    ],
  },
  async (ctx, inputs) => {
    const abs = resolveInWorkspace(ctx, String(inputs.path))
    const raw = fs.readFileSync(abs, 'utf8')
    const limit = typeof inputs.maxChars === 'number' && inputs.maxChars > 0 ? inputs.maxChars : 200_000
    return raw.length > limit
      ? { text: raw.slice(0, limit), truncated: true }
      : { text: raw, truncated: false }
  },
)

export const fileWrite = nativeBlock(
  {
    id: 'file.write',
    name: 'Write File',
    version: '0.1.0',
    description:
      'Write `content` to a workspace-relative path (parent dirs created). ' +
      'Overwrites. `.aa/**` is off-limits. For per-run outputs use artifact.write.',
    category: 'file',
    keywords: ['file', 'write', 'save', 'create', 'output', 'workspace', 'path', 'content'],
    examples: [
      {
        description: 'Write generated content to a workspace file',
        inputs: { path: 'output/summary.txt', content: 'Run completed successfully.' },
      },
    ],
    inputs: [
      { name: 'path', type: 'string', required: true },
      { name: 'content', type: 'string', required: true },
    ],
    outputs: [
      { name: 'path', type: 'string' },
      { name: 'bytes', type: 'number' },
    ],
  },
  async (ctx, inputs) => {
    const abs = resolveInWorkspace(ctx, String(inputs.path))
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    const content = String(inputs.content)
    fs.writeFileSync(abs, content)
    return { path: path.relative(path.resolve(ctx.workspace), abs), bytes: Buffer.byteLength(content) }
  },
)
