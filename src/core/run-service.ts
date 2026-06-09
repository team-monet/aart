import { randomUUID } from 'node:crypto'
import { Engine } from './engine'
import { createContext, createLogger } from './context'
import { ArtifactStore } from '../artifacts/artifact-store'
import { writeRun, runDir } from './report'
import type { Registry } from '../registry/file-registry'
import type { BlockDefinition, RunRecord } from './types'

/**
 * Shared "execute a definition, persist its report" path used by both the CLI
 * `run` command and the MCP `aa_run_workflow` tool, so the coding agent and a
 * human get identical deterministic execution + evidence.
 */
export async function runDefinition(
  workspace: string,
  registry: Registry,
  def: BlockDefinition,
  inputs: Record<string, unknown>,
  params?: Record<string, unknown>,
  opts: { verbose?: boolean } = {},
): Promise<RunRecord> {
  const runId = randomUUID()
  const artifacts = new ArtifactStore(runDir(workspace, runId))
  const ctx = createContext({
    runId,
    workspace,
    artifacts,
    logger: createLogger(opts.verbose),
  })
  const record = await new Engine(registry).run(def, inputs, ctx, params)
  await writeRun(workspace, record)
  return record
}
