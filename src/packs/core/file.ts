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
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`path escapes the workspace: ${p}`)
  }
  const rel = path.relative(root, abs)
  if (rel === '.aa' || rel.startsWith('.aa' + path.sep)) {
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
