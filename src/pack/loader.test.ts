import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  approveWorkspacePack,
  loadApprovedPacks,
  loadWorkspacePack,
  mergePacks,
  readPackManifest,
  registerWorkspacePack,
} from './loader'
import { Runtime } from '../core/runtime'
import { builtinPacks } from '../packs'
import type { BlockDefinition } from '../core/types'

const PACK_SOURCE = `
module.exports = {
  name: 'tools',
  blocks: [
    {
      def: {
        id: 'tools.echo',
        name: 'Echo',
        version: '0.1.0',
        description: 'Echo a value back, stamped by the clock capability.',
        capabilities: ['clock'],
        inputs: [{ name: 'value', type: 'string', required: true }],
        outputs: [{ name: 'echo', type: 'string' }, { name: 'at', type: 'string' }],
      },
      run: async (ctx, inputs) => ({ echo: inputs.value, at: ctx.capabilities.clock }),
    },
  ],
  capabilities: [
    { name: 'clock', setup: async () => 'tick', teardown: async () => {} },
  ],
}
`

let ws: string

function writePack(name: string, source: string): string {
  const dir = path.join(ws, '.aa', 'packs', name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'index.js'), source)
  return dir
}

beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'aart-pack-'))
})
afterEach(() => fs.rmSync(ws, { recursive: true, force: true }))

describe('pack lifecycle', () => {
  it('register records a draft without executing; approve loads it', async () => {
    const dir = writePack('tools', PACK_SOURCE)
    // A pack that would prove execution by writing a sentinel file.
    fs.writeFileSync(
      path.join(dir, 'index.js'),
      `require('node:fs').writeFileSync(${JSON.stringify(path.join(dir, 'EXECUTED'))}, '1')\n` + PACK_SOURCE,
    )

    const r = registerWorkspacePack(ws, 'tools')
    expect(r.files).toContain('index.js')
    expect(fs.existsSync(path.join(dir, 'EXECUTED'))).toBe(false) // registration never ran it
    expect(readPackManifest(ws).packs.tools?.approved).toBe(false)
    expect(loadApprovedPacks(ws).packs).toHaveLength(0) // drafts don't load

    approveWorkspacePack(ws, 'tools')
    const { packs, warnings } = loadApprovedPacks(ws)
    expect(warnings).toEqual([])
    expect(packs).toHaveLength(1)
    expect(packs[0]!.blocks[0]!.def.id).toBe('tools.echo')
    expect(packs[0]!.blocks[0]!.def.execution.type).toBe('native')
    expect(fs.existsSync(path.join(dir, 'EXECUTED'))).toBe(true) // loading does run it
  })

  it('a pack block runs end-to-end with its capability', async () => {
    writePack('tools', PACK_SOURCE)
    registerWorkspacePack(ws, 'tools')
    approveWorkspacePack(ws, 'tools')
    const { packs } = loadApprovedPacks(ws)
    const wf: BlockDefinition = {
      id: 'use-echo',
      name: 'Use Echo',
      version: '0.1.0',
      inputs: [],
      outputs: [],
      execution: {
        type: 'workflow',
        steps: [{ id: 'e', block: 'tools.echo', inputs: { value: 'hello' } }],
        outputMapping: { echo: '$e.echo', at: '$e.at' },
      },
    }
    const record = await new Runtime(ws, packs).run(wf, {})
    expect(record.status).toBe('COMPLETED')
    expect(record.results).toEqual({ echo: 'hello', at: 'tick' })
  })

  it('an edit after approval breaks the seal until re-approved', () => {
    const dir = writePack('tools', PACK_SOURCE)
    registerWorkspacePack(ws, 'tools')
    approveWorkspacePack(ws, 'tools')
    fs.appendFileSync(path.join(dir, 'index.js'), '\n// tampered\n')
    const { packs, warnings } = loadApprovedPacks(ws)
    expect(packs).toHaveLength(0)
    expect(warnings.join(' ')).toMatch(/changed since it was approved/)
    approveWorkspacePack(ws, 'tools') // the user re-approves current content
    expect(loadApprovedPacks(ws).packs).toHaveLength(1)
  })

  it('re-registering resets approval to draft', () => {
    writePack('tools', PACK_SOURCE)
    registerWorkspacePack(ws, 'tools')
    approveWorkspacePack(ws, 'tools')
    registerWorkspacePack(ws, 'tools')
    expect(readPackManifest(ws).packs.tools?.approved).toBe(false)
  })

  it('rejects bad shapes with precise errors', () => {
    writePack('tools', `module.exports = { name: 'tools', blocks: [] }`)
    registerWorkspacePack(ws, 'tools')
    expect(() => loadWorkspacePack(ws, 'tools')).toThrow(/blocks must be a non-empty array/)

    writePack('tools2', `module.exports = { name: 'wrong-name', blocks: [{}] }`)
    registerWorkspacePack(ws, 'tools2')
    expect(() => loadWorkspacePack(ws, 'tools2')).toThrow(/pack.name must be "tools2"/)
  })

  it('rejects reserved and out-of-workspace names/paths', () => {
    expect(() => registerWorkspacePack(ws, 'qa')).toThrow(/reserved/)
    expect(() => registerWorkspacePack(ws, 'esc', '../outside')).toThrow(/inside the workspace/)
  })
})

describe('mergePacks + Runtime.addPack', () => {
  it('drops a workspace pack whose block id collides with a builtin', () => {
    const colliding = {
      name: 'tools',
      blocks: [
        {
          def: {
            id: 'browser.goto',
            name: 'X',
            version: '0.1.0',
            inputs: [],
            outputs: [],
            execution: { type: 'native' as const },
          },
          run: async () => ({}),
        },
      ],
      capabilities: [],
    }
    const { packs, warnings } = mergePacks(builtinPacks, [colliding])
    expect(packs).toHaveLength(builtinPacks.length)
    expect(warnings.join(' ')).toMatch(/browser\.goto/)
  })

  it('treats legacy qa.* alias ids as taken', () => {
    const shadowing = {
      name: 'tools',
      blocks: [
        {
          def: {
            id: 'qa.browser.goto',
            name: 'X',
            version: '0.1.0',
            inputs: [],
            outputs: [],
            execution: { type: 'native' as const },
          },
          run: async () => ({}),
        },
      ],
      capabilities: [],
    }
    const { packs, warnings } = mergePacks(builtinPacks, [shadowing])
    expect(packs).toHaveLength(builtinPacks.length)
    expect(warnings.join(' ')).toMatch(/qa\.browser\.goto/)
  })

  it('hot-adds a pack and replaces it on re-approval after an edit', async () => {
    writePack('tools', PACK_SOURCE)
    registerWorkspacePack(ws, 'tools')
    approveWorkspacePack(ws, 'tools')
    const runtime = new Runtime(ws, builtinPacks)
    expect(runtime.registry.getBlock('tools.echo')).toBeUndefined()

    runtime.addPack(loadWorkspacePack(ws, 'tools'))
    expect(runtime.registry.getBlock('tools.echo')?.execution.type).toBe('native')

    // Edited pack: same name, renamed block — replacement, not collision.
    writePack('tools', PACK_SOURCE.replace(/tools\.echo/g, 'tools.echo2'))
    registerWorkspacePack(ws, 'tools')
    approveWorkspacePack(ws, 'tools')
    runtime.addPack(loadWorkspacePack(ws, 'tools'))
    expect(runtime.registry.getBlock('tools.echo')).toBeUndefined()
    expect(runtime.registry.getBlock('tools.echo2')).toBeDefined()
  })
})
