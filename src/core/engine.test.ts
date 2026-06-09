import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Engine } from './engine'
import { createContext } from './context'
import { ArtifactStore } from '../artifacts/artifact-store'
import { runDir } from './report'
import { FileRegistry } from '../registry/file-registry'
import type { BlockDefinition } from './types'

const echo: BlockDefinition = {
  id: 'echo',
  name: 'Echo',
  version: '0.1.0',
  inputs: [{ name: 'value', type: 'string' }],
  outputs: [{ name: 'value', type: 'string' }],
  execution: { type: 'node', code: 'return { value: inputs.value };' },
}

const upper: BlockDefinition = {
  id: 'upper',
  name: 'Uppercase',
  version: '0.1.0',
  inputs: [{ name: 'value', type: 'string' }],
  outputs: [{ name: 'value', type: 'string' }],
  execution: { type: 'node', code: 'return { value: String(inputs.value).toUpperCase() };' },
}

const workflow: BlockDefinition = {
  id: 'echo-smoke',
  name: 'Echo Smoke',
  version: '0.1.0',
  inputs: [{ name: 'start', type: 'string' }],
  outputs: [],
  execution: {
    type: 'workflow',
    steps: [
      { id: 'echo_it', block: 'echo', inputs: { value: '{{inputs.start}}' } },
      { id: 'shout', block: 'upper', inputs: { value: '$echo_it.value' } },
    ],
    outputMapping: { final: '$shout.value' },
  },
}

describe('Engine', () => {
  let dir: string
  let registry: FileRegistry

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aart-engine-'))
    registry = new FileRegistry(path.join(dir, 'registry'))
    registry.registerBlock(echo)
    registry.registerBlock(upper)
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const run = (wf: BlockDefinition, inputs: Record<string, unknown>) => {
    const runId = 'test-run'
    const ctx = createContext({
      runId,
      workspace: dir,
      artifacts: new ArtifactStore(runDir(dir, runId)),
    })
    return new Engine(registry).run(wf, inputs, ctx)
  }

  it('runs a two-step workflow end to end', async () => {
    const rec = await run(workflow, { start: 'hello' })
    expect(rec.status).toBe('COMPLETED')
    expect(rec.results).toEqual({ final: 'HELLO' })
    expect(rec.trace.map((t) => [t.stepId, t.status])).toEqual([
      ['echo_it', 'COMPLETED'],
      ['shout', 'COMPLETED'],
    ])
  })

  it('snapshots every referenced block for reproducibility', async () => {
    const rec = await run(workflow, { start: 'x' })
    expect(Object.keys(rec.snapshot.blocks).sort()).toEqual(['echo', 'upper'])
  })

  it('resolves {{ctx.runId}} in step inputs and outputMapping', async () => {
    const wf: BlockDefinition = {
      ...workflow,
      id: 'ctx-wf',
      execution: {
        type: 'workflow',
        steps: [{ id: 'e', block: 'echo', inputs: { value: '{{ctx.runId}}' } }],
        outputMapping: { rid: '{{ctx.runId}}' },
      },
    }
    const rec = await run(wf, {})
    expect(rec.status).toBe('COMPLETED')
    expect(rec.results).toEqual({ rid: 'test-run' })
    expect(rec.trace[0]!.outputs).toEqual({ value: 'test-run' })
  })

  it('fails fast when a required input is missing', async () => {
    const needsInput: BlockDefinition = {
      id: 'needs-input',
      name: 'Needs Input',
      version: '0.1.0',
      inputs: [{ name: 'value', type: 'string', required: true }],
      outputs: [],
      execution: { type: 'node', code: 'return { value: inputs.value };' },
    }
    registry.registerBlock(needsInput)
    const wf: BlockDefinition = {
      ...workflow,
      id: 'missing-input-wf',
      execution: { type: 'workflow', steps: [{ id: 's', block: 'needs-input', inputs: {} }] },
    }
    const rec = await run(wf, {})
    expect(rec.status).toBe('FAILED')
    expect(rec.error).toMatch(/Missing required input "value"/)
  })

  it('marks the run FAILED and records the failing step on error', async () => {
    const boom: BlockDefinition = {
      ...upper,
      id: 'boom',
      execution: { type: 'node', code: 'throw new Error("kaboom");' },
    }
    registry.registerBlock(boom)
    const wf: BlockDefinition = {
      ...workflow,
      id: 'fail-wf',
      execution: {
        type: 'workflow',
        steps: [{ id: 'bang', block: 'boom', inputs: {} }],
      },
    }
    const rec = await run(wf, {})
    expect(rec.status).toBe('FAILED')
    expect(rec.error).toMatch(/kaboom/)
    expect(rec.trace[0]!.status).toBe('FAILED')
  })
})
