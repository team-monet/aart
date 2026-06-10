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

/**
 * The workspace holds all state under `<workspace>/.aa`. Resolution order:
 *   --workspace flag  >  $AART_WORKSPACE  >  process.cwd()
 * Set AART_WORKSPACE in your MCP server config so `.aa` always lands in your
 * project dir, regardless of the cwd the agent host launches the server from.
 */
export function workspace(): string {
  return path.resolve(override ?? process.env.AART_WORKSPACE ?? process.cwd())
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
