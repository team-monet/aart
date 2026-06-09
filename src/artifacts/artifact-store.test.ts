import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ArtifactStore } from './artifact-store'

describe('ArtifactStore', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aart-art-'))
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('writes an artifact inside the store and tracks it', () => {
    const store = new ArtifactStore(dir)
    const file = store.attach('shot.png', Buffer.from('x'))
    expect(fs.existsSync(file)).toBe(true)
    expect(file.startsWith(path.join(dir, 'artifacts'))).toBe(true)
    expect(store.list()).toEqual([file])
  })

  it('confines path-traversal names to the store directory', () => {
    const store = new ArtifactStore(dir)
    const file = store.attach('../../escape.txt', 'data')
    // basename-reduced, so it lands inside the store, not two levels up
    expect(path.dirname(file)).toBe(path.join(dir, 'artifacts'))
    expect(fs.existsSync(path.join(dir, 'escape.txt'))).toBe(false)
  })
})
