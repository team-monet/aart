import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FileRegistry } from '../registry/file-registry'
import { CompositeRegistry } from '../pack/composite-registry'
import { nativeBlock } from '../pack/types'
import { setApproval } from './governance'
import type { BlockDefinition } from './types'

const node = (id: string): BlockDefinition => ({
  id,
  name: id,
  version: '0.1.0',
  inputs: [],
  outputs: [],
  execution: { type: 'node', code: 'return {};' },
  approval: 'draft',
})

const wf = (id: string, block: string): BlockDefinition => ({
  id,
  name: id,
  version: '0.1.0',
  inputs: [],
  outputs: [],
  execution: { type: 'workflow', steps: [{ id: 's', block, inputs: {} }] },
  approval: 'draft',
})

const native = nativeBlock({ id: 'qa.x', name: 'qa.x', version: '0.1.0', inputs: [], outputs: [] }, async () => ({}))

describe('setApproval', () => {
  let dir: string
  let registry: CompositeRegistry
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aart-gov-'))
    registry = new CompositeRegistry(new FileRegistry(path.join(dir, 'reg')), [native])
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('approves a registered block and persists it', () => {
    registry.registerBlock(node('a'))
    const r = setApproval(registry, 'a', 'approved')
    expect(r.ok).toBe(true)
    expect(registry.getBlock('a')!.approval).toBe('approved')
  })

  it('reports unapproved referenced blocks when approving a workflow', () => {
    registry.registerBlock(node('leaf')) // draft
    registry.registerBlock(wf('w', 'leaf'))
    const r = setApproval(registry, 'w', 'approved')
    expect(r.ok).toBe(true)
    expect(r.pending).toEqual(['leaf'])
  })

  it('refuses to approve a native (built-in) block', () => {
    const r = setApproval(registry, 'qa.x', 'approved')
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/built-in/)
  })

  it('errors on an unknown id', () => {
    const r = setApproval(registry, 'nope', 'approved')
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/not found/)
  })

  it('can deprecate', () => {
    registry.registerBlock(node('a'))
    setApproval(registry, 'a', 'approved')
    setApproval(registry, 'a', 'deprecated')
    expect(registry.getBlock('a')!.approval).toBe('deprecated')
  })
})
