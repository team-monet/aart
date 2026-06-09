import path from 'node:path'
import { FileRegistry } from '../registry/file-registry'

/** The current workspace is just the cwd; all state lives under `<cwd>/.aa`. */
export function workspace(): string {
  return process.cwd()
}

export function openRegistry(ws = workspace()): FileRegistry {
  return new FileRegistry(path.join(ws, '.aa', 'registry'))
}
