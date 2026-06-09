import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import { renderReport } from '../../core/report'
import { validateDraft } from '../../agent/validate'
import { unapprovedInTree } from '../../core/approval'
import type { BlockDefinition } from '../../core/types'
import { openRuntime } from '../workspace'

interface RunOpts {
  input: string
  param: string
  verbose: boolean
  yes: boolean
}

export async function runCommand(workflowRef: string, opts: RunOpts): Promise<void> {
  const runtime = openRuntime()

  // Resolve the workflow: a file path, or an id in the registry.
  let wf: BlockDefinition | undefined
  let fromFile = false
  const looksLikeFile =
    workflowRef.endsWith('.yaml') || workflowRef.endsWith('.yml') || fs.existsSync(workflowRef)
  if (looksLikeFile) {
    fromFile = true
    if (!fs.existsSync(workflowRef)) {
      console.error(`File not found: ${workflowRef}`)
      process.exit(1)
    }
    let parsed: unknown
    try {
      parsed = YAML.parse(fs.readFileSync(workflowRef, 'utf8'))
    } catch (err) {
      console.error(`Not valid YAML/JSON: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    }
    // Same gate as `block add`: structure + referenced blocks must resolve.
    const result = validateDraft(parsed, runtime.registry)
    if (!result.ok || !result.block) {
      console.error('✗ refused — definition is invalid:')
      for (const e of result.errors) console.error(`  - ${e}`)
      process.exit(1)
    }
    wf = result.block
  } else {
    wf = runtime.registry.getBlock(workflowRef)
    if (!wf) {
      console.error(`Workflow not found in registry: ${workflowRef}`)
      console.error('List what is registered with:  aart list')
      process.exit(1)
    }
  }

  // Approval gate: an ad-hoc file def is never pre-trusted (trustTop=false);
  // a registry def's own approval is trusted. Either way the human can run an
  // unapproved definition once with --yes.
  const pending = unapprovedInTree(wf, runtime.registry, !fromFile)
  const approved = pending.length === 0
  if (!approved && !opts.yes) {
    console.error(`✗ refused — not approved: ${pending.join(', ')}`)
    if (!fromFile) console.error(`approve with:  aart approve ${pending.join(' && aart approve ')}`)
    console.error(`or run it once as the human with:  --yes`)
    process.exit(1)
  }

  const inputs = parseJson(opts.input, '--input')
  const params = parseJson(opts.param, '--param')

  const record = await runtime.run(wf, inputs, params, { verbose: opts.verbose, approved })

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
