import path from 'node:path'
import { FileRegistry } from '../registry/file-registry'
import { Runtime } from '../core/runtime'
import { builtinPacks } from '../packs'

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

/** A Runtime with the built-in packs loaded (composite registry + capabilities). */
export function openRuntime(ws = workspace()): Runtime {
  return new Runtime(ws, builtinPacks)
}

/** The bare file registry (user-authored blocks only); rarely needed directly. */
export function openRegistry(ws = workspace()): FileRegistry {
  return new FileRegistry(path.join(ws, '.aa', 'registry'))
}
