import path from 'node:path'
import { FileRegistry } from '../registry/file-registry'
import { Runtime } from '../core/runtime'
import { builtinPacks } from '../packs'

/** The current workspace is just the cwd; all state lives under `<cwd>/.aa`. */
export function workspace(): string {
  return process.cwd()
}

/** A Runtime with the built-in packs loaded (composite registry + capabilities). */
export function openRuntime(ws = workspace()): Runtime {
  return new Runtime(ws, builtinPacks)
}

/** The bare file registry (user-authored blocks only); rarely needed directly. */
export function openRegistry(ws = workspace()): FileRegistry {
  return new FileRegistry(path.join(ws, '.aa', 'registry'))
}
