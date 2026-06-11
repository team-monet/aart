import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FileRegistry } from '../registry/file-registry'
import { Runtime } from '../core/runtime'
import { builtinPacks } from '../packs'
import { loadApprovedPacks, mergePacks } from '../pack/loader'

let override: string | undefined

/** Set the workspace explicitly (from the global `--workspace` flag). */
export function setWorkspace(dir?: string): void {
  override = dir ? path.resolve(dir) : undefined
}

export type WorkspaceSource = 'flag' | 'env' | 'discovered' | 'default'

/** Nearest ancestor of `start` (inclusive) that contains a `.aa` dir, else undefined. */
export function findWorkspaceRoot(start: string): string | undefined {
  let dir = path.resolve(start)
  try {
    dir = fs.realpathSync(dir) // resolve symlinks so a symlinked cwd still finds the project .aa
  } catch {
    // `start` may not exist yet — fall back to the lexical path
  }
  for (;;) {
    const aa = path.join(dir, '.aa')
    if (fs.existsSync(aa) && fs.statSync(aa).isDirectory()) return dir // a *file* named .aa doesn't count
    const parent = path.dirname(dir)
    if (parent === dir) return undefined // reached the filesystem root
    dir = parent
  }
}

/**
 * The workspace holds all state under `<workspace>/.aa`. Resolution order:
 *   --workspace flag  >  $AART_WORKSPACE  >  nearest ancestor containing `.aa`  >  ~/.aart
 * Upward `.aa` discovery (step 3) means once a project has a workspace, `aart
 * dashboard` and the CLI find it from anywhere inside the tree. With nothing
 * pinned and no `.aa` nearby, aart uses a per-user default (`~/.aart`) rather
 * than the cwd — so it never lands in a stray or unwritable directory (an MCP
 * host controls the cwd it launches the server from). Set AART_WORKSPACE (or
 * --workspace) to scope a workspace to a project; `.aa` is created on first run.
 */

/** Resolve the workspace AND report how it was resolved (for startup messages). */
export function resolveWorkspace(): { dir: string; source: WorkspaceSource } {
  if (override) return { dir: path.resolve(override), source: 'flag' }
  const env = process.env.AART_WORKSPACE?.trim()
  if (env) return { dir: path.resolve(env), source: 'env' } // ignore an empty/whitespace value
  const found = findWorkspaceRoot(process.cwd())
  if (found) return { dir: found, source: 'discovered' }
  // Nothing pinned and no .aa nearby — use the per-user default. Its `.aa` is
  // created on first run by openRuntime (recursive mkdir), like any workspace.
  return { dir: defaultWorkspace(), source: 'default' }
}

/** The per-user default workspace (`~/.aart`), used when nothing else resolves. */
export function defaultWorkspace(): string {
  return path.join(os.homedir(), '.aart')
}

export function workspace(): string {
  return resolveWorkspace().dir
}

/** Human-readable label for a workspace source, for CLI/MCP startup lines. */
export function workspaceSourceLabel(source: WorkspaceSource): string {
  return source === 'flag' ? 'via --workspace'
    : source === 'env' ? 'via $AART_WORKSPACE'
    : source === 'discovered' ? 'discovered .aa in a parent directory'
    : 'default workspace (~/.aart)'
}

/**
 * A Runtime with the built-in packs plus the workspace's approved packs
 * (`.aa/packs.json`). Pack problems (edited since approval, load errors,
 * id collisions) never prevent startup — they are warned to stderr and the
 * pack is skipped.
 */
export function openRuntime(ws = workspace()): Runtime {
  const loaded = loadApprovedPacks(ws)
  const merged = mergePacks(builtinPacks, loaded.packs)
  for (const w of [...loaded.warnings, ...merged.warnings]) console.error(`warn  ${w}`)
  return new Runtime(ws, merged.packs)
}

/** The bare file registry (user-authored blocks only); rarely needed directly. */
export function openRegistry(ws = workspace()): FileRegistry {
  return new FileRegistry(path.join(ws, '.aa', 'registry'))
}
