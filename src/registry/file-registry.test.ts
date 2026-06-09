import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FileRegistry, compareSemver } from './file-registry'
import type { BlockDefinition } from '../core/types'

const mk = (id: string, version: string): BlockDefinition => ({
  id,
  name: id,
  version,
  inputs: [],
  outputs: [],
  execution: { type: 'node', code: 'return {};' },
})

describe('FileRegistry', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aart-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('registers and resolves the latest version numerically', () => {
    const r = new FileRegistry(dir)
    r.registerBlock(mk('a', '1.0.0'))
    r.registerBlock(mk('a', '1.0.2'))
    r.registerBlock(mk('a', '1.0.10'))
    // legacy localeCompare would wrongly pick 1.0.2 here
    expect(r.getBlock('a')!.version).toBe('1.0.10')
    expect(r.getBlock('a', '1.0.0')!.version).toBe('1.0.0')
  })

  it('lists the latest version per id', () => {
    const r = new FileRegistry(dir)
    r.registerBlock(mk('a', '1.0.0'))
    r.registerBlock(mk('a', '2.0.0'))
    r.registerBlock(mk('b', '1.0.0'))
    const ids = r.listBlocks().map((b) => `${b.id}@${b.version}`).sort()
    expect(ids).toEqual(['a@2.0.0', 'b@1.0.0'])
  })

  it('deletes all versions of a block', () => {
    const r = new FileRegistry(dir)
    r.registerBlock(mk('a', '1.0.0'))
    r.registerBlock(mk('a', '2.0.0'))
    r.deleteBlock('a')
    expect(r.getBlock('a')).toBeUndefined()
  })

  it('survives a fresh instance (filesystem-backed)', () => {
    new FileRegistry(dir).registerBlock(mk('a', '1.0.0'))
    expect(new FileRegistry(dir).getBlock('a')!.id).toBe('a')
  })
})

describe('compareSemver', () => {
  it('orders core versions numerically', () => {
    expect(compareSemver('1.0.10', '1.0.2')).toBeGreaterThan(0)
    expect(compareSemver('2.0.0', '1.9.9')).toBeGreaterThan(0)
  })
  it('ranks a release above its prerelease', () => {
    expect(compareSemver('1.0.0-rc1', '1.0.0')).toBeLessThan(0)
  })
})
