/**
 * Tests for the pack-workflow delivery mechanism.
 *
 * Verifies that:
 *   - pack workflows are stamped `approval: 'approved'` at load time
 *   - they appear in the registry catalog (listBlocks / buildCatalog)
 *   - getBlock resolves them by id
 *   - the approval gate (unapprovedInTree) passes without --yes
 *   - the Runtime engine executes them end-to-end
 *   - native-block id collision is rejected at load time
 *   - file-registry blocks with the same id as a pack workflow are shadowed
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CompositeRegistry } from './composite-registry'
import { nativeBlock } from './types'
import { FileRegistry } from '../registry/file-registry'
import { unapprovedInTree } from '../core/approval'
import { buildCatalog } from '../agent/catalog'
import { Runtime } from '../core/runtime'
import type { BlockDefinition } from '../core/types'
import type { Pack } from './types'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const nb = (id: string, version = '0.1.0') =>
  nativeBlock({ id, name: id, version, inputs: [], outputs: [] }, async () => ({ done: true }))

function fileReg() {
  return new FileRegistry(fs.mkdtempSync(path.join(os.tmpdir(), 'aart-pw-')))
}

/** Minimal workflow that calls a single block (e.g. a native block). */
function wfDef(id: string, callsBlock: string): BlockDefinition {
  return {
    id,
    name: `Pack workflow: ${id}`,
    version: '0.1.0',
    description: 'A test-fixture pack workflow',
    inputs: [],
    outputs: [{ name: 'result', type: 'any' }],
    execution: {
      type: 'workflow',
      steps: [{ id: 'step1', block: callsBlock, inputs: {} }],
      outputMapping: { result: '$step1' },
    },
    // Intentionally omit `approval` — the registry stamps it.
  }
}

// ---------------------------------------------------------------------------
// CompositeRegistry — pack workflow unit tests
// ---------------------------------------------------------------------------

describe('CompositeRegistry — pack workflows', () => {
  it('stamps approval=approved on a pack workflow at load time', () => {
    const wf = wfDef('test.workflow.hello', 'qa.x')
    const r = new CompositeRegistry(fileReg(), [nb('qa.x')], new Map(), [wf])
    const resolved = r.getBlock('test.workflow.hello')
    expect(resolved).toBeDefined()
    expect(resolved!.approval).toBe('approved')
    expect(resolved!.execution.type).toBe('workflow')
  })

  it('stamps approved even when the author wrote approval=draft', () => {
    const wf: BlockDefinition = { ...wfDef('test.workflow.draft', 'qa.x'), approval: 'draft' }
    const r = new CompositeRegistry(fileReg(), [nb('qa.x')], new Map(), [wf])
    expect(r.getBlock('test.workflow.draft')!.approval).toBe('approved')
  })

  it('appears in listBlocks() and buildCatalog() with type=workflow and status=approved', () => {
    const wf = wfDef('test.workflow.catalog', 'qa.x')
    const r = new CompositeRegistry(fileReg(), [nb('qa.x')], new Map(), [wf])
    const ids = r.listBlocks().map((b) => b.id)
    expect(ids).toContain('test.workflow.catalog')
    const entry = buildCatalog(r).find((e) => e.id === 'test.workflow.catalog')
    expect(entry).toBeDefined()
    expect(entry!.type).toBe('workflow')
    expect(entry!.status).toBe('approved')
  })

  it('getBlock version-pin: matching version resolves, non-matching falls through to file registry', () => {
    const wf = wfDef('test.workflow.vpin', 'qa.x')
    const r = new CompositeRegistry(fileReg(), [nb('qa.x')], new Map(), [wf])
    expect(r.getBlock('test.workflow.vpin', '0.1.0')!.id).toBe('test.workflow.vpin')
    expect(r.getBlock('test.workflow.vpin', '9.9.9')).toBeUndefined()
  })

  it('unapprovedInTree passes for a pack workflow (both it and its native child are trusted)', () => {
    const wf = wfDef('test.workflow.gate', 'qa.x')
    const r = new CompositeRegistry(fileReg(), [nb('qa.x')], new Map(), [wf])
    const resolved = r.getBlock('test.workflow.gate')!
    expect(unapprovedInTree(resolved, r, true)).toEqual([])
  })

  it('rejects a pack workflow whose id collides with a native block id', () => {
    const wf = wfDef('qa.x', 'qa.x') // same id as the native block
    expect(
      () => new CompositeRegistry(fileReg(), [nb('qa.x')], new Map(), [wf]),
    ).toThrow(/collides with a native block id/)
  })

  it('rejects duplicate pack workflow ids', () => {
    const wf = wfDef('test.workflow.dup', 'qa.x')
    expect(
      () => new CompositeRegistry(fileReg(), [nb('qa.x')], new Map(), [wf, wf]),
    ).toThrow(/Duplicate pack workflow id/)
  })

  it('shadows a file-registry block with the same id (pack workflow wins)', () => {
    const wf = wfDef('test.workflow.shadow', 'qa.x')
    const file = fileReg()
    // Register a file block with the same id (different content)
    file.registerBlock({ ...wfDef('test.workflow.shadow', 'qa.x'), name: 'file-version', approval: 'approved' })
    const r = new CompositeRegistry(file, [nb('qa.x')], new Map(), [wf])
    // Pack workflow must win
    expect(r.getBlock('test.workflow.shadow')!.name).toBe('Pack workflow: test.workflow.shadow')
    // Listed only once
    expect(r.listBlocks().filter((b) => b.id === 'test.workflow.shadow')).toHaveLength(1)
  })

  it('registerBlock and deleteBlock are blocked for pack workflow ids', () => {
    const wf = wfDef('test.workflow.guard', 'qa.x')
    const r = new CompositeRegistry(fileReg(), [nb('qa.x')], new Map(), [wf])
    expect(() => r.registerBlock(wf)).toThrow(/Cannot overwrite built-in pack workflow/)
    expect(() => r.deleteBlock('test.workflow.guard')).toThrow(/Cannot delete built-in pack workflow/)
  })

  it('addPackWorkflows / removePackWorkflow work after construction', () => {
    const r = new CompositeRegistry(fileReg(), [nb('qa.x')])
    const wf = wfDef('test.workflow.hotload', 'qa.x')
    r.addPackWorkflows([wf])
    expect(r.getBlock('test.workflow.hotload')!.approval).toBe('approved')
    r.removePackWorkflow('test.workflow.hotload')
    expect(r.getBlock('test.workflow.hotload')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Runtime integration — end-to-end execution without --yes
// ---------------------------------------------------------------------------

describe('Runtime — pack workflow execution', () => {
  function tmpWorkspace() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'aart-rt-pw-'))
  }

  it('executes a pack workflow without requiring --yes (approval gate passes)', async () => {
    // flowSleep is too slow for a unit test; use a custom native block that
    // returns a known value, wired through a pack workflow.
    const greetBlock = nativeBlock(
      { id: 'test.greet', name: 'greet', version: '0.1.0', inputs: [], outputs: [{ name: 'msg', type: 'string' }] },
      async () => ({ msg: 'hello from pack workflow' }),
    )
    const wf = wfDef('test.workflow.greet', 'test.greet')

    const pack: Pack = {
      name: 'test-pack',
      blocks: [greetBlock],
      capabilities: [],
      workflows: [wf],
    }

    const ws = tmpWorkspace()
    try {
      const rt = new Runtime(ws, [pack])

      // Confirm the workflow is registered and stamped
      const resolved = rt.registry.getBlock('test.workflow.greet')!
      expect(resolved.approval).toBe('approved')

      // Run it — opts.approved defaults to true; the gate must not reject
      const def = rt.registry.getBlock('test.workflow.greet')!
      const record = await rt.run(def, {})
      expect(record.status).toBe('COMPLETED')
      // Step trace must include the greet step
      expect(record.trace.some((t) => t.block === 'test.greet')).toBe(true)
    } finally {
      fs.rmSync(ws, { recursive: true, force: true })
    }
  })

  it('pack workflow appears in buildCatalog via Runtime.registry', () => {
    const greetBlock = nativeBlock(
      { id: 'test.greet2', name: 'greet2', version: '0.1.0', inputs: [], outputs: [] },
      async () => ({}),
    )
    const wf = wfDef('test.workflow.greet2', 'test.greet2')
    const pack: Pack = { name: 'test-pack2', blocks: [greetBlock], capabilities: [], workflows: [wf] }
    const ws = tmpWorkspace()
    try {
      const rt = new Runtime(ws, [pack])
      const catalog = buildCatalog(rt.registry)
      const entry = catalog.find((e) => e.id === 'test.workflow.greet2')
      expect(entry).toBeDefined()
      expect(entry!.type).toBe('workflow')
      expect(entry!.status).toBe('approved')
    } finally {
      fs.rmSync(ws, { recursive: true, force: true })
    }
  })
})
