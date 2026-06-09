import { randomUUID } from 'node:crypto'
import type { ArtifactStore } from '../artifacts/artifact-store'

export interface Logger {
  info: (msg: string, meta?: unknown) => void
  warn: (msg: string, meta?: unknown) => void
  error: (msg: string, meta?: unknown) => void
  debug: (msg: string, meta?: unknown) => void
}

/**
 * The runtime environment handed to every block. Deliberately separated from a
 * step's `inputs` (the data to process) and `params` (behavior config):
 *
 *   inputs  -> what the block operates on
 *   params  -> how the block behaves
 *   ctx     -> the world: workspace, vars, secrets, capabilities, artifacts, logging
 *
 * Capabilities are how packs extend the runtime (e.g. the QA pack injects a
 * `browser` capability). The core never hard-codes a domain capability.
 */
export interface ExecutionContext {
  runId: string
  workspace: string
  vars: Record<string, unknown>
  secrets: Record<string, string>
  capabilities: Record<string, unknown>
  artifacts: ArtifactStore
  logger: Logger
}

export function createLogger(verbose = false): Logger {
  return {
    info: (m) => console.error(`info  ${m}`),
    warn: (m) => console.error(`warn  ${m}`),
    error: (m) => console.error(`error ${m}`),
    debug: (m) => {
      if (verbose) console.error(`debug ${m}`)
    },
  }
}

export interface CreateContextOptions {
  workspace: string
  artifacts: ArtifactStore
  runId?: string
  vars?: Record<string, unknown>
  secrets?: Record<string, string>
  capabilities?: Record<string, unknown>
  logger?: Logger
}

export function createContext(opts: CreateContextOptions): ExecutionContext {
  return {
    runId: opts.runId ?? randomUUID(),
    workspace: opts.workspace,
    vars: opts.vars ?? {},
    secrets: opts.secrets ?? {},
    capabilities: opts.capabilities ?? {},
    artifacts: opts.artifacts,
    logger: opts.logger ?? createLogger(false),
  }
}
