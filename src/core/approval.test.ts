import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FileRegistry } from '../registry/file-registry'
import { CompositeRegistry } from '../pack/composite-registry'
import { nativeBlock } from '../pack/types'
import { isApproved, statusLabel, unapprovedInTree, deprecatedInTree, approvalEnforced } from './approval'
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

describe('deprecatedInTree', () => {
  function reg(blocks: BlockDefinition[]) {
    const file = new FileRegistry(fs.mkdtempSync(path.join(os.tmpdir(), 'aart-depr-')))
    for (const b of blocks) file.registerBlock(b)
    return new CompositeRegistry(file, [native])
  }

  it('flags a deprecated top-level block (trustTop=true)', () => {
    const d = node('depr', 'deprecated')
    expect(deprecatedInTree(d, reg([d]), true)).toEqual(['depr'])
  })

  it('does NOT flag an approved block', () => {
    const a = node('appr', 'approved')
    expect(deprecatedInTree(a, reg([a]), true)).toEqual([])
  })

  it('does NOT flag a draft block', () => {
    const dr = node('dr', 'draft')
    expect(deprecatedInTree(dr, reg([dr]), true)).toEqual([])
  })

  it('does NOT flag a native block', () => {
    expect(deprecatedInTree(native.def, reg([]), true)).toEqual([])
  })

  it('flags a deprecated block referenced inside a workflow tree (trusted registry)', () => {
    const leaf = node('leaf.depr', 'deprecated')
    const w = wf('w', 'leaf.depr', 'approved')
    expect(deprecatedInTree(w, reg([w, leaf]), true)).toEqual(['leaf.depr'])
  })

  it('does NOT flag when trustTop=false (ad-hoc file run, top status not trusted)', () => {
    const d = node('depr.top', 'deprecated')
    // trustTop=false: the top-level def's own approval field is not trusted.
    expect(deprecatedInTree(d, reg([d]), false)).toEqual([])
  })

  it('flags a deprecated block in workflow tree even when trustTop=false (children always trusted)', () => {
    const leaf = node('leaf.depr2', 'deprecated')
    const w = wf('w2', 'leaf.depr2', 'approved')
    // trustTop=false only affects the top; referenced registry blocks are trusted.
    expect(deprecatedInTree(w, reg([w, leaf]), false)).toEqual(['leaf.depr2'])
  })

  it('does NOT hide a deprecated leaf@2.0.0 behind an already-visited approved leaf@1.0.0', () => {
    // Two versions of the same block id: v1 approved, v2 deprecated.
    // id-only dedup would skip v2 because v1 was already seen — fix keys on id@version.
    const leaf1: BlockDefinition = {
      id: 'dedup.depr.leaf',
      name: 'dedup.depr.leaf',
      version: '1.0.0',
      inputs: [],
      outputs: [],
      execution: { type: 'node', code: 'return {};' },
      approval: 'approved',
    }
    const leaf2: BlockDefinition = {
      id: 'dedup.depr.leaf',
      name: 'dedup.depr.leaf',
      version: '2.0.0',
      inputs: [],
      outputs: [],
      execution: { type: 'node', code: 'return {};' },
      approval: 'deprecated',
    }
    const w: BlockDefinition = {
      id: 'dedup.depr.wf',
      name: 'dedup.depr.wf',
      version: '0.1.0',
      inputs: [],
      outputs: [],
      execution: {
        type: 'workflow',
        steps: [
          { id: 's1', block: 'dedup.depr.leaf', version: '1.0.0', inputs: {} },
          { id: 's2', block: 'dedup.depr.leaf', version: '2.0.0', inputs: {} },
        ],
      },
      approval: 'approved',
    }
    const result = deprecatedInTree(w, reg([w, leaf1, leaf2]), true)
    expect(result).toContain('dedup.depr.leaf')
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

  it('does NOT hide a draft leaf@2.0.0 behind an already-visited approved leaf@1.0.0', () => {
    // Two versions of the same block id: v1 approved, v2 draft.
    // A workflow that references both must NOT silently skip v2 due to id-only dedup.
    const leaf1: BlockDefinition = {
      id: 'dedup.leaf',
      name: 'dedup.leaf',
      version: '1.0.0',
      inputs: [],
      outputs: [],
      execution: { type: 'node', code: 'return {};' },
      approval: 'approved',
    }
    const leaf2: BlockDefinition = {
      id: 'dedup.leaf',
      name: 'dedup.leaf',
      version: '2.0.0',
      inputs: [],
      outputs: [],
      execution: { type: 'node', code: 'return {};' },
      approval: 'draft', // NOT approved
    }
    // Workflow pinning both versions in separate steps.
    const w: BlockDefinition = {
      id: 'dedup.wf',
      name: 'dedup.wf',
      version: '0.1.0',
      inputs: [],
      outputs: [],
      execution: {
        type: 'workflow',
        steps: [
          { id: 's1', block: 'dedup.leaf', version: '1.0.0', inputs: {} },
          { id: 's2', block: 'dedup.leaf', version: '2.0.0', inputs: {} },
        ],
      },
      approval: 'approved',
    }
    const result = unapprovedInTree(w, reg([w, leaf1, leaf2]), true)
    expect(result).toContain('dedup.leaf')
  })
})
