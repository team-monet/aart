import os from 'node:os'
import path from 'node:path'
import { FileRegistry } from '../registry/file-registry'
import { Runtime } from '../core/runtime'
import { builtinPacks } from '../packs'
import { loadApprovedPacks, mergePacks } from '../pack/loader'

let override: string | undefined

/** Expand a leading `~` or `~/` to the home directory; leave everything else unchanged. */
function expandTilde(p: string): string {
  if (p === '~') return os.homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2))
  return p
}

/** Set the workspace explicitly (from the global `--workspace` flag). */
export function setWorkspace(dir?: string): void {
  override = dir ? path.resolve(expandTilde(dir)) : undefined
}

export type WorkspaceSource = 'flag' | 'env' | 'default'

/**
 * The workspace holds all state under `<workspace>/.aa`. Resolution is simple
 * and explicit — no cwd magic — so the CLI, the dashboard, and the MCP server
 * ALWAYS agree on where state lives:
 *   --workspace flag  >  $AART_WORKSPACE  >  the per-user default `~/.aart`
 * Point at a project by setting AART_WORKSPACE (e.g. in BOTH your MCP config and
 * your shell) or passing --workspace; otherwise everything uses `~/.aart`. The
 * `.aa` dir is created under the resolved workspace on first run.
 */

/** Resolve the workspace AND report how it was resolved (for startup messages). */
export function resolveWorkspace(): { dir: string; source: WorkspaceSource } {
  if (override) return { dir: path.resolve(override), source: 'flag' }
  const env = process.env.AART_WORKSPACE?.trim()
  if (env) return { dir: path.resolve(expandTilde(env)), source: 'env' } // ignore an empty/whitespace value
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
