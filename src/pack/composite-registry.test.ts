import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CompositeRegistry } from './composite-registry'
import { nativeBlock } from './types'
import { FileRegistry } from '../registry/file-registry'
import type { BlockDefinition } from '../core/types'

const nb = (id: string, version = '0.1.0') =>
  nativeBlock({ id, name: id, version, inputs: [], outputs: [] }, async () => ({}))

function fileReg() {
  return new FileRegistry(fs.mkdtempSync(path.join(os.tmpdir(), 'aart-cr-')))
}

describe('CompositeRegistry', () => {
  it('resolves a native block by id and lists it', () => {
    const r = new CompositeRegistry(fileReg(), [nb('qa.x')])
    expect(r.getBlock('qa.x')!.execution.type).toBe('native')
    expect(r.listBlocks().map((b) => b.id)).toContain('qa.x')
  })

  it('honors a version pin: a non-matching version on a native id resolves to undefined', () => {
    const r = new CompositeRegistry(fileReg(), [nb('qa.x', '0.1.0')])
    expect(r.getBlock('qa.x', '0.1.0')!.version).toBe('0.1.0')
    expect(r.getBlock('qa.x', '9.9.9')).toBeUndefined()
  })

  it('refuses to overwrite or delete a native block', () => {
    const r = new CompositeRegistry(fileReg(), [nb('qa.x')])
    expect(() => r.registerBlock(nb('qa.x').def)).toThrow(/Cannot overwrite/)
    expect(() => r.deleteBlock('qa.x')).toThrow(/Cannot delete/)
  })

  it('throws on duplicate native block ids across packs', () => {
    expect(() => new CompositeRegistry(fileReg(), [nb('qa.x'), nb('qa.x')])).toThrow(/Duplicate native block id/)
  })

  const wfDef = (id: string): BlockDefinition => ({
    id, name: id, version: '0.1.0', inputs: [], outputs: [],
    execution: { type: 'workflow', steps: [] },
  })

  it('stamps pack workflows approved and reports them via isPackWorkflow', () => {
    const r = new CompositeRegistry(fileReg(), [], new Map(), [wfDef('core.health')])
    expect(r.isPackWorkflow('core.health')).toBe(true)
    expect(r.isPackWorkflow('not-a-workflow')).toBe(false)
    expect(r.getBlock('core.health')!.approval).toBe('approved')
  })

  it('getBlock returns a COPY of a pack workflow — mutating it cannot corrupt the stored built-in', () => {
    const r = new CompositeRegistry(fileReg(), [], new Map(), [wfDef('core.health')])
    const got = r.getBlock('core.health')!
    got.approval = 'deprecated' // simulate setApproval/deprecate mutating before registerBlock rejects
    expect(r.getBlock('core.health')!.approval).toBe('approved') // stored copy untouched
  })
})
