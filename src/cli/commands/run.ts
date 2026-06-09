import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import { runDefinition } from '../../core/run-service'
import { renderReport } from '../../core/report'
import { BlockDefinitionSchema, type BlockDefinition } from '../../core/types'
import { openRegistry, workspace } from '../workspace'

interface RunOpts {
  input: string
  param: string
  verbose: boolean
}

export async function runCommand(workflowRef: string, opts: RunOpts): Promise<void> {
  const ws = workspace()
  const registry = openRegistry(ws)

  // Resolve the workflow: a file path, or an id in the registry.
  let wf: BlockDefinition | undefined
  const looksLikeFile =
    workflowRef.endsWith('.yaml') || workflowRef.endsWith('.yml') || fs.existsSync(workflowRef)
  if (looksLikeFile) {
    if (!fs.existsSync(workflowRef)) {
      console.error(`File not found: ${workflowRef}`)
      process.exit(1)
    }
    wf = BlockDefinitionSchema.parse(YAML.parse(fs.readFileSync(workflowRef, 'utf8')))
  } else {
    wf = registry.getBlock(workflowRef)
    if (!wf) {
      console.error(`Workflow not found in registry: ${workflowRef}`)
      console.error('List what is registered with:  aart list')
      process.exit(1)
    }
  }

  const inputs = parseJson(opts.input, '--input')
  const params = parseJson(opts.param, '--param')

  const record = await runDefinition(ws, registry, wf, inputs, params, {
    verbose: opts.verbose,
  })

  console.log(renderReport(record))
  console.log(`\nreport: ${path.join('.aa', 'runs', record.runId, 'run.json')}`)
  if (record.status === 'FAILED') process.exit(1)
}

function parseJson(value: string, flag: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('expected a JSON object')
    }
    return parsed as Record<string, unknown>
  } catch (err) {
    console.error(`Invalid ${flag}: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}
