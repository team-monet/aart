import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FileRegistry } from '../registry/file-registry'
import { CompositeRegistry } from '../pack/composite-registry'
import { nativeBlock } from '../pack/types'
import { isApproved, statusLabel, unapprovedInTree, approvalEnforced } from './approval'
import type { BlockDefinition } from './types'

const node = (id: string, approval?: 'draft' | 'approved' | 'deprecated'): BlockDefinition => ({
  id,
  name: id,
  version: '0.1.0',
  inputs: [],
  outputs: [],
  execution: { type: 'node', code: 'return {};' },
  approval,
})

const wf = (
  id: string,
  block: string,
  approval?: 'draft' | 'approved' | 'deprecated',
): BlockDefinition => ({
  id,
  name: id,
  version: '0.1.0',
  inputs: [],
  outputs: [],
  execution: { type: 'workflow', steps: [{ id: 's', block, inputs: {} }] },
  approval,
})

const native = nativeBlock({ id: 'qa.x', name: 'qa.x', version: '0.1.0', inputs: [], outputs: [] }, async () => ({}))

describe('isApproved / statusLabel', () => {
  it('native blocks are always approved/trusted', () => {
    expect(isApproved(native.def)).toBe(true)
    expect(statusLabel(native.def)).toBe('native')
  })
  it('only approval==="approved" counts for user blocks', () => {
    expect(isApproved(node('a', 'approved'))).toBe(true)
    expect(isApproved(node('a', 'draft'))).toBe(false)
    expect(isApproved(node('a', 'deprecated'))).toBe(false)
    expect(isApproved(node('a'))).toBe(false)
    expect(statusLabel(node('a'))).toBe('draft')
  })
})

describe('approvalEnforced', () => {
  const original = process.env.AART_REQUIRE_APPROVAL
  afterEach(() => {
    if (original === undefined) {
      delete process.env.AART_REQUIRE_APPROVAL
    } else {
      process.env.AART_REQUIRE_APPROVAL = original
    }
  })

  it('is off by default (env var unset)', () => {
    delete process.env.AART_REQUIRE_APPROVAL
    expect(approvalEnforced()).toBe(false)
  })

  it('is off when set to any value other than "1"', () => {
    process.env.AART_REQUIRE_APPROVAL = '0'
    expect(approvalEnforced()).toBe(false)
    process.env.AART_REQUIRE_APPROVAL = 'true'
    expect(approvalEnforced()).toBe(false)
    process.env.AART_REQUIRE_APPROVAL = ''
    expect(approvalEnforced()).toBe(false)
  })

  it('is on when AART_REQUIRE_APPROVAL=1', () => {
    process.env.AART_REQUIRE_APPROVAL = '1'
    expect(approvalEnforced()).toBe(true)
  })
})

describe('unapprovedInTree', () => {
  function reg(blocks: BlockDefinition[]) {
    const file = new FileRegistry(fs.mkdtempSync(path.join(os.tmpdir(), 'aart-appr-')))
    for (const b of blocks) file.registerBlock(b)
    return new CompositeRegistry(file, [native])
  }

  it('an approved workflow over a native block is fully approved', () => {
    const w = wf('w', 'qa.x', 'approved')
    expect(unapprovedInTree(w, reg([w]), true)).toEqual([])
  })

  it('flags a draft referenced user block', () => {
    const leaf = node('leaf') // draft
    const w = wf('w', 'leaf', 'approved')
    expect(unapprovedInTree(w, reg([w, leaf]), true)).toEqual(['leaf'])
  })

  it('flags the top itself when its own approval is draft', () => {
    const w = wf('w', 'qa.x', 'draft')
    expect(unapprovedInTree(w, reg([w]), true)).toEqual(['w'])
  })

  it('does not trust the top def status when trustTop=false (ad-hoc file run)', () => {
    const w = wf('w', 'qa.x', 'approved') // claims approved, but from a file
    expect(unapprovedInTree(w, reg([w]), false)).toEqual(['w'])
  })
})
