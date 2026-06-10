import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Runtime } from './runtime'
import { validateDraft } from '../agent/validate'
import { renderDefinition } from '../agent/render'
import { FileRegistry } from '../registry/file-registry'
import type { BlockDefinition } from './types'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aart-constraints-'))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

// The safe-interface story: a command block whose `namespace` input simply
// cannot take values outside the approved set, regardless of caller.
const kubectlish: BlockDefinition = {
  id: 'tool.ns-status',
  name: 'NS Status',
  version: '0.1.0',
  inputs: [{ name: 'namespace', type: 'string', required: true, enum: ['dev', 'staging'] }],
  outputs: [{ name: 'stdout', type: 'string' }],
  execution: {
    type: 'command',
    command: 'node',
    args: ['-e', 'console.log("status of", process.argv[1])', '{{inputs.namespace}}'],
  },
}

describe('input constraints (enum/pattern) at the engine boundary', () => {
  it('enum: an out-of-range value never reaches the command', async () => {
    const runtime = new Runtime(dir, [])
    const bad = await runtime.run(kubectlish, { namespace: 'prod' })
    expect(bad.status).toBe('FAILED')
    expect(bad.error).toMatch(/must be one of: dev, staging.*"prod"/)

    const ok = await runtime.run(kubectlish, { namespace: 'dev' })
    expect(ok.status).toBe('COMPLETED')
    expect(ok.results?.stdout).toBe('status of dev\n')
  })

  it('pattern: full-match only — a partial hit does not pass the gate', async () => {
    const def: BlockDefinition = {
      id: 'slug-check',
      name: 'Slug Check',
      version: '0.1.0',
      inputs: [{ name: 'slug', type: 'string', required: true, pattern: '[a-z][a-z-]*' }],
      outputs: [],
      execution: { type: 'node', code: 'return { slug: inputs.slug }' },
    }
    const runtime = new Runtime(dir, [])
    const bad = await runtime.run(def, { slug: 'ok-then; rm -rf' })
    expect(bad.status).toBe('FAILED')
    expect(bad.error).toMatch(/must match pattern/)
    expect((await runtime.run(def, { slug: 'ok-then' })).status).toBe('COMPLETED')
  })

  it('constraints guard workflow inputs too (the root is a block like any other)', async () => {
    const wf: BlockDefinition = {
      id: 'gated-wf',
      name: 'Gated WF',
      version: '0.1.0',
      inputs: [{ name: 'env', type: 'string', required: true, enum: ['dev'] }],
      outputs: [],
      execution: {
        type: 'workflow',
        steps: [{ id: 'noop', block: 'assert.equals', inputs: { actual: 1, expected: 1 } }],
      },
    }
    // assert.equals comes from the core pack — load it.
    const { corePack } = await import('../packs/core')
    const record = await new Runtime(dir, [corePack]).run(wf, { env: 'prod' })
    expect(record.status).toBe('FAILED')
    expect(record.error).toMatch(/must be one of: dev/)
  })

  it('validateDraft rejects uncompilable patterns and empty enums', () => {
    const registry = new FileRegistry(path.join(dir, '.aa', 'registry'))
    const badPattern = {
      id: 'b',
      name: 'B',
      inputs: [{ name: 'x', type: 'string', pattern: '(' }],
      outputs: [],
      execution: { type: 'node', code: 'return {}' },
    }
    expect(validateDraft(badPattern, registry).errors.join(' ')).toMatch(/invalid regex/)
    const emptyEnum = {
      id: 'e',
      name: 'E',
      inputs: [{ name: 'x', type: 'string', enum: [] }],
      outputs: [],
      execution: { type: 'node', code: 'return {}' },
    }
    expect(validateDraft(emptyEnum, registry).errors.join(' ')).toMatch(/must not be empty/)
  })

  it('the approval summary shows constraints — the user sees the safe interface', () => {
    const text = renderDefinition(kubectlish)
    expect(text).toContain('namespace*:string ∈ {dev, staging}')
    expect(text).toContain('$ node -e')
  })
})
