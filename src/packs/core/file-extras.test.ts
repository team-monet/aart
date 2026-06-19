/**
 * Unit tests for file-extras blocks:
 *   file.exists, dir.list, file.append
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createContext } from '../../core/context'
import { ArtifactStore } from '../../artifacts/artifact-store'
import { fileExists, dirList, fileAppend } from './file-extras'
import type { ExecutionContext } from '../../core/context'

let dir: string
let ctx: ExecutionContext

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aart-file-extras-'))
  ctx = createContext({ workspace: dir, artifacts: new ArtifactStore(path.join(dir, 'run')) })
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

// ---------------------------------------------------------------------------
// file.exists
// ---------------------------------------------------------------------------

describe('file.exists', () => {
  it('returns exists:false for a missing path — does NOT throw', async () => {
    const out = await fileExists.run(ctx, { path: 'nonexistent.txt' })
    expect(out.exists).toBe(false)
    expect(out.isFile).toBe(false)
    expect(out.isDir).toBe(false)
  })

  it('returns exists:true, isFile:true for an existing file', async () => {
    fs.writeFileSync(path.join(dir, 'hello.txt'), 'hi')
    const out = await fileExists.run(ctx, { path: 'hello.txt' })
    expect(out.exists).toBe(true)
    expect(out.isFile).toBe(true)
    expect(out.isDir).toBe(false)
  })

  it('returns exists:true, isDir:true for an existing directory', async () => {
    fs.mkdirSync(path.join(dir, 'subdir'))
    const out = await fileExists.run(ctx, { path: 'subdir' })
    expect(out.exists).toBe(true)
    expect(out.isFile).toBe(false)
    expect(out.isDir).toBe(true)
  })

  it('rejects workspace escapes', async () => {
    await expect(fileExists.run(ctx, { path: '../outside.txt' })).rejects.toThrow(/escapes the workspace/)
  })

  it('rejects .aa paths', async () => {
    await expect(fileExists.run(ctx, { path: '.aa/secrets.json' })).rejects.toThrow(/not allowed/)
  })
})

// ---------------------------------------------------------------------------
// dir.list
// ---------------------------------------------------------------------------

describe('dir.list', () => {
  beforeEach(() => {
    // Set up a small directory tree
    fs.writeFileSync(path.join(dir, 'alpha.json'), '{}')
    fs.writeFileSync(path.join(dir, 'beta.json'), '{}')
    fs.writeFileSync(path.join(dir, 'gamma.txt'), 'text')
    fs.mkdirSync(path.join(dir, 'subdir'))
  })

  it('lists all entries in a directory (no glob)', async () => {
    const out = await dirList.run(ctx, { path: '.' })
    const entries = out.entries as string[]
    expect(entries).toContain('alpha.json')
    expect(entries).toContain('beta.json')
    expect(entries).toContain('gamma.txt')
    expect(entries).toContain('subdir')
  })

  it('filters entries by glob (*.json)', async () => {
    const out = await dirList.run(ctx, { path: '.', glob: '*.json' })
    const entries = out.entries as string[]
    expect(entries).toContain('alpha.json')
    expect(entries).toContain('beta.json')
    expect(entries).not.toContain('gamma.txt')
    expect(entries).not.toContain('subdir')
  })

  it('returns empty array when glob matches nothing', async () => {
    const out = await dirList.run(ctx, { path: '.', glob: '*.csv' })
    expect(out.entries).toEqual([])
  })

  it('defaults path to "." (workspace root)', async () => {
    const out = await dirList.run(ctx, {})
    const entries = out.entries as string[]
    expect(entries.length).toBeGreaterThan(0)
  })

  it('throws on a non-existent directory', async () => {
    await expect(dirList.run(ctx, { path: 'no-such-dir' })).rejects.toThrow(/cannot read directory/)
  })

  it('rejects workspace escapes', async () => {
    await expect(dirList.run(ctx, { path: '../..' })).rejects.toThrow(/escapes the workspace/)
  })
})

// ---------------------------------------------------------------------------
// file.append
// ---------------------------------------------------------------------------

describe('file.append', () => {
  it('creates a file and appends content', async () => {
    await fileAppend.run(ctx, { path: 'log.txt', content: 'line1\n' })
    const text = fs.readFileSync(path.join(dir, 'log.txt'), 'utf8')
    expect(text).toBe('line1\n')
  })

  it('appends to an existing file without overwriting', async () => {
    await fileAppend.run(ctx, { path: 'log.txt', content: 'first\n' })
    await fileAppend.run(ctx, { path: 'log.txt', content: 'second\n' })
    const text = fs.readFileSync(path.join(dir, 'log.txt'), 'utf8')
    expect(text).toBe('first\nsecond\n')
  })

  it('creates parent directories as needed', async () => {
    await fileAppend.run(ctx, { path: 'deep/nested/dir/log.txt', content: 'data\n' })
    const text = fs.readFileSync(path.join(dir, 'deep', 'nested', 'dir', 'log.txt'), 'utf8')
    expect(text).toBe('data\n')
  })

  it('returns the workspace-relative path', async () => {
    const out = await fileAppend.run(ctx, { path: 'out/notes.txt', content: 'hi' })
    // path.relative will use OS separator — normalize
    expect(String(out.path).replace(/\\/g, '/')).toBe('out/notes.txt')
  })

  it('rejects workspace escapes', async () => {
    await expect(
      fileAppend.run(ctx, { path: '../outside.txt', content: 'x' })
    ).rejects.toThrow(/escapes the workspace/)
  })

  it('rejects .aa paths', async () => {
    await expect(
      fileAppend.run(ctx, { path: '.aa/injected.json', content: '{}' })
    ).rejects.toThrow(/not allowed/)
  })
})
