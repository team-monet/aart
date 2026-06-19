import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Runtime, collectCapabilities } from './runtime'
import { FileRegistry } from '../registry/file-registry'
import { nativeBlock, type Pack } from '../pack/types'
import type { BlockDefinition } from './types'

// A fake pack with one capability and one native block that reads it.
function fakePack(events: string[]): Pack {
  return {
    name: 'fake',
    capabilities: [
      {
        name: 'thing',
        async setup() {
          events.push('setup')
          return { value: 42 }
        },
        async teardown() {
          events.push('teardown')
        },
      },
    ],
    blocks: [
      nativeBlock(
        {
          id: 'fake.read',
          name: 'Read Thing',
          version: '0.1.0',
          capabilities: ['thing'],
          inputs: [],
          outputs: [{ name: 'v', type: 'number' }],
        },
        async (ctx) => {
          events.push('run')
          return { v: (ctx.capabilities.thing as { value: number }).value }
        },
      ),
    ],
  }
}

describe('Runtime capability lifecycle', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aart-rt-'))
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('sets up, injects, and tears down a capability around a native block', async () => {
    const events: string[] = []
    const wf: BlockDefinition = {
      id: 'use-thing',
      name: 'Use Thing',
      version: '0.1.0',
      inputs: [],
      outputs: [],
      execution: { type: 'workflow', steps: [{ id: 's', block: 'fake.read', inputs: {} }] },
    }
    const record = await new Runtime(dir, [fakePack(events)]).run(wf, {})
    expect(record.status).toBe('COMPLETED')
    expect(record.results).toEqual({ v: 42 })
    expect(events).toEqual(['setup', 'run', 'teardown'])
  })

  it('records the approved flag on the run record', async () => {
    const nodeWf: BlockDefinition = {
      id: 'plain',
      name: 'plain',
      version: '0.1.0',
      inputs: [],
      outputs: [],
      execution: { type: 'node', code: 'return { ok: true };' },
    }
    const approved = await new Runtime(dir, []).run(nodeWf, {}, undefined, { approved: true })
    expect(approved.approved).toBe(true)
    const unapproved = await new Runtime(dir, []).run(nodeWf, {}, undefined, { approved: false })
    expect(unapproved.approved).toBe(false)
  })

  it('does NOT set up a capability a workflow does not need', async () => {
    const events: string[] = []
    const wf: BlockDefinition = {
      id: 'no-cap',
      name: 'No Cap',
      version: '0.1.0',
      inputs: [],
      outputs: [],
      execution: { type: 'node', code: 'return { ok: true };' },
    }
    const record = await new Runtime(dir, [fakePack(events)]).run(wf, {})
    expect(record.status).toBe('COMPLETED')
    expect(events).toEqual([])
  })

  it('produces a FAILED record (not a throw) when capability setup fails', async () => {
    const pack: Pack = {
      name: 'broken',
      capabilities: [
        { name: 'thing', async setup() { throw new Error('no binary') }, async teardown() {} },
      ],
      blocks: [
        nativeBlock(
          { id: 'fake.read', name: 'r', version: '0.1.0', capabilities: ['thing'], inputs: [], outputs: [] },
          async () => ({}),
        ),
      ],
    }
    const wf: BlockDefinition = {
      id: 'needs', name: 'needs', version: '0.1.0', inputs: [], outputs: [],
      execution: { type: 'workflow', steps: [{ id: 's', block: 'fake.read', inputs: {} }] },
    }
    const record = await new Runtime(dir, [pack]).run(wf, {})
    expect(record.status).toBe('FAILED')
    expect(record.error).toMatch(/capability setup failed: no binary/)
  })

  it('addPack rejects a workspace block that shadows a built-in pack workflow', () => {
    const corePack: Pack = {
      name: 'core',
      capabilities: [],
      blocks: [],
      workflows: [
        {
          id: 'http.health-check', name: 'Health Check', version: '0.1.0',
          inputs: [], outputs: [], execution: { type: 'workflow', steps: [] },
        },
      ],
    }
    const rt = new Runtime(dir, [corePack])
    const evil: Pack = {
      name: 'evil',
      capabilities: [],
      blocks: [
        nativeBlock(
          { id: 'http.health-check', name: 'evil', version: '0.1.0', inputs: [], outputs: [] },
          async () => ({}),
        ),
      ],
    }
    // Without reserving pack-workflow ids in addPack, this native block would be
    // accepted and silently shadow the built-in workflow until restart.
    expect(() => rt.addPack(evil)).toThrow(/built-in block or workflow/)
  })
})

describe('collectCapabilities', () => {
  it('gathers capabilities transitively across referenced blocks', () => {
    const registry = new FileRegistry(path.join(os.tmpdir(), 'x'))
    const leaf: BlockDefinition = {
      id: 'leaf', name: 'leaf', version: '0.1.0', capabilities: ['browser'], inputs: [], outputs: [],
      execution: { type: 'node', code: 'return {};' },
    }
    registry.registerBlock(leaf)
    const wf: BlockDefinition = {
      id: 'wf', name: 'wf', version: '0.1.0', capabilities: ['http'], inputs: [], outputs: [],
      execution: { type: 'workflow', steps: [{ id: 's', block: 'leaf', inputs: {} }] },
    }
    expect([...collectCapabilities(wf, registry)].sort()).toEqual(['browser', 'http'])
  })
})
