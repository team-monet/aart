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
    expect(store.list()).toEqual([
      { name: 'shot.png', path: file, mime: 'image/png', bytes: 1, kind: 'file', stepId: undefined },
    ])
  })

  it('confines path-traversal names to the store directory', () => {
    const store = new ArtifactStore(dir)
    const file = store.attach('../../escape.txt', 'data')
    // basename-reduced, so it lands inside the store, not two levels up
    expect(path.dirname(file)).toBe(path.join(dir, 'artifacts'))
    expect(fs.existsSync(path.join(dir, 'escape.txt'))).toBe(false)
  })

  // Fix #5: attaching the same name multiple times (forEach loops) must produce
  // distinct on-disk files — not silently overwrite each other.
  it('attaching the same name 3 times yields 3 distinct files, each with unique content', () => {
    const store = new ArtifactStore(dir)
    const p1 = store.attach('shot.png', Buffer.from('iter-0'))
    const p2 = store.attach('shot.png', Buffer.from('iter-1'))
    const p3 = store.attach('shot.png', Buffer.from('iter-2'))

    // All three paths must be distinct
    expect(p1).not.toBe(p2)
    expect(p2).not.toBe(p3)
    expect(p1).not.toBe(p3)

    // All three files must exist on disk
    expect(fs.existsSync(p1)).toBe(true)
    expect(fs.existsSync(p2)).toBe(true)
    expect(fs.existsSync(p3)).toBe(true)

    // Content must match what was written (not overwritten by a later call)
    expect(fs.readFileSync(p1).toString()).toBe('iter-0')
    expect(fs.readFileSync(p2).toString()).toBe('iter-1')
    expect(fs.readFileSync(p3).toString()).toBe('iter-2')

    // Metadata list must have 3 entries, each pointing at its own file
    const items = store.list()
    expect(items).toHaveLength(3)
    expect(items[0]!.path).toBe(p1)
    expect(items[1]!.path).toBe(p2)
    expect(items[2]!.path).toBe(p3)
  })

  it('first attach of a name keeps the original filename (no suffix)', () => {
    const store = new ArtifactStore(dir)
    const p = store.attach('report.md', 'hello')
    expect(path.basename(p)).toBe('report.md')
  })

  it('second attach inserts a counter before the extension (name.1.ext)', () => {
    const store = new ArtifactStore(dir)
    store.attach('report.md', 'first')
    const p2 = store.attach('report.md', 'second')
    expect(path.basename(p2)).toBe('report.1.md')
  })

  it('works for files without an extension', () => {
    const store = new ArtifactStore(dir)
    const p1 = store.attach('output', 'a')
    const p2 = store.attach('output', 'b')
    expect(path.basename(p1)).toBe('output')
    expect(path.basename(p2)).toBe('output.1')
    expect(fs.readFileSync(p1).toString()).toBe('a')
    expect(fs.readFileSync(p2).toString()).toBe('b')
  })

  // Fix 1: collision-proof against ALL previously written names, not just
  // same-key repeats.  Attaching `report.md`, `report.md`, then a literal
  // `report.1.md` must yield THREE distinct files — the literal name cannot
  // silently land on the path the auto-suffix already produced.
  it('literal report.1.md after two report.md attaches yields 3 distinct files (no silent overwrite)', () => {
    const store = new ArtifactStore(dir)
    const p1 = store.attach('report.md', 'first')          // → report.md
    const p2 = store.attach('report.md', 'second')         // → report.1.md (auto-suffix)
    const p3 = store.attach('report.1.md', 'third')        // → must NOT land on report.1.md again

    // All three paths must be distinct
    expect(p1).not.toBe(p2)
    expect(p2).not.toBe(p3)
    expect(p1).not.toBe(p3)

    // All three files must exist on disk
    expect(fs.existsSync(p1)).toBe(true)
    expect(fs.existsSync(p2)).toBe(true)
    expect(fs.existsSync(p3)).toBe(true)

    // Content must match what was written (not overwritten)
    expect(fs.readFileSync(p1).toString()).toBe('first')
    expect(fs.readFileSync(p2).toString()).toBe('second')
    expect(fs.readFileSync(p3).toString()).toBe('third')

    // Metadata list must have 3 entries, each pointing at its own file
    const items = store.list()
    expect(items).toHaveLength(3)
    const paths = items.map((i) => i.path)
    expect(new Set(paths).size).toBe(3)
  })
})
