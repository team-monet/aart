import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FileRegistry } from '../registry/file-registry'
import { validateDraft } from './validate'
import type { BlockDefinition } from '../core/types'

const node = (id: string): BlockDefinition => ({
  id,
  name: id,
  version: '0.1.0',
  inputs: [],
  outputs: [],
  execution: { type: 'node', code: 'return {};' },
})

const wf = (id: string, block: string, version?: string): unknown => ({
  id,
  name: id,
  version: '0.1.0',
  execution: { type: 'workflow', steps: [{ id: 's1', block, version, inputs: {} }] },
})

describe('validateDraft', () => {
  let dir: string
  let registry: FileRegistry
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aart-val-'))
    registry = new FileRegistry(path.join(dir, 'registry'))
    registry.registerBlock(node('echo'))
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('accepts a valid node block', () => {
    expect(validateDraft(node('thing'), registry).ok).toBe(true)
  })

  it('accepts a workflow referencing a known block', () => {
    expect(validateDraft(wf('w', 'echo'), registry).ok).toBe(true)
  })

  it('rejects a workflow referencing an unknown block', () => {
    const r = validateDraft(wf('w', 'ghost'), registry)
    expect(r.ok).toBe(false)
    expect(r.errors.join()).toMatch(/unknown block: ghost/)
  })

  it('rejects a self-referencing (non-terminating) workflow', () => {
    const r = validateDraft(wf('loop', 'loop'), registry)
    expect(r.ok).toBe(false)
    expect(r.errors.join()).toMatch(/references itself/)
  })

  it('rejects a step pinned to a nonexistent version of a known block', () => {
    const r = validateDraft(wf('w', 'echo', '9.9.9'), registry)
    expect(r.ok).toBe(false)
    expect(r.errors.join()).toMatch(/unknown block: echo@9\.9\.9/)
  })

  it('rejects structurally invalid input', () => {
    expect(validateDraft({ id: 'x' }, registry).ok).toBe(false)
  })
})
